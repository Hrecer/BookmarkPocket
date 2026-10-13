// 桥客户端：连接本机 WS 中枢（mcp 侧），把 Agent 调用转成与 UI 完全相同的 ops.execute。
// reconnect() 会等待握手结果（收到 welcome 或明确失败，最长 2.5s）再返回状态，避免"点击瞬间还没连完"的误报。

import { execute } from "./ops.js";
import { K } from "./keys.js";

let ws = null;
let retryDelay = 1000;
let state = { connected: false, url: null, since: null, lastError: null };
let waiters = [];

export function getState() { return { ...state }; }

async function config() {
  const o = await chrome.storage.local.get([K.port, K.token]);
  return { port: Number(o[K.port]) || 19127, token: String(o[K.token] || "") };
}

function flushWaiters(ok) {
  const list = waiters;
  waiters = [];
  for (const w of list) w(ok);
}

function waitConnected(ms) {
  if (state.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    let t = 0;
    const fn = (ok) => { clearTimeout(t); resolve(ok); };
    t = setTimeout(() => {
      waiters = waiters.filter((w) => w !== fn);
      resolve(false);
    }, ms);
    waiters.push(fn);
  });
}

export async function ensure() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  await connect();
}

export async function connect() {
  const cfg = await config();
  if (!cfg.token) {
    state = { connected: false, url: null, since: null, lastError: "未配置令牌（请在设置页填写）" };
    return;
  }
  const url = `ws://127.0.0.1:${cfg.port}/`;
  state.url = url;
  let sock;
  try { sock = new WebSocket(url); }
  catch (e) { state.lastError = String((e && e.message) || e); scheduleRetry(); return; }
  ws = sock;

  sock.onopen = () => {
    if (ws !== sock) return;
    try {
      sock.send(JSON.stringify({ type: "hello", token: cfg.token, extId: chrome.runtime.id, version: chrome.runtime.getManifest().version }));
    } catch (e) { /* ignore */ }
  };

  sock.onmessage = async (ev) => {
    if (ws !== sock) return;
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === "welcome") {
      state = { connected: true, url, since: Date.now(), lastError: null };
      retryDelay = 1000;
      flushWaiters(true);
      return;
    }
    if (m.type === "ping") {
      try { sock.send(JSON.stringify({ type: "pong" })); } catch (e) { /* ignore */ }
      return;
    }
    if (m.type === "call") {
      try {
        const data = await execute(m.op, m.args);
        sock.send(JSON.stringify({ type: "result", id: m.id, ok: true, data }));
      } catch (e) {
        try { sock.send(JSON.stringify({ type: "result", id: m.id, ok: false, error: String((e && e.message) || e) })); } catch (e2) { /* ignore */ }
      }
    }
  };

  sock.onclose = (e) => {
    if (ws !== sock) return;   // 旧连接的关闭事件不得污染新连接状态
    state.connected = false;
    const why = e && e.code ? "（code " + e.code + (e.reason ? "：" + e.reason : "") + "）" : "";
    if (!state.lastError) state.lastError = "连接已断开" + why;
    flushWaiters(false);
    scheduleRetry();
  };

  sock.onerror = () => {
    if (ws !== sock) return;
    state.lastError = "无法连接 " + url;
  };
}

// 一键配对：扩展是沙箱，读不到磁盘上的 mcp/config.json，所以由中枢开一个只绑 127.0.0.1 的
// 端点把「端口 + 令牌」直接交出来。只在用户点「一键配对」时调用——不做静默采用，
// 免得本机上随便一个服务占住这个端口就能把扩展引到别处去。
export async function pair() {
  const cfg = await config();
  const url = `http://127.0.0.1:${cfg.port + 1}/pair.json`;
  let res;
  try { res = await fetch(url, { cache: "no-store" }); }
  catch (e) { throw new Error("连不上本机中枢 " + url + "：" + ((e && e.message) || e)); }
  if (!res.ok) throw new Error("中枢没应答（HTTP " + res.status + "）");
  const data = await res.json().catch(() => null);
  if (!data || !data.token) throw new Error("中枢返回里没有令牌");
  await chrome.storage.local.set({ [K.port]: Number(data.port) || cfg.port, [K.token]: String(data.token) });
  return await reconnect();
}

export async function reconnect() {
  try { ws && ws.close(); } catch (e) { /* ignore */ }
  ws = null;
  retryDelay = 1000;
  state = { connected: false, url: state.url, since: null, lastError: null };
  flushWaiters(false);
  await ensure();
  const ok = await waitConnected(2500);
  if (!ok && !state.connected && !state.lastError) state.lastError = "连接超时：2.5 秒内未收到中枢握手";
  return getState();
}

function scheduleRetry() {
  const d = retryDelay;
  retryDelay = Math.min(retryDelay * 2, 15000);
  setTimeout(() => { ensure().catch(() => {}); }, d);
}

export function sendEvent(event, args) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !state.connected) return;
  try { ws.send(JSON.stringify({ type: "event", event, args })); } catch (e) { /* ignore */ }
}
