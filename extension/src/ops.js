// 统一操作层：人（管理器 UI）与 Agent（经桥）走同一条管线。
// 同一注册表、同一串行队列、同一份操作日志、同一套安全闸。
// 原则：所有操作完全在书签机制内完成——不创建任何额外文件夹，删除就是删除。

import { K } from "./keys.js";

const LOG_CAP = 300;

let treeCache = null;
let tail = Promise.resolve();

const bm = () => globalThis.chrome.bookmarks;
const st = () => globalThis.chrome.storage.local;

export function invalidateTree() { treeCache = null; }

// 扩展自己写入期间置位。rules.autoRoute 靠它区分「我们建的」与「用户收藏的」——
// 否则自动归位会把自己刚建好的条目再搬一次。execute 是唯一的写入入口，所以这里置位就够。
let internal = 0;

export function isInternalWrite() { return internal > 0; }

// 我们自己写过的书签：记「这是我们的动作，写进去时父目录是谁」。
// 书签事件是异步派发的，处理器跑起来时 internal 计数可能已经归零，所以要在事件里认领自己那一下。
// 认领口径是父目录，不能只按 id 一刀切：那样会把浏览器随后对同一条书签的挪动也当成自己的而漏掉。
const selfWrites = new Map();

function markSelf(ids, parentId) {
  const ts = Date.now();
  for (const id of [].concat(ids)) selfWrites.set(String(id), { parentId: String(parentId), ts });
}

export function isSelfWrite(id, parentId) {
  const r = selfWrites.get(String(id));
  if (!r) return false;
  if (Date.now() - r.ts > 10000) { selfWrites.delete(String(id)); return false; }
  return parentId !== undefined && parentId !== null && String(parentId) === r.parentId;
}

export function execute(op, args = {}) {
  const p = tail.then(async () => {
    internal++;
    try { return await dispatch(String(op || ""), args || {}); }
    finally { internal--; }
  });
  tail = p.then(() => {}, () => {});
  return p;
}

export function defineOps(map) { Object.assign(OPS, map); }

async function dispatch(op, args) {
  const h = OPS[op];
  if (!h) throw new Error("未知操作: " + op);
  const result = await h.fn(args);
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

async function ensureTree(fresh) {
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

async function restoreSnapshot(nodes) {
  const remap = new Map();
  for (const n of nodes) {
    const parentId = remap.get(n.parentId) || n.parentId;
    let alive = false;
    try { alive = !!(await bm().get(n.id))[0]; } catch (e) { alive = false; }
    if (alive) {
      try { await bm().move(n.id, { parentId, index: n.index }); } catch (e) { /* 尽力恢复 */ }
      markSelf(n.id, parentId);
      remap.set(n.id, n.id);
    } else {
      const c = await bm().create({ parentId, index: n.index, title: n.title, url: n.url || undefined });
      markSelf(c.id, parentId);
      remap.set(n.id, c.id);
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
      return { version: manifest ? manifest.version : null, logEntries: log.length, treeCached: !!treeCache };
    },
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
    fn: async ({ parentId, items } = {}) => {
      if (!parentId) throw new Error("缺少 parentId");
      const list = Array.isArray(items) ? items : [];
      if (!list.length) throw new Error("items 不能为空");
      const created = [];
      const failed = [];
      for (const it of list) {
        try {
          const spec = { parentId, title: (it && it.title) || "" };
          if (it && it.url) spec.url = String(it.url);
          const made = await bm().create(spec);
          created.push({ id: made.id, title: made.title || "", url: made.url || null });
        } catch (e) {
          failed.push({ title: (it && it.title) || "", error: String((e && e.message) || e) });
        }
      }
      markSelf(created.map((c) => c.id), parentId);
      invalidateTree();
      return {
        created,
        failed,
        summary: `批量新建 ${created.length} 项`,
        undo: { kind: "deleteCreated", ids: created.map((c) => c.id) },
      };
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
    fn: async ({ ids, parentId, chunk = 64 } = {}) => {
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
      let moved = 0;
      const failed = [];
      markSelf(list, parentId);
      const size = Math.max(1, Math.min(Number(chunk) || 64, 256));
      for (let i = 0; i < moves.length; i += size) {
        await Promise.all(moves.slice(i, i + size).map(async (m) => {
          try { await bm().move(m.id, { parentId }); moved++; }
          catch (e) { failed.push({ id: m.id, error: String((e && e.message) || e) }); }
        }));
      }
      invalidateTree();
      return { moved, failed, summary: `批量移动 ${moved} 项`, undo: { kind: "moveMany", moves } };
    },
  },

  // 复制：节点（含整棵子树）复制到目标文件夹，层内保持原序；撤销=删掉所有复制品。
  "bookmark.copy": {
    mutating: true,
    fn: async ({ ids, parentId } = {}) => {
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
      const copyInto = async (node, targetParent) => {
        const spec = { parentId: targetParent, title: node.title || "" };
        if (node.url) spec.url = node.url;
        const made = await bm().create(spec);
        markSelf(made.id, targetParent);   // 整棵子树都算我们写的，别被归位再搬一次
        copied++;
        if (!node.url) for (const c of node.children || []) await copyInto(c, made.id);
        return made.id;
      };
      for (const n of roots) {
        try { created.push(await copyInto(n, parentId)); }
        catch (e) { failed.push({ id: n.id, error: String((e && e.message) || e) }); }
      }
      markSelf(created, parentId);
      invalidateTree();
      return { copied, failed, created, summary: `复制 ${copied} 项`, undo: { kind: "deleteCreated", ids: created } };
    },
  },

  // 删除 = 直接删除，与浏览器原生一致：书签树里立刻消失，不产生回收站或任何额外文件夹。
  // 安全网是不可见的：前像存在扩展存储里，失手可用 bookmark_undo_last 回放。
  "bookmark.remove": {
    mutating: true,
    fn: async ({ ids, dryRun = false } = {}) => {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
      if (!list.length) throw new Error("ids 不能为空");
      const nodes = await snapshotNodes(list);
      if (dryRun) {
        return { plan: true, willAffect: nodes.length, roots: nodes.filter((n) => list.includes(n.id)) };
      }
      let removed = 0;
      for (const id of list) {
        const n = (await bm().get(id).catch(() => []))[0];
        if (!n) continue;
        if (n.url) await bm().remove(id);
        else await bm().removeTree(id);
        removed++;
      }
      invalidateTree();
      return { removed, summary: `删除 ${removed} 项`, undo: { kind: "restore", nodes } };
    },
  },

  "bookmark.undoLast": {
    mutating: true,
    fn: async () => {
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
        await restoreSnapshot(u.nodes);
      } else if (u.kind === "move") {
        await bm().move(u.id, { parentId: u.before.parentId, index: u.before.index });
        markSelf(u.id, u.before.parentId);
      } else if (u.kind === "moveMany") {
        for (const m of u.moves) {
          try { await bm().move(m.id, { parentId: m.parentId, index: m.index }); } catch (e) { /* 尽力 */ }
          markSelf(m.id, m.parentId);
        }
      } else if (u.kind === "update") {
        const dir = { title: u.before.title };
        if (u.before.url) dir.url = u.before.url;
        await bm().update(u.id, dir);
      } else if (u.kind === "deleteCreated") {
        for (const id of u.ids) {
          try {
            const n = (await bm().get(id))[0];
            if (!n) continue;
            if (n.url) await bm().remove(id);
            else await bm().removeTree(id);
          } catch (e) { /* 尽力 */ }
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
