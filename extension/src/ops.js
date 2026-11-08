// 统一操作层：人（管理器 UI）与 Agent（经桥）走同一条管线。
// 同一注册表、同一串行队列、同一份操作日志、同一套安全闸。
// 原则：所有操作完全在书签机制内完成——不创建任何额外文件夹，删除就是删除。

import { K } from "./keys.js";

const LOG_CAP = 300;
const SELF_TTL_MS = 30000;          // 单条写入的认领窗口
const SELF_CAP = 5000;
const BULK_GRACE_MS = 15000;        // 批量结束后继续认领迟到事件

// 控制/只读操作不排进批量写入的串行队列：否则一次大移动会把状态、重连、规则读取
// 全部堵在队列后面，管理页看起来就像「中枢没运行」。
const CONTROL_OPS = new Set([
  "sys.ping", "sys.status", "sys.bulk.status",
  "sys.bridge.status", "sys.bridge.reconnect", "sys.bridge.pair", "sys.hub.shutdown",
  "rules.get", "rules.set", "log.tail",
]);

let treeCache = null;
let tail = Promise.resolve();

const bm = () => globalThis.chrome.bookmarks;
const st = () => globalThis.chrome.storage.local;

export function invalidateTree() { treeCache = null; }

// 扩展自己写入期间置位。保留给测试/旧调用；批量操作改用下面的 bulk 上下文，
// 不再靠这个全局标志判断 onCreated（长批量会把用户的新收藏也误吞）。
let internal = 0;

export function isInternalWrite() { return internal > 0; }

// 我们自己写过的书签：记「这是我们的动作，写进去时父目录是谁」。
// 认领口径是父目录，不能只按 id 一刀切：那样会把浏览器随后对同一条书签的挪动也当成自己的而漏掉。
const selfWrites = new Map();

// 批量上下文：批量写入的 id → 目标父目录。
// 批量操作往往远超单条认领窗口（10 秒远远不够），单靠时间戳会把迟到事件误判成外部操作，
// 触发 settleMove/autoRoute 洪泛，最终把串行队列堵死。
let bulkDepth = 0;
const bulkWrites = new Map();
let bulkGraceUntil = 0;
let lastBulk = null;
let progressHook = null;
let bulkEndHook = null;

function pruneSelfWrites() {
  const now = Date.now();
  for (const [id, r] of selfWrites) if (now - r.ts > SELF_TTL_MS) selfWrites.delete(id);
  while (selfWrites.size > SELF_CAP) {
    const first = selfWrites.keys().next().value;
    if (first === undefined) break;
    selfWrites.delete(first);
  }
}

function pruneBulk() {
  if (bulkDepth === 0 && bulkGraceUntil && Date.now() > bulkGraceUntil) {
    bulkWrites.clear();
    bulkGraceUntil = 0;
  }
}

export function markSelf(ids, parentId) {
  pruneSelfWrites();
  const ts = Date.now();
  for (const id of [].concat(ids)) selfWrites.set(String(id), { parentId: String(parentId), ts });
}

export function isSelfWrite(id, parentId) {
  pruneBulk();
  const sid = String(id);
  if (bulkWrites.has(sid)) {
    const bp = bulkWrites.get(sid);
    return parentId !== undefined && parentId !== null && String(parentId) === bp;
  }
  const r = selfWrites.get(sid);
  if (!r) return false;
  if (Date.now() - r.ts > SELF_TTL_MS) { selfWrites.delete(sid); return false; }
  return parentId !== undefined && parentId !== null && String(parentId) === r.parentId;
}

export function isBulkActive() { return bulkDepth > 0; }
export function isBulkQuiet() { pruneBulk(); return bulkDepth > 0 || bulkGraceUntil > Date.now(); }

export function beginBulk(op, total = 0) {
  pruneBulk();
  bulkDepth++;
  bulkGraceUntil = 0;
  lastBulk = {
    op: String(op || ""),
    status: "running",
    total: Math.max(0, Number(total) || 0),
    done: 0,
    failed: 0,
    startedAt: Date.now(),
  };
}

export function noteBulk(id, parentId) {
  if (bulkDepth === 0) return;
  bulkWrites.set(String(id), String(parentId));
}

