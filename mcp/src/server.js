// BookmarkPocket AI 接入：对 Agent 暴露 MCP（stdio），并把「中枢」挂起来。
//
// 中枢本身在 hub.js 里 —— 它既能内嵌在这里（宿主拉起的子进程），也能独立运行
// （mcp/hub.js + 启动中枢.bat）。若独立中枢已经在跑，这里会自动转中继。
//
// 工具调用 → 中枢 → WS → 扩展的 ops.execute（与扩展 UI 完全同一条管线）。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS } from "./tools.js";
import { loadConfig, startHub, CONFIG_PATH, SERVER_VERSION } from "./hub.js";

function log(...a) { console.error("[bookmarkpocket-mcp]", ...a); }   // stdout 留给 MCP 协议

const cfg = loadConfig();
const hub = startHub({ cfg, log, onShutdown: () => process.exit(0) });
log("配置:", CONFIG_PATH, "（首次生成时会把 token 填到扩展选项页）");

// 宿主没了就自己走：我们是宿主按 stdio 拉起的子进程，stdin 一旦结束（宿主退出、
// 崩溃、不再说话），说明没人需要这个中枢了 —— 必须自己退出，绝不留成后台孤儿。
// 不能指望"宿主会顺手杀掉子进程"，也不能指望管道断开那种连带反应。
let byeDone = false;
function bye(why) {
  if (byeDone) return;
  byeDone = true;
  log("退出中枢：" + why);
  try { hub.close(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.stdin.on("end", () => bye("宿主已关闭（stdin 结束）"));
process.on("SIGINT", () => bye("收到 Ctrl+C"));
process.on("SIGTERM", () => bye("收到终止信号"));

/* ---------- MCP：暴露给 Agent ---------- */

const server = new McpServer({ name: "bookmarkpocket", version: SERVER_VERSION });

// 回给 Agent 的结果里剥掉 undo 明细：它是给「操作日志 / 一键撤销」用的，动辄几千条，
// 原样返回会把响应撑爆（Agent 也用不到，撤销走 bookmark_undo_last）。只留个布尔提示。
function toAgentData(data) {
  if (data && typeof data === "object" && !Array.isArray(data) && "undo" in data) {
    const { undo, ...rest } = data;
    return undo ? { ...rest, undoable: true } : rest;
  }
  return data;
}

for (const t of TOOLS) {
  server.tool(t.name, t.description, t.shape, async (args) => {
    try {
      const data = await hub.call(t.op, t.mapArgs ? t.mapArgs(args) : args);
      return { content: [{ type: "text", text: JSON.stringify(toAgentData(data), null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "错误: " + String((e && e.message) || e) }], isError: true };
    }
  });
}

await server.connect(new StdioServerTransport());
log(`MCP stdio 已就绪（${TOOLS.length} 个工具）：${TOOLS.map((t) => t.name).join(", ")}`);
