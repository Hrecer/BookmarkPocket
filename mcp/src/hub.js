// 中枢（Hub）：浏览器扩展 ↔ Agent 之间的本机中转。
//
// 它由 MCP 服务（server.js）内嵌运行 —— 也就是宿主拉起的那一个 node 子进程本身。
// 谁先抢到 cfg.port 谁就是 primary；抢不到的一方自动转 secondary，把调用中继给
// primary 的控制口（同一台机器上跑了第二个实例时才会走到这条路）。
//
// 中枢会把自身进程信息（PID / 内存 / CPU / 运行时长）报给扩展，管理页据此显示
// 「后台 Node 进程」；扩展也能通过 shutdown 通道要求它退出。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket as WSClient } from "ws";
import { startPairServer } from "./pair.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = process.env.BOOKMARKPOCKET_CONFIG || path.join(HERE, "..", "config.json");
export const SERVER_VERSION = "0.1.0";

export function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch (e) { /* 首次生成 */ }
  if (process.env.BOOKMARKPOCKET_PORT) cfg.port = Number(process.env.BOOKMARKPOCKET_PORT);
  if (process.env.BOOKMARKPOCKET_TOKEN) cfg.token = process.env.BOOKMARKPOCKET_TOKEN;
  if (process.env.BOOKMARKPOCKET_ORIGINS) {
    cfg.allowedOrigins = process.env.BOOKMARKPOCKET_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  cfg.port = Number(cfg.port) || 19127;
  cfg.controlPort = Number(process.env.BOOKMARKPOCKET_CONTROL_PORT) || Number(cfg.controlPort) || cfg.port + 2;
  cfg.pairPort = Number(process.env.BOOKMARKPOCKET_PAIR_PORT) || Number(cfg.pairPort) || cfg.port + 1;
  cfg.allowedOrigins = Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : [];
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString("base64url");
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    } catch (e) { /* 写不了就算了，端口/令牌仍可用环境变量给 */ }
  }
  return cfg;
}