export function bulkProgress(p = {}) {
  if (!lastBulk) return;
  lastBulk = { ...lastBulk, ...p, updatedAt: Date.now() };
  if (progressHook) {
    try { progressHook({ ...lastBulk }); } catch (e) { /* ignore */ }
  }
}

export function endBulk(p = {}) {
  bulkDepth = Math.max(0, bulkDepth - 1);
  if (bulkDepth !== 0) return;
  bulkGraceUntil = Date.now() + BULK_GRACE_MS;
  if (lastBulk) {
    lastBulk = {
      ...lastBulk,
      ...p,
      status: Number((p.failed !== undefined ? p.failed : lastBulk.failed) || 0) > 0 ? "done_with_errors" : "done",
      endedAt: Date.now(),
    };
    if (progressHook) { try { progressHook({ ...lastBulk }); } catch (e) { /* ignore */ } }
  }
  if (bulkEndHook) { try { bulkEndHook(); } catch (e) { /* ignore */ } }
}

export function getBulkStatus() {
  pruneBulk();
  return lastBulk ? { ...lastBulk, active: bulkDepth > 0 } : { status: "idle", active: false };
}

export function setProgressHook(fn) { progressHook = typeof fn === "function" ? fn : null; }
export function setBulkEndHook(fn) { bulkEndHook = typeof fn === "function" ? fn : null; }

export function execute(op, args = {}, opts = {}) {
  const name = String(op || "");
  if (CONTROL_OPS.has(name)) return dispatch(name, args, opts);
  const p = tail.then(async () => {
    internal++;
    try { return await dispatch(name, args, opts); }
    finally { internal--; }
  });
  tail = p.then(() => {}, () => {});
  return p;
}

export function defineOps(map) { Object.assign(OPS, map); }

async function dispatch(op, args, opts = {}) {
  const h = OPS[op];
  if (!h) throw new Error("未知操作: " + op);
  const result = await h.fn(args, opts);
  if (h.mutating && result && result.undo) {
    await pushLog({ ts: Date.now(), op, args, summary: result.summary || null, undo: result.undo });
  }
  return result;
}

async function pushLog(entry) {
  const log = await readLog();
  log.push(entry);
  while (log.length > LOG_CAP) log.shift();
  await st().set({ [K.oplog]: log });
}

// 只留痕、不带撤销：给「不是我们发起的变动」和归位判定用（谁在什么时候把哪条书签挪到了哪）。
export async function note(op, summary) {
  await pushLog({ ts: Date.now(), op, args: {}, summary, undo: null });
}

async function readLog() {
  const o = await st().get(K.oplog);
  return Array.isArray(o[K.oplog]) ? o[K.oplog] : [];
}

/* ---------- 树 / 索引 ---------- */

// path 语义：书签 = 所在文件夹路径；文件夹 = 含自身的完整路径。
function addPaths(tree) {
  (function walk(children, prefix) {
    for (const n of children || []) {
      const self = prefix.concat(n.title || "");
      if (n.children) { n.path = self.join(" > "); walk(n.children, self); }
      else { n.path = prefix.join(" > "); }
    }
  })((tree[0] && tree[0].children) || [], []);
  return tree;
}

export async function ensureTree(fresh) {
  if (!fresh && treeCache) return treeCache;
  treeCache = addPaths(await bm().getTree());
  return treeCache;
}

function indexById(tree) {
  const idx = new Map();
  (function walk(nodes) {
    for (const n of nodes || []) {
      idx.set(n.id, n);
      if (n.children) walk(n.children);
    }
  })(tree);
  return idx;
}

/* ---------- 快照 / 恢复（撤销基础；只存在于扩展存储，不进书签树） ---------- */

async function snapshotNodes(rootIds) {
  const out = [];
  async function walk(id) {
    let node;
    try { node = (await bm().get(id))[0]; } catch (e) { return; }
    if (!node) return;
    out.push({ id: node.id, parentId: node.parentId, index: node.index, title: node.title || "", url: node.url || "" });
    if (!node.url) {
      const kids = await bm().getChildren(id);
      for (const k of kids) await walk(k.id);
    }
  }
  for (const id of rootIds) await walk(id);
  return out;
}

