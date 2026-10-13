// 收藏归位规则：书签一被创建（Ctrl+D / 点星星 / 拖拽 / 别的扩展），按规则搬到目标文件夹。
//
// 为什么是"搬"而不是"选"：浏览器那个收藏弹窗是宿主自己的界面，扩展碰不到它，
// 所以弹窗里显示的文件夹改不了。能做的是在创建完成的瞬间把书签移到正确位置。
//
// 匹配是纯函数，存储读写也在这一层；不碰 DOM，写操作一律走 ops（可撤销、有日志）。

import { K } from "./keys.js";
import { execute, isSelfWrite, note, ensureTree, markSelf, invalidateTree } from "./ops.js";

const bm = () => globalThis.chrome.bookmarks;

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
// useFallback=false 时只认显式规则、忽略兜底（事后整理默认如此，免得把无关书签吸进兜底目录）。
export function pickTarget(cfg, url, useFallback = true) {
  if (!cfg || cfg.enabled === false) return null;
  for (const r of cfg.list) if (matches(r, url)) return r.target;
  return useFallback && cfg.fallback.enabled ? cfg.fallback.path : null;
}

// 把 "收藏夹栏 > 示例分类 > 子目录" 解析成文件夹 id；缺哪一层就建哪一层。
// tree 是当前树快照；cache 记住本次操作里「父目录+标题 → id」的解析结果，
// 这样同一批里新建的分支能被后续路径复用。createFolder 决定「怎么建」（走 execute 记账，或直连 bm）。
async function resolvePathId(tree, path, cache, createFolder) {
  const parts = String(path || "").split(">").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const root = tree[0];
  let parentId = "0";
  for (const title of parts) {
    const key = parentId + "\u0000" + title;
    if (cache.has(key)) { parentId = cache.get(key); continue; }
    const here = parentId === "0" ? root : findById(root, parentId);
    const hit = ((here && here.children) || []).find((n) => !n.url && n.title === title);
    if (hit) { parentId = hit.id; cache.set(key, hit.id); continue; }
    const made = await createFolder(parentId, title);
    cache.set(key, made.id);
    parentId = made.id;
  }
  return parentId;
}

async function folderIdByPath(path) {
  const tree = await ensureTree(false);
  return resolvePathId(tree, path, new Map(), async (parentId, title) => (await execute("bookmark.create", { parentId, title })).created);
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

/* ---------- 事后整理：把规则套用到已有书签 ---------- */

// 按当前规则把「已经躺在库里」的书签搬正（新收藏有 autoRoute，这一支补的是存量）。
// 本函数跑在 execute 的串行队列里，内部只直连 chrome.bookmarks——再调 execute 会自锁。
// 一笔操作日志 + 一键撤销：撤销会把书签搬回原位，并回收本次新建的空文件夹。
export async function applyRules({ path: scope, dryRun = false, includeFallback = false, config } = {}) {
  const cfg = config ? normalize(config) : await read();
  if (!cfg.enabled) throw new Error("「收藏归位」总开关是关的：规则不会生效，请先开启（rules_set 里设 enabled:true）");

  const tree = await ensureTree(true);
  const scopeLc = scope ? String(scope).trim().toLowerCase() : "";
  const all = [];
  (function walk(nodes) { for (const n of nodes || []) { all.push(n); if (n.children) walk(n.children); } })(tree);
  const cands = all.filter((n) => n.url && (!scopeLc || String(n.path || "").toLowerCase().includes(scopeLc)));

  const cache = new Map();        // 路径解析缓存（含本次新建的分支）
  const createdFolders = [];      // 本次新建的文件夹 id
  let willCreate = 0;             // 预演时统计「将会新建」的文件夹数
  const createFolder = async (parentId, title) => {
    if (dryRun) { willCreate++; return { id: "\u0000dry:" + parentId + "/" + title }; }   // 预演不落刀
    const made = await bm().create({ parentId, title });
    markSelf(made.id, parentId);
    createdFolders.push(made.id);
    return made;
  };

  const items = [];               // 待搬条目
  let already = 0, noRule = 0;
  for (const n of cands) {
    const target = pickTarget(cfg, n.url, includeFallback);
    if (!target) { noRule++; continue; }
    let targetId;
    try { targetId = await resolvePathId(tree, target, cache, createFolder); }
    catch (e) { noRule++; continue; }
    if (!targetId) { noRule++; continue; }
    if (String(n.parentId) === String(targetId)) { already++; continue; }
    items.push({ id: n.id, title: n.title || "", from: n.path || "", to: target, targetId, parentId: n.parentId, index: n.index });
  }

  const byTarget = new Map();
  for (const it of items) byTarget.set(it.to, (byTarget.get(it.to) || 0) + 1);
  const report = {
    scope: scope || "(整棵树)",
    considered: cands.length,
    matched: items.length,
    alreadyInPlace: already,
    noRule,
    byTarget: [...byTarget.entries()].map(([target, count]) => ({ target, count })).sort((a, b) => b.count - a.count),
    samples: items.slice(0, 20).map(({ title, from, to }) => ({ title, from, to })),
    createdFolders: createdFolders.map(String),
    willCreateFolders: willCreate,
  };

  if (dryRun) return { ...report, dryRun: true, moved: 0, failed: [] };
  if (!items.length) return { ...report, dryRun: false, moved: 0, failed: [] };   // 无命中：不落刀、不记日志

  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.targetId)) groups.set(it.targetId, []);
    groups.get(it.targetId).push(it.id);
  }
  const moves = items.map((it) => ({ id: it.id, parentId: it.parentId, index: it.index }));

  let moved = 0;
  const failed = [];
  for (const [parentId, ids] of groups) {
    markSelf(ids, parentId);   // 先记账再搬：事件异步派发，晚记会把我们自己的移动当外部移动
    for (let i = 0; i < ids.length; i += 128) {
      await Promise.all(ids.slice(i, i + 128).map(async (id) => {
        try { await bm().move(id, { parentId }); moved++; }
        catch (e) { failed.push({ id, error: String((e && e.message) || e) }); }
      }));
    }
  }
  invalidateTree();

  return {
    ...report,
    dryRun: false,
    moved,
    failed,
    summary: `一键归位：搬迁 ${moved} 项 → ${groups.size} 个目标文件夹`,
    undo: { kind: "moveMany", moves, createdFolders: createdFolders.map(String) },
  };
}
