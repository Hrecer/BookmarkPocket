// MCP 工具清单：每个工具只做一件事——把参数映射成扩展侧 ops 的调用。
// 语义、安全闸（预演/撤销回放）全部在扩展的操作层，这里保持薄转发。

import { z } from "zod";

export const TOOLS = [
  {
    name: "bridge_status",
    description: "查看桥连接状态：扩展是否已连上本机中枢",
    op: "sys.bridge.status",
    shape: {},
  },
  {
    name: "bookmarks_tree",
    description: "读取完整书签树（每个节点带 path：所在文件夹路径，如 \"收藏夹栏 > 新闻\"）",
    op: "bookmark.tree",
    shape: { fresh: z.boolean().optional().describe("true 时绕过缓存重新读取") },
  },
  {
    name: "bookmarks_search",
    description: "按关键词搜索标题/URL（全量索引），可用 path 限定文件夹路径；返回 id/title/url/path",
    op: "bookmark.search",
    shape: {
      query: z.string().describe("关键词（不区分大小写）"),
      path: z.string().optional().describe("限定所在文件夹路径包含该片段"),
      limit: z.number().optional().describe("最多返回条数，默认 50，上限 500"),
    },
  },
  {
    name: "bookmark_get",
    description: "按 id 读取单条书签/文件夹",
    op: "bookmark.get",
    shape: { id: z.string() },
  },
  {
    name: "bookmark_create",
    description: "新建书签（给出 url）或文件夹（不给 url）",
    op: "bookmark.create",
    shape: {
      parentId: z.string(),
      title: z.string().optional(),
      url: z.string().optional(),
      index: z.number().optional(),
    },
  },
  {
    name: "bookmark_create_many",
    description: "批量新建：一次调用在同一文件夹下建多个条目（有 url 建书签，无 url 建文件夹），整批只记一笔撤销",
    op: "bookmark.createMany",
    shape: {
      parentId: z.string().describe("所在文件夹 id"),
      items: z
        .array(z.object({ title: z.string().optional(), url: z.string().optional() }))
        .describe("要新建的条目列表；带 url 建书签，不带 url 建文件夹"),
    },
  },
  {
    name: "bookmark_update",
    description: "修改书签/文件夹的标题或 URL",
    op: "bookmark.update",
    shape: { id: z.string(), title: z.string().optional(), url: z.string().optional() },
  },
  {
    name: "bookmark_move",
    description: "移动书签/文件夹到指定文件夹（可指定位置 index）",
    op: "bookmark.move",
    shape: { id: z.string(), parentId: z.string(), index: z.number().optional() },
  },
  {
    name: "bookmark_move_many",
    description: "批量移动：一次调用把多个书签/文件夹移到同一目标文件夹，整批只记一笔撤销（要比逐条调 bookmark_move 快得多）",
    op: "bookmark.moveMany",
    shape: {
      ids: z.array(z.string()).describe("要移动的 id 列表"),
      parentId: z.string().describe("目标文件夹 id"),
      chunk: z.number().optional().describe("并发分块大小，默认 64，上限 256"),
    },
  },
  {
    name: "bookmark_remove",
    description: "删除书签/文件夹（直接删除，与浏览器原生一致：删了就从书签树消失；文件夹整树带走）。可先 dryRun:true 预览将删除的数量",
    op: "bookmark.remove",
    shape: {
      ids: z.array(z.string()).describe("要删除的 id 列表（文件夹会整树带走）"),
      dryRun: z.boolean().optional().describe("true 时只返回将删除的数量，不落刀"),
    },
  },
  {
    name: "bookmark_undo_last",
    description: "撤销最近一次写操作（移动/改名/删除均可回放）",
    op: "bookmark.undoLast",
    shape: {},
  },
  {
    name: "log_tail",
    description: "查看最近操作日志（人与 Agent 共用同一份日志）",
    op: "log.tail",
    shape: { n: z.number().optional().describe("条数，默认 20") },
  },
];
