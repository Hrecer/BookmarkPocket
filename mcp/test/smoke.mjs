// 全链路冒烟：真实 stdio MCP 握手 + 假扩展走 WS 中枢。
// 覆盖：tools/list、tools/call 往返（stdio→中枢→扩展→回）、参数透传、扩展离线时结构化报错、
//       welcome 自报进程占用、心跳推送、Agent 侧不掉 undo 明细、中枢可被「关闭」通道停掉、
//       宿主一没（stdin 结束）中枢自行退出（绝不留后台孤儿）。
// 跑法：cd mcp && npm test
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 19311;
const TOKEN = "smoke-token-" + Date.now();
const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = "chrome-extension://" + EXT_ID;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  " + extra : "")); }
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, "..", "src", "server.js")],
  env: { ...process.env, BOOKMARKPOCKET_PORT: String(PORT), BOOKMARKPOCKET_TOKEN: TOKEN, BOOKMARKPOCKET_ORIGINS: ORIGIN },
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});
transport.onerror = () => {};

const client = new Client({ name: "smoke", version: "0.1.0" });
await client.connect(transport);
ok("MCP stdio 握手成功", true);

async function connectWs(port, origin = ORIGIN) {
  for (let i = 0; i < 20; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin });
      await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
      return ws;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("无法连接 WS 中枢 " + port);
}

const ext = await connectWs(PORT);
let welcome = null;
ext.on("message", (buf) => {
  const m = JSON.parse(String(buf));
  if (m.type === "welcome") { welcome = m; return; }
  if (m.type === "call") {
    let data;
    if (m.op === "sys.bridge.status") data = { connected: true, mock: true, url: `ws://127.0.0.1:${PORT}/` };
    else if (m.op === "bookmark.tree") data = { tree: [{ id: "0", children: [{ id: "1", title: "收藏夹栏", path: "收藏夹栏", children: [] }] }], cached: false };
    else if (m.op === "bookmark.move") data = { moved: m.args.id, summary: "移动：x", undo: { kind: "move", id: m.args.id, before: { parentId: "1", index: 3 } } };
    else data = { echo: { op: m.op, args: m.args } };
    ext.send(JSON.stringify({ type: "result", id: m.id, ok: true, data }));
  }
});
ext.send(JSON.stringify({ type: "hello", token: TOKEN, extId: EXT_ID, version: "0.1.0" }));
await new Promise((res) => { const t = setInterval(() => { if (welcome) { clearInterval(t); res(); } }, 30); });

ok("welcome 自带中枢信息（version/pid）", !!welcome && welcome.version === "0.1.0" && typeof welcome.pid === "number" && welcome.pid > 0, JSON.stringify(welcome && { version: welcome.version, pid: welcome.pid }));

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
ok("tools/list 返回 15 个工具", names.length === 15, names.join(", "));
ok("包含规则工具 rules_get / rules_set / rules_apply", names.includes("rules_get") && names.includes("rules_set") && names.includes("rules_apply"));
ok("包含 bookmark_remove / bookmark_undo_last", names.includes("bookmark_remove") && names.includes("bookmark_undo_last"));
ok("包含批量工具 bookmark_move_many / bookmark_create_many",
   names.includes("bookmark_move_many") && names.includes("bookmark_create_many"));

const pairRes = await fetch(`http://127.0.0.1:${PORT + 1}/pair.json`).catch(() => null);
const pairData = pairRes && pairRes.ok ? await pairRes.json() : null;
ok("一键配对端可读（把端口与令牌交给扩展）",
   !!pairData && pairData.token === TOKEN && pairData.port === PORT, JSON.stringify(pairData));

const r1 = await client.callTool({ name: "bridge_status", arguments: {} });
ok("bridge_status 全链路（stdio→中枢→扩展→回）", !r1.isError && r1.content[0].text.includes("\"connected\": true"));

const r2 = await client.callTool({ name: "bookmarks_search", arguments: { query: "abc", limit: 5 } });
const t2 = JSON.parse(r2.content[0].text);
ok("参数透传到扩展", t2.echo && t2.echo.op === "bookmark.search" && t2.echo.args.query === "abc" && t2.echo.args.limit === 5);

const r3 = await client.callTool({ name: "bookmarks_tree", arguments: {} });
ok("树数据回传", r3.content[0].text.includes("收藏夹栏"));

const r3b = await client.callTool({ name: "rules_set", arguments: { config: { enabled: true, list: [] } } });
const t3b = JSON.parse(r3b.content[0].text);
ok("rules_set 参数透传到扩展", t3b.echo && t3b.echo.op === "rules.set" && t3b.echo.args.config.enabled === true);

