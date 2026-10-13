// BookmarkPocket AI 接入：
//   1) 对 Agent 暴露 MCP（stdio）；2) 对本机浏览器扩展暴露 WS 中枢（127.0.0.1）。
// 工具调用 → WS → 扩展的 ops.execute（与扩展 UI 完全同一条管线）。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket as WSClient } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS } from "./tools.js";
import { startPairServer } from "./pair.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BOOKMARKPOCKET_CONFIG || path.join(HERE, "..", "config.json");
const SERVER_VERSION = "0.1.0";

function log(...a) { console.error("[bookmarkpocket-mcp]", ...a); }   // stdout 留给 MCP 协议

function loadConfig() {
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
      log("已生成配置文件:", CONFIG_PATH, "（把 token 填到扩展选项页）");
    } catch (e) { log("配置写入失败:", e.message); }
  }
  return cfg;
}

const cfg = loadConfig();

/* ---------- 一键配对端：把端口与令牌交给扩展（免手抄） ---------- */

startPairServer(cfg, log);

/* ---------- WS 中枢：扩展连到这里 ---------- */

let active = null;                 // 当前扩展连接
const pending = new Map();         // id -> {resolve, reject, timer}
let msgSeq = 0;

let mode = "primary";   // primary=自己监听扩展；secondary=端口被常驻中枢占了，转为中继
const wss = new WebSocketServer({ host: "127.0.0.1", port: cfg.port });
wss.on("listening", () => {
  log(`WS 中枢已监听 ws://127.0.0.1:${cfg.port}（等待浏览器扩展）`);
  startControlHub();
});
wss.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") { becomeSecondary(); return; }
  log("WS 中枢错误:", e.message);
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
      log(`扩展已连接: id=${m.extId} v=${m.version}`);
      ws.send(JSON.stringify({ type: "welcome", server: "bookmarkpocket-mcp", version: SERVER_VERSION }));
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
      log("书签变动事件:", m.event);
      for (const cc of controlClients) {
        try { cc.send(JSON.stringify({ type: "event", event: m.event, args: m.args })); } catch (e) { /* ignore */ }
      }
      return;
    }
    if (m.type === "pong") return;
  });

  ws.on("close", () => {
    if (active === ws) {
      active = null;
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

const controlClients = new Set();
let controlWss = null;

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
      "且扩展选项页的端口/令牌与本机中枢一致（当前端口 " + cfg.port + "）"
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

/* ---------- MCP：暴露给 Agent ---------- */

const server = new McpServer({ name: "bookmarkpocket", version: SERVER_VERSION });

for (const t of TOOLS) {
  server.tool(t.name, t.description, t.shape, async (args) => {
    try {
      const data = await callExtension(t.op, t.mapArgs ? t.mapArgs(args) : args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "错误: " + String((e && e.message) || e) }], isError: true };
    }
  });
}

await server.connect(new StdioServerTransport());
log(`MCP stdio 已就绪（${TOOLS.length} 个工具）：${TOOLS.map((t) => t.name).join(", ")}`);
