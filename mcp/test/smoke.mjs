// 全链路冒烟：真实 stdio MCP 握手 + 假扩展走 WS 中枢。
// 覆盖：tools/list、tools/call 往返（stdio→中枢→扩展→回）、参数透传、扩展离线时结构化报错。
// 跑法：cd mcp && npm test
import path from "node:path";
import { fileURLToPath } from "node:url";
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

async function connectFakeExt() {
  for (let i = 0; i < 20; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { origin: ORIGIN });
      await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
      return ws;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("无法连接 WS 中枢");
}

const ext = await connectFakeExt();
ext.on("message", (buf) => {
  const m = JSON.parse(String(buf));
  if (m.type === "call") {
    let data;
    if (m.op === "sys.bridge.status") data = { connected: true, mock: true, url: `ws://127.0.0.1:${PORT}/` };
    else if (m.op === "bookmark.tree") data = { tree: [{ id: "0", children: [{ id: "1", title: "收藏夹栏", path: "收藏夹栏", children: [] }] }], cached: false };
    else data = { echo: { op: m.op, args: m.args } };
    ext.send(JSON.stringify({ type: "result", id: m.id, ok: true, data }));
  }
});
ext.send(JSON.stringify({ type: "hello", token: TOKEN, extId: EXT_ID, version: "0.1.0" }));
await new Promise((res) => ext.once("message", res)); // welcome

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
ok("tools/list 返回 10 个工具", names.length === 10, names.join(", "));
ok("包含 bookmark_remove / bookmark_undo_last", names.includes("bookmark_remove") && names.includes("bookmark_undo_last"));

const r1 = await client.callTool({ name: "bridge_status", arguments: {} });
ok("bridge_status 全链路（stdio→中枢→扩展→回）", !r1.isError && r1.content[0].text.includes("\"connected\": true"));

const r2 = await client.callTool({ name: "bookmarks_search", arguments: { query: "abc", limit: 5 } });
const t2 = JSON.parse(r2.content[0].text);
ok("参数透传到扩展", t2.echo && t2.echo.op === "bookmark.search" && t2.echo.args.query === "abc" && t2.echo.args.limit === 5);

const r3 = await client.callTool({ name: "bookmarks_tree", arguments: {} });
ok("树数据回传", r3.content[0].text.includes("收藏夹栏"));

ext.close();
await new Promise((r) => setTimeout(r, 300));
const r4 = await client.callTool({ name: "bridge_status", arguments: {} });
ok("扩展离线时返回结构化错误", r4.isError === true && r4.content[0].text.includes("扩展未连接"));

await client.close();
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