// 大幅批量操作回带的 undo 明细必须被剥掉（否则响应会被撑爆），只留 undoable 提示
const r3c = await client.callTool({ name: "bookmark_move", arguments: { id: "42", parentId: "1" } });
const t3c = JSON.parse(r3c.content[0].text);
ok("Agent 侧不掉 undo 明细（只留 undoable）", !("undo" in t3c) && t3c.undoable === true && t3c.moved === "42", r3c.content[0].text);

ext.close();
await new Promise((r) => setTimeout(r, 300));
const r4 = await client.callTool({ name: "bridge_status", arguments: {} });
ok("扩展离线时返回结构化错误", r4.isError === true && r4.content[0].text.includes("扩展未连接"));

/* ---------- 中枢自报进程占用 + 可被「关闭」通道停掉（绝不留后台孤儿） ---------- */

const ext2 = await connectWs(PORT);
let w2 = null, pushed = null;
ext2.on("message", (buf) => {
  const m = JSON.parse(String(buf));
  if (m.type === "welcome") w2 = m;
  if (m.type === "hubStatus") pushed = m;
  if (m.type === "call") ext2.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: { connected: true } }));
});
ext2.send(JSON.stringify({ type: "hello", token: TOKEN, extId: EXT_ID, version: "0.1.0" }));
await new Promise((r) => setTimeout(r, 200));
ok("welcome 自报进程占用（PID / 内存）", !!w2 && w2.pid > 0 && typeof w2.rssMb === "number", JSON.stringify(w2 && { pid: w2.pid, rssMb: w2.rssMb }));

for (let i = 0; i < 24 && !pushed; i++) await new Promise((r) => setTimeout(r, 500));
ok("中枢每 5 秒推送进程占用", !!pushed && typeof pushed.rssMb === "number" && pushed.pid === w2.pid, JSON.stringify(pushed));

const ack = new Promise((res) => {
  const t = setTimeout(() => res(null), 1500);
  ext2.on("message", (buf) => { const m = JSON.parse(String(buf)); if (m.type === "shutdown") { clearTimeout(t); res(m); } });
});
ext2.send(JSON.stringify({ type: "shutdown" }));
const a = await ack;
ok("「关闭中枢」有确认回执", !!a && a.ok === true, JSON.stringify(a));

await new Promise((r) => setTimeout(r, 900));
let dead = false;
await Promise.race([
  client.callTool({ name: "bridge_status", arguments: {} }).then(() => {}, () => { dead = true; }),
  new Promise((r) => setTimeout(r, 2500)),
]);
ok("关闭后 MCP 进程已退出（不再应答）", dead);

/* ---------- 宿主一没就自己走：stdin 结束 → 进程退出（绝不留后台孤儿） ---------- */

const ORPHAN_PORT = 19331;
const orphan = spawn(process.execPath, [path.join(HERE, "..", "src", "server.js")], {
  env: { ...process.env, BOOKMARKPOCKET_PORT: String(ORPHAN_PORT), BOOKMARKPOCKET_CONTROL_PORT: String(ORPHAN_PORT + 2), BOOKMARKPOCKET_PAIR_PORT: String(ORPHAN_PORT + 1), BOOKMARKPOCKET_TOKEN: "orphan-test" },
  stdio: ["pipe", "pipe", "pipe"],
});
let orphanExit = null;
orphan.on("exit", (code) => { orphanExit = code; });
const portOpen = (port) => new Promise((res) => {
  const s = net.connect(port, "127.0.0.1");
  s.on("connect", () => { s.destroy(); res(true); });
  s.on("error", () => res(false));
  setTimeout(() => { try { s.destroy(); } catch (e) { /* ignore */ } res(false); }, 400);
});
let orphanUp = false;
for (let i = 0; i < 25; i++) { if (await portOpen(ORPHAN_PORT)) { orphanUp = true; break; } await new Promise((r) => setTimeout(r, 200)); }
// 先像真宿主那样握一次手：没握过手就不算"宿主说过话"，那种情况（宿主压根没给 stdin）不该自杀
orphan.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-orphan", version: "1" } } }) + "\n");
await new Promise((r) => setTimeout(r, 400));
orphan.stdin.end();                          // 模拟宿主退出（stdin 断掉）
await new Promise((r) => setTimeout(r, 1500));
ok("宿主一没（握手后 stdin 结束）中枢自行退出，不留后台孤儿", orphanUp && orphanExit === 0, "up=" + orphanUp + " exit=" + orphanExit);
if (orphanExit === null) orphan.kill();

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