async function restoreSnapshot(nodes, onProgress) {
  const remap = new Map();
  const total = nodes.length;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const parentId = remap.get(n.parentId) || n.parentId;
    let alive = false;
    try { alive = !!(await bm().get(n.id))[0]; } catch (e) { alive = false; }
    if (alive) {
      try { await bm().move(n.id, { parentId, index: n.index }); } catch (e) { /* 尽力恢复 */ }
      markSelf(n.id, parentId);
      noteBulk(n.id, parentId);
      remap.set(n.id, n.id);
    } else {
      const c = await bm().create({ parentId, index: n.index, title: n.title, url: n.url || undefined });
      markSelf(c.id, parentId);
      noteBulk(c.id, parentId);
      remap.set(n.id, c.id);
    }
    if ((i + 1) % 25 === 0 || i === total - 1) {
      const p = { done: i + 1, total, restored: i + 1 };
      bulkProgress(p);
      if (onProgress) { try { onProgress(p); } catch (e) { /* ignore */ } }
    }
  }
  invalidateTree();
}

/* ---------- 操作注册表 ---------- */

const OPS = {
  "sys.ping": { fn: async () => ({ pong: true, t: Date.now() }) },

  "sys.status": {
    fn: async () => {
      const log = await readLog();
      const manifest = (globalThis.chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest() : null;
      return { version: manifest ? manifest.version : null, logEntries: log.length, treeCached: !!treeCache, bulk: getBulkStatus() };
    },
  },

  "sys.bulk.status": {
    fn: async () => getBulkStatus(),
  },

  "bookmark.tree": {
    fn: async ({ fresh = false } = {}) => {
      const wasCached = !fresh && !!treeCache;
      return { tree: await ensureTree(fresh), cached: wasCached };
    },
  },

  "bookmark.get": {
    fn: async ({ id } = {}) => {
      if (!id) throw new Error("缺少 id");
      const nodes = await bm().get(id);
      if (!nodes || !nodes[0]) return { node: null };
      const idx = indexById(await ensureTree(false));
      const cached = idx.get(id);
      return { node: nodes[0], path: cached ? cached.path : null };
    },
  },

  "bookmark.search": {
    fn: async ({ query, path: pathFilter, limit = 50 } = {}) => {
      if (!query || !String(query).trim()) throw new Error("缺少 query");
      const idx = indexById(await ensureTree(false));
      const raw = String(query).trim();
      const q = raw.toLowerCase();
      const cap = Math.min(Number(limit) || 50, 500);
      const num = /^\d+$/.test(raw);   // 纯数字查询：先按节点 ID 精确命中
      const idHits = [];
      const hits = [];
      for (const n of idx.values()) {
        const byId = num && String(n.id) === raw;
        const hay = ((n.title || "") + "\n" + (n.url || "")).toLowerCase();
        if (!byId && !hay.includes(q)) continue;
        if (pathFilter && !String(n.path || "").toLowerCase().includes(String(pathFilter).toLowerCase())) continue;
        const h = { id: n.id, title: n.title || "", url: n.url || "", path: n.path || "", isFolder: !n.url };
        if (byId) idHits.push(h); else hits.push(h);
        if (idHits.length + hits.length >= cap) break;
      }
      const all = idHits.concat(hits);   // ID 精确命中的排最前
      return { query: raw, count: all.length, capped: idHits.length + hits.length >= cap, hits: all };
    },
  },

  "bookmark.create": {
    mutating: true,
    fn: async ({ parentId, title, url, index } = {}) => {
      if (!parentId) throw new Error("缺少 parentId");
      const spec = { parentId, title: title || "" };
      if (url) spec.url = url;
      if (index !== undefined) spec.index = index;
      const created = await bm().create(spec);
      markSelf(created.id, parentId);
      invalidateTree();
      return {
        created,
        summary: `新建${url ? "书签" : "文件夹"}：${created.title || created.id}`,
        undo: { kind: "deleteCreated", ids: [created.id] },
      };
    },
  },

  // 批量新建：一次调用建一批（有 url 建书签，无 url 建文件夹），只记一笔操作日志。
  // 单项失败不中断整批，失败项原样回报。
  "bookmark.createMany": {
    mutating: true,
    fn: async ({ parentId, items } = {}, opts = {}) => {
      if (!parentId) throw new Error("缺少 parentId");
      const list = Array.isArray(items) ? items : [];
      if (!list.length) throw new Error("items 不能为空");
      const created = [];
      const failed = [];
      beginBulk("bookmark.createMany", list.length);
      try {
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          try {
            const spec = { parentId, title: (it && it.title) || "" };
            if (it && it.url) spec.url = String(it.url);
            const made = await bm().create(spec);
            markSelf(made.id, parentId);
            noteBulk(made.id, parentId);
            created.push({ id: made.id, title: made.title || "", url: made.url || null });
          } catch (e) {
            failed.push({ title: (it && it.title) || "", error: String((e && e.message) || e) });
          }
          if ((i + 1) % 10 === 0 || i === list.length - 1) {
            const p = { done: i + 1, total: list.length, created: created.length, failed: failed.length };
            bulkProgress(p);
            if (opts.onProgress) { try { opts.onProgress(p); } catch (e) { /* ignore */ } }
          }
        }
        invalidateTree();
        return {
          created,
          failed,
          total: list.length,
          summary: `批量新建 ${created.length} 项`,
          undo: { kind: "deleteCreated", ids: created.map((c) => c.id) },
        };
      } finally {
        endBulk({ done: list.length, total: list.length, created: created.length, failed: failed.length });
      }
    },
  },

  "bookmark.update": {
    mutating: true,
    fn: async ({ id, title, url } = {}) => {
      if (!id) throw new Error("缺少 id");
      const before = (await bm().get(id))[0];
      if (!before) throw new Error("书签不存在: " + id);
      const changes = {};
      if (title !== undefined) changes.title = title;
      if (url !== undefined && String(url)) changes.url = String(url);
      if (!Object.keys(changes).length) throw new Error("没有要修改的字段");
      const updated = await bm().update(id, changes);
      invalidateTree();
      return {
        updated,
        summary: `修改：${before.title || before.id}`,
        undo: { kind: "update", id, before: { title: before.title || "", url: before.url || null } },
      };
    },
  },

  "bookmark.move": {
    mutating: true,
    fn: async ({ id, parentId, index } = {}) => {
      if (!id || !parentId) throw new Error("缺少 id 或 parentId");
      const before = (await bm().get(id))[0];
      if (!before) throw new Error("书签不存在: " + id);
      // 日志里要写清「搬到哪」：缓存还没失效，顺手取目标文件夹的完整路径
      const to = indexById(await ensureTree(false)).get(String(parentId));
      const spec = { parentId };
      if (index !== undefined) spec.index = index;
      // 先记账再搬：书签事件可能在 await 期间就派发出来，晚一步记会把自己的移动当成外部移动
      markSelf(id, parentId);
      await bm().move(id, spec);
      invalidateTree();
      return {
        moved: id,
        summary: `移动：${before.title || before.id} → ${to ? to.path : parentId}`,
        undo: { kind: "move", id, before: { parentId: before.parentId, index: before.index } },
      };
    },
  },

  // 批量移动：一次调用内部完成整批（一次 getTree 取前像，再分块并发移动），只记一笔操作日志。
  "bookmark.moveMany": {
    mutating: true,
    fn: async ({ ids, parentId, chunk = 32 } = {}, opts = {}) => {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
      if (!list.length || !parentId) throw new Error("缺少 ids 或 parentId");
      const idx = new Map();
      (function walk(nodes) {
        for (const n of nodes || []) {
          idx.set(n.id, { parentId: n.parentId, index: n.index });
          if (n.children) walk(n.children);
        }
      })(await bm().getTree());
      const moves = [];
      for (const id of list) {
        const b = idx.get(id);
        if (b) moves.push({ id, parentId: b.parentId, index: b.index });
      }
      const startedAt = Date.now();
      let moved = 0;
      const failed = [];
      if (!moves.length) {
        return { moved: 0, failed, total: 0, summary: "批量移动 0 项", undo: { kind: "moveMany", moves } };
      }
      beginBulk("bookmark.moveMany", moves.length);
      try {
        // 先记账再搬：事件异步派发，批量耗时可能远超单条认领窗口。
        markSelf(list, parentId);
        for (const m of moves) noteBulk(m.id, parentId);
        const size = Math.max(1, Math.min(Number(chunk) || 32, 128));
        for (let i = 0; i < moves.length; i += size) {
          await Promise.all(moves.slice(i, i + size).map(async (m) => {
            try { await bm().move(m.id, { parentId }); moved++; }
            catch (e) { failed.push({ id: m.id, error: String((e && e.message) || e) }); }
          }));
          const p = { done: Math.min(i + size, moves.length), total: moves.length, moved, failed: failed.length };
          bulkProgress(p);
          if (opts.onProgress) { try { opts.onProgress(p); } catch (e) { /* ignore */ } }
          await new Promise((r) => setTimeout(r, 0));   // 让事件/控制请求有机会插队
        }
        invalidateTree();
        return {
          moved, failed, total: moves.length, elapsedMs: Date.now() - startedAt,
          summary: `批量移动 ${moved} 项`,
          undo: { kind: "moveMany", moves },
        };
      } finally {
        endBulk({ done: moves.length, total: moves.length, moved, failed: failed.length });
      }
    },
  },

  // 复制：节点（含整棵子树）复制到目标文件夹，层内保持原序；撤销=删掉所有复制品。
  "bookmark.copy": {
    mutating: true,
    fn: async ({ ids, parentId } = {}, opts = {}) => {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
      if (!list.length || !parentId) throw new Error("缺少 ids 或 parentId");
      const idx = new Map();
      (function walk(nodes) {
        for (const n of nodes || []) { idx.set(n.id, n); if (n.children) walk(n.children); }
      })(await bm().getTree());
      const roots = list.map((id) => idx.get(id)).filter(Boolean);
      if (!roots.length) throw new Error("要复制的节点不存在");
      let copied = 0;
      const failed = [];
      const created = [];
      beginBulk("bookmark.copy", roots.length);
      try {
        const copyInto = async (node, targetParent) => {
          const spec = { parentId: targetParent, title: node.title || "" };
          if (node.url) spec.url = node.url;
          const made = await bm().create(spec);
          markSelf(made.id, targetParent);   // 整棵子树都算我们写的，别被归位再搬一次
          noteBulk(made.id, targetParent);
          copied++;
          if (!node.url) for (const c of node.children || []) await copyInto(c, made.id);
          return made.id;
        };
        for (let i = 0; i < roots.length; i++) {
          const n = roots[i];
          try { created.push(await copyInto(n, parentId)); }
          catch (e) { failed.push({ id: n.id, error: String((e && e.message) || e) }); }
          const p = { done: i + 1, total: roots.length, copied, failed: failed.length };
          bulkProgress(p);
          if (opts.onProgress) { try { opts.onProgress(p); } catch (e) { /* ignore */ } }
          await new Promise((r) => setTimeout(r, 0));
        }
        markSelf(created, parentId);
        invalidateTree();
        return { copied, failed, created, total: roots.length, summary: `复制 ${copied} 项`, undo: { kind: "deleteCreated", ids: created } };
      } finally {
        endBulk({ done: roots.length, total: roots.length, copied, failed: failed.length });
      }
    },
  },

  // 删除 = 直接删除，与浏览器原生一致：书签树里立刻消失，不产生回收站或任何额外文件夹。
  // 安全网是不可见的：前像存在扩展存储里，失手可用 bookmark_undo_last 回放。
  "bookmark.remove": {
    mutating: true,
    fn: async ({ ids, dryRun = false } = {}, opts = {}) => {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
      if (!list.length) throw new Error("ids 不能为空");
      const nodes = await snapshotNodes(list);
      if (dryRun) {
        return { plan: true, willAffect: nodes.length, roots: nodes.filter((n) => list.includes(n.id)) };
      }
      let removed = 0;
      beginBulk("bookmark.remove", list.length);
      try {
        for (let i = 0; i < list.length; i++) {
          const id = list[i];
          const n = (await bm().get(id).catch(() => []))[0];
          if (n) {
            if (n.url) await bm().remove(id);
            else await bm().removeTree(id);
            removed++;
          }
          if ((i + 1) % 10 === 0 || i === list.length - 1) {
            const p = { done: i + 1, total: list.length, removed };
            bulkProgress(p);
            if (opts.onProgress) { try { opts.onProgress(p); } catch (e) { /* ignore */ } }
          }
        }
        invalidateTree();
        return { removed, total: list.length, summary: `删除 ${removed} 项`, undo: { kind: "restore", nodes } };
      } finally {
        endBulk({ done: list.length, total: list.length, removed });
      }
    },
  },

  "bookmark.undoLast": {
    mutating: true,
    fn: async (_args, opts = {}) => {
      const log = await readLog();
      let entry = null;
      while (log.length) {
        entry = log.pop();
        if (entry && entry.undo) break;
        entry = null;
      }
      if (!entry) throw new Error("没有可撤销的操作");
      const u = entry.undo;
      if (u.kind === "restore") {
        beginBulk("bookmark.undoLast", u.nodes.length);
        try {
          await restoreSnapshot(u.nodes, opts.onProgress);
        } finally {
          endBulk({ done: u.nodes.length, total: u.nodes.length });
        }
      } else if (u.kind === "move") {
        await bm().move(u.id, { parentId: u.before.parentId, index: u.before.index });
        markSelf(u.id, u.before.parentId);
      } else if (u.kind === "moveMany") {
        beginBulk("bookmark.undoLast", u.moves.length);
        let restored = 0;
        try {
          for (let i = 0; i < u.moves.length; i++) {
            const m = u.moves[i];
            try { await bm().move(m.id, { parentId: m.parentId, index: m.index }); restored++; } catch (e) { /* 尽力 */ }
            markSelf(m.id, m.parentId);
            noteBulk(m.id, m.parentId);
            if ((i + 1) % 25 === 0 || i === u.moves.length - 1) {
              const p = { done: i + 1, total: u.moves.length, restored };
              bulkProgress(p);
              if (opts.onProgress) { try { opts.onProgress(p); } catch (e) { /* ignore */ } }
            }
            await new Promise((r) => setTimeout(r, 0));
          }
          // 批量归位顺带新建的目标文件夹：搬回去后若已空，一并回收（不留空壳）
          for (const id of u.createdFolders || []) {
            try {
              const kids = await bm().getChildren(id);
              if (!kids.length) await bm().removeTree(id);
            } catch (e) { /* 尽力 */ }
          }
        } finally {
          endBulk({ done: u.moves.length, total: u.moves.length, restored });
        }
      } else if (u.kind === "update") {
        const dir = { title: u.before.title };
        if (u.before.url) dir.url = u.before.url;
        await bm().update(u.id, dir);
      } else if (u.kind === "deleteCreated") {
        beginBulk("bookmark.undoLast", u.ids.length);
        let removed = 0;
        try {
          for (let i = 0; i < u.ids.length; i++) {
            const id = u.ids[i];
            try {
              const n = (await bm().get(id))[0];
              if (n) {
                if (n.url) await bm().remove(id);
                else await bm().removeTree(id);
                removed++;
              }
            } catch (e) { /* 尽力 */ }
            if ((i + 1) % 10 === 0 || i === u.ids.length - 1) {
              const p = { done: i + 1, total: u.ids.length, removed };
              bulkProgress(p);
              if (opts.onProgress) { try { opts.onProgress(p); } catch (e) { /* ignore */ } }
            }
          }
        } finally {
          endBulk({ done: u.ids.length, total: u.ids.length, removed });
        }
      } else {
        throw new Error("该操作不支持撤销: " + u.kind);
      }
      await st().set({ [K.oplog]: log });
      invalidateTree();
      return { undone: entry.op, ts: entry.ts, summary: entry.summary };
    },
  },

  "log.tail": {
    fn: async ({ n = 20 } = {}) => {
      const log = await readLog();
      const take = Math.min(Number(n) || 20, LOG_CAP);
      return { total: log.length, entries: log.slice(-take).map((e) => ({ ts: e.ts, op: e.op, summary: e.summary })) };
    },
  },
};
