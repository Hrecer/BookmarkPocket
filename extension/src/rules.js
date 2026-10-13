// 收藏归位规则：书签一被创建（Ctrl+D / 点星星 / 拖拽 / 别的扩展），按规则搬到目标文件夹。
//
// 为什么是"搬"而不是"选"：浏览器那个收藏弹窗是宿主自己的界面，扩展碰不到它，
// 所以弹窗里显示的文件夹改不了。能做的是在创建完成的瞬间把书签移到正确位置。
//
// 匹配是纯函数，存储读写也在这一层；不碰 DOM，写操作一律走 ops（可撤销、有日志）。

import { K } from "./keys.js";
import { execute, isSelfWrite, note } from "./ops.js";

const DEFAULT_PATH = "收藏夹栏";

export const DEFAULTS = {
  enabled: true,                                   // 总开关：收藏时自动归位
  fallback: { enabled: true, path: DEFAULT_PATH }, // 兜底：其他一切 → 收藏夹栏
  list: [],
};

function uid() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

function normRule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = raw.match && raw.match.type === "url" ? "url" : "host";
  const value = String((raw.match && raw.match.value) || "").trim();
  const target = String(raw.target || "").trim();
  if (!value || !target) return null;
  return { id: String(raw.id || uid()), enabled: raw.enabled !== false, match: { type, value }, target };
}

export function normalize(cfg) {
  const src = cfg && typeof cfg === "object" ? cfg : {};
  const fb = src.fallback && typeof src.fallback === "object" ? src.fallback : {};
  return {
    enabled: src.enabled !== false,
    fallback: {
      enabled: fb.enabled !== false,
      path: String(fb.path || "").trim() || DEFAULT_PATH,
    },
    list: (Array.isArray(src.list) ? src.list : []).map(normRule).filter(Boolean),
  };
}

export async function read() {
  const o = await chrome.storage.local.get(K.rules);
  return normalize(o[K.rules]);
}

export async function write(cfg) {
  const clean = normalize(cfg);
  await chrome.storage.local.set({ [K.rules]: clean });
  return clean;
}

// 单条规则是否命中。host = 域名（含子域）相等；url = URL 里包含该片段。
export function matches(rule, url) {
  if (!rule || rule.enabled === false) return false;
  const value = String(rule.match.value || "").toLowerCase();
  if (!value) return false;
  const u = String(url || "").toLowerCase();
  if (rule.match.type === "url") return u.includes(value);
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return false; }
  return host === value || host.endsWith("." + value);
}

// 自上而下先命中先用；都没命中才走兜底。返回目标路径，null 表示不动。
export function pickTarget(cfg, url) {
  if (!cfg || cfg.enabled === false) return null;
  for (const r of cfg.list) if (matches(r, url)) return r.target;
  return cfg.fallback.enabled ? cfg.fallback.path : null;
}

// 把 "收藏夹栏 > 示例分类 > 子目录" 解析成文件夹 id；缺哪一层就建哪一层。
async function folderIdByPath(path) {
  const parts = String(path || "").split(">").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  let parentId = "0";
  for (const title of parts) {
    const root = (await execute("bookmark.tree", {})).tree[0];
    const here = parentId === "0" ? { children: root.children } : findById(root, parentId);
    const hit = ((here && here.children) || []).find((n) => !n.url && n.title === title);
    if (hit) { parentId = hit.id; continue; }
    parentId = (await execute("bookmark.create", { parentId, title })).created.id;
  }
  return parentId;
}

function findById(node, id) {
  if (node.id === id) return node;
  for (const c of node.children || []) {
    const hit = findById(c, id);
    if (hit) return hit;
  }
  return null;
}

// 新书签落到哪。返回目标路径（用于日志/回报），没动则 null。
export async function autoRoute(id, node) {
  if (!node || !node.url) return null;        // 文件夹不参与
  // 我们自己写进去的（管理器 UI / Agent / 撤销 / 复制）位置是明确指定的，不归位。
  // 只认「我们刚写进那个父目录」这一下——按「有操作在跑」一刀切会误伤浏览器随后发来的移动事件。
  if (isSelfWrite(id, node.parentId)) return null;
  const cfg = await read();
  const path = pickTarget(cfg, node.url);
  if (!path) return null;
  const parentId = await folderIdByPath(path);
  if (!parentId) return null;
  const cur = (await execute("bookmark.get", { id })).node;
  if (!cur || cur.parentId === parentId) {
    // 已经在该在的地方：也留一笔，否则「它怎么又跑到那去了」根本查不出来
    if (cur) await note("rules.route", `归位检查：${cur.title || cur.id} 已在 ${cur.path || path}`);
    return null;
  }
  await execute("bookmark.move", { id, parentId });
  return path;
}

// 浏览器自己把书签挪了地方（收藏弹窗里改文件夹后确认 / 原生收藏管理器里拖动）：这类移动
// 只发 onMoved、不发 onCreated，不接住的话书签就留在错的地方，看着像兜底没生效。
// parentId 是事件里报的新父目录——用它认领「这一下是不是我们自己搬的」。
export async function settleMove(id, parentId) {
  if (isSelfWrite(id, parentId)) return null;
  const cur = (await execute("bookmark.get", { id })).node;
  if (!cur || !cur.url) return null;
  await note("rules.settle", `外部移动：${cur.title || cur.id} → ${cur.path || parentId}`);
  return autoRoute(id, cur);
}