export function startHub({ cfg, log = () => {}, onShutdown = null } = {}) {
  const startedAt = Date.now();
  const events = [];                                   // 最近若干条事件，供状态查询
  const remember = (item) => { events.push(item); if (events.length > 30) events.shift(); };

  let active = null;                                   // 当前扩展连接
  const pending = new Map();                           // id -> {resolve, reject, timer}
  let msgSeq = 0;

  let mode = "primary";                                // primary=自己监听扩展；secondary=端口被占，转中继
  const controlClients = new Set();
  let controlWss = null;
  let closing = false;

  /* ---------- 自身进程信息：扩展的管理页要看见这个后台进程 ---------- */

  let cpuMark = process.cpuUsage(), cpuMarkTs = Date.now();
  function stats() {
    const m = process.memoryUsage();
    const c = process.cpuUsage();
    const now = Date.now();
    const dt = now - cpuMarkTs;
    const duUs = (c.user - cpuMark.user) + (c.system - cpuMark.system);   // 微秒
    cpuMark = c; cpuMarkTs = now;
    return {
      pid: process.pid,
      rssMb: Math.round((m.rss / 1048576) * 10) / 10,
      cpuPct: dt > 0 ? Math.round((duUs / 1000 / dt) * 100 * 10) / 10 : 0,
      uptimeMs: now - startedAt,
    };
  }

  const heartbeat = setInterval(() => {
    if (active && active.readyState === 1) {
      try { active.send(JSON.stringify({ type: "hubStatus", ...stats() })); } catch (e) { /* ignore */ }
    }
  }, 5000);
  if (heartbeat.unref) heartbeat.unref();              // 别让心跳拖住进程退出

  const pairSrv = startPairServer(cfg, log);

  const wss = new WebSocketServer({ host: "127.0.0.1", port: cfg.port });
  wss.on("listening", () => {
    log(`中枢已监听 ws://127.0.0.1:${cfg.port}（等待浏览器扩展）`);
    startControlHub();
  });
  wss.on("error", (e) => {
    if (e && e.code === "EADDRINUSE") { becomeSecondary(); return; }
    log("中枢错误:", e.message);
  });

  function becomeSecondary() {
    if (mode === "secondary") return;
    mode = "secondary";
    try { wss.close(); } catch (e) { /* ignore */ }
    log(`端口 ${cfg.port} 已被占用：本实例转「中继模式」，调用将转发至常驻中枢（控制口 ${cfg.controlPort}）`);
  }

  wss.on("connection", (ws, req) => {
    const origin = req.headers.origin || "";
    if (cfg.allowedOrigins.length && origin && !cfg.allowedOrigins.includes(origin)) {
      log("拒绝来源:", origin);
      ws.close(4403, "origin not allowed");
      return;
    }
    if (cfg.allowedOrigins.length && !origin) log("注意：连接未带 Origin 头（凭令牌放行）");

    let authed = false;
    ws.on("message", (buf) => {
      let m;
      try { m = JSON.parse(String(buf)); } catch (e) { return; }

      if (m.type === "hello") {
        if (m.token !== cfg.token) {
          log("令牌不匹配，拒绝扩展:", m.extId);
          ws.close(4401, "bad token");
          return;
        }
        authed = true;
        if (active && active !== ws) { try { active.close(4409, "replaced"); } catch (e) { /* ignore */ } }
        active = ws;
        remember({ ts: Date.now(), kind: "connect", text: `扩展已连接 id=${m.extId} v=${m.version}` });
        log(`扩展已连接: id=${m.extId} v=${m.version}`);
        // welcome 带上本进程信息，管理页据此显示「后台 Node 进程」
        ws.send(JSON.stringify({ type: "welcome", server: "bookmarkpocket-mcp", version: SERVER_VERSION, port: cfg.port, startedAt, ...stats() }));
        return;
      }

      if (!authed) return;

      if (m.type === "result") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data);
        else p.reject(new Error(m.error || "扩展侧执行失败"));
        return;
      }
      if (m.type === "event") {
        remember({ ts: Date.now(), kind: "event", text: m.event });
        log("书签变动事件:", m.event);
        for (const cc of controlClients) {
          try { cc.send(JSON.stringify({ type: "event", event: m.event, args: m.args })); } catch (e) { /* ignore */ }
        }
        return;
      }
      if (m.type === "shutdown") {
        log("收到「关闭中枢」请求，正在停止…");
        try { ws.send(JSON.stringify({ type: "shutdown", ok: true })); } catch (e) { /* ignore */ }
        close();
        if (onShutdown) setTimeout(onShutdown, 80);
        return;
      }
      if (m.type === "pong") return;
    });

    ws.on("close", () => {
      if (active === ws) {
        active = null;
        remember({ ts: Date.now(), kind: "disconnect", text: "扩展连接断开" });
        log("扩展连接断开");
        for (const [id, p] of pending) {
          pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new Error("扩展连接断开"));
        }
      }
    });
  });

  /* ---------- Agent 控制口：本机脚本 / CLI 直连（与扩展的同一套 ops 管线） ---------- */

  function startControlHub() {
    controlWss = new WebSocketServer({ host: "127.0.0.1", port: cfg.controlPort });
    controlWss.on("listening", () => log(`Agent 控制口已监听 ws://127.0.0.1:${cfg.controlPort}（脚本/CLI 通道）`));
    controlWss.on("error", (e) => log("控制口错误:", e.message));
    controlWss.on("connection", (ws) => {
      let authed = false;
      ws.on("message", (buf) => {
        let m;
        try { m = JSON.parse(String(buf)); } catch (e) { return; }
        if (m.type === "hello") {
          if (m.token !== cfg.token) { log("控制口：令牌不匹配，拒绝"); ws.close(4401, "bad token"); return; }
          authed = true;
          controlClients.add(ws);
          ws.send(JSON.stringify({ type: "welcome", server: "bookmarkpocket-mcp", role: "control" }));
          return;
        }
        if (!authed) return;
        if (m.type === "call") {
          callExtension(m.op, m.args)
            .then((data) => ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, data })))
            .catch((e) => { try { ws.send(JSON.stringify({ type: "result", id: m.id, ok: false, error: String((e && e.message) || e) })); } catch (e2) { /* ignore */ } });
        }
      });
      ws.on("close", () => controlClients.delete(ws));
    });
  }

  /* ---------- 中继模式：本实例没抢到扩展端口时，把调用转发给常驻中枢 ---------- */

  let relay = null, relayReady = false, relayWaiters = [];
  const relayPending = new Map();
  let relaySeq = 0;

  function ensureRelay() {
    return new Promise((resolve, reject) => {
      if (relay && relayReady) return resolve(relay);
      if (relay) { relayWaiters.push({ resolve, reject }); return; }
      relay = new WSClient(`ws://127.0.0.1:${cfg.controlPort}/`);
      relay.on("open", () => { try { relay.send(JSON.stringify({ type: "hello", token: cfg.token, role: "agent" })); } catch (e) { /* ignore */ } });
      relay.on("message", (buf) => {
        let m;
        try { m = JSON.parse(String(buf)); } catch (e) { return; }
        if (m.type === "welcome") {
          relayReady = true;
          const ws = relayWaiters; relayWaiters = [];
          for (const w of ws) w.resolve(relay);
          return;
        }
        if (m.type === "result") {
          const p = relayPending.get(m.id);
          if (!p) return;
          relayPending.delete(m.id);
          clearTimeout(p.timer);
          if (m.ok) p.resolve(m.data);
          else p.reject(new Error(m.error || "中继调用失败"));
        }
      });
      relay.on("error", (e) => {
        const ws = relayWaiters; relayWaiters = [];
        for (const w of ws) w.reject(new Error("连不上常驻中枢控制口 " + cfg.controlPort + "：" + e.message));
      });
      relay.on("close", () => { relay = null; relayReady = false; });
    });
  }

  async function relayCall(op, args) {
    const r = await ensureRelay();
    const id = "r" + (++relaySeq);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { relayPending.delete(id); reject(new Error("等待常驻中枢响应超时: " + op)); }, 20000);
      relayPending.set(id, { resolve, reject, timer });
      try { r.send(JSON.stringify({ type: "call", id, op, args: args || {} })); }
      catch (e) { relayPending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  async function waitForExt(ms = 4000) {
    const t0 = Date.now();
    while (!(active && active.readyState === 1)) {
      if (Date.now() - t0 >= ms) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
    return true;
  }

  async function callExtension(op, args) {
    if (mode === "secondary") return await relayCall(op, args);
    if (!(await waitForExt())) {
      throw new Error(
        "扩展未连接：请确认 Edge 已启动、BookmarkPocket 扩展已启用，" +
        "且扩展选项页的端口/令牌与中枢一致（当前端口 " + cfg.port + "）"
      );
    }
    const id = `c${++msgSeq}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("等待扩展响应超时: " + op)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      try { active.send(JSON.stringify({ type: "call", id, op, args: args || {} })); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  function status() {
    return {
      mode,
      port: cfg.port,
      controlPort: cfg.controlPort,
      pairPort: cfg.pairPort,
      extensionConnected: !!(active && active.readyState === 1),
      startedAt,
      version: SERVER_VERSION,
      ...stats(),
      events: events.slice(-20),
    };
  }

  function close() {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    try { if (controlWss) controlWss.close(); } catch (e) { /* ignore */ }
    try { if (relay) relay.close(); } catch (e) { /* ignore */ }
    try { wss.close(); } catch (e) { /* ignore */ }
    try { if (pairSrv) pairSrv.close(); } catch (e) { /* ignore */ }
  }

  return { call: callExtension, status, close, isSecondary: () => mode === "secondary" };
}
