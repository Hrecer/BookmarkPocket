// 操作层冒烟测试：mock chrome.bookmarks / chrome.storage.local，直接在 Node 里验证核心语义。
// 跑法：node extension/test/ops.smoke.mjs
import { execute } from "../src/ops.js";

function makeChrome() {
  let seq = 1;
  const N = new Map(); // id -> {id,parentId,title,url,index}
  const kids = (pid) => [...N.values()].filter((n) => n.parentId === pid).sort((a, b) => a.index - b.index);

  function add(parentId, title, url = null, index) {
    const id = String(seq++);
    const list = kids(parentId);
    const ix = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
    for (const s of list) if (s.index >= ix) s.index++;
    N.set(id, { id, parentId, title, url, index: ix });
    return id;
  }

  const shallow = (n) => ({ id: n.id, parentId: n.parentId, title: n.title, url: n.url === null ? undefined : n.url, index: n.index });
  const deep = (n) => {
    const o = { id: n.id, parentId: n.parentId, title: n.title, index: n.index, dateAdded: n.dateAdded };
    if (n.url !== null) o.url = n.url;
    else o.children = kids(n.id).map(deep);
    return o;
  };

  const barId = add("0", "收藏夹栏");
  const otherId = add("0", "其他收藏夹");
  add("0", "已同步");
  const f1 = add(barId, "新闻", null);
  const aId = add(f1, "站点A", "https://a.example/1");
  const bId = add(barId, "站点B", "https://b.example/2");
  const cId = add(barId, "站点C", "https://c.example/3");

  const bookmarks = {
    async getTree() { return [{ id: "0", title: "", children: kids("0").map(deep) }]; },
    async get(id) {
      if (id === "0") return [{ id: "0", title: "" }];
      const n = N.get(id);
      return n ? [shallow(n)] : [];
    },
    async getChildren(pid) { return kids(pid).map(shallow); },
    async search(q) {
      const t = String(q);
      return [...N.values()].filter((n) => (n.title || "").includes(t) || (n.url || "").includes(t)).map(shallow);
    },
    async create(spec) {
      const id = add(spec.parentId, spec.title || "", spec.url || null, spec.index);
      return { id, parentId: spec.parentId, title: spec.title || "", url: spec.url };
    },
    async move(id, spec) {
      const n = N.get(id);
      if (!n) throw new Error("no node " + id);
      n.parentId = spec.parentId;
      n.index = spec.index === undefined ? kids(spec.parentId).length : spec.index;
      return shallow(n);
    },
    async update(id, ch) {
      const n = N.get(id);
      if (!n) throw new Error("no node " + id);
      if (ch.title !== undefined) n.title = ch.title;
      if (ch.url !== undefined) n.url = ch.url;
      return shallow(n);
    },
    async remove(id) {
      const n = N.get(id);
      if (!n) throw new Error("no node " + id);
      if (!n.url) throw new Error("folders must be removed with removeTree");
      N.delete(id);
    },
    async removeTree(id) {
      for (const k of kids(id)) await bookmarks.removeTree(k.id);
      N.delete(id);
    },
  };

  const store = new Map();
  const storage = {
    local: {
      async get(keys) {
        const out = {};
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
        for (const k of list) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) { for (const k of Object.keys(obj)) store.set(k, obj[k]); },
    },
  };

  return { chrome: { bookmarks, storage, runtime: { getManifest: () => ({ version: "test" }) } }, ids: { barId, otherId, f1, aId, bId, cId } };
}

const { chrome, ids } = makeChrome();
globalThis.chrome = chrome;
let bId = ids.bId; // 删除后撤销=重建，浏览器会分配新 id，测试里需重新解析

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  " + extra : "")); }
}

// 1. 树 + path
{
  const { tree } = await execute("bookmark.tree", {});
  const bar = tree[0].children.find((n) => n.id === ids.barId);
  const folder = bar.children.find((n) => n.id === ids.f1);
  const leaf = folder.children.find((n) => n.id === ids.aId);
  ok("树读取 + path 计算（书签=所在文件夹；文件夹=含自身完整路径）",
     bar.title === "收藏夹栏" && folder.path === "收藏夹栏 > 新闻" && leaf.path === "收藏夹栏 > 新闻",
     `folder.path=${folder && folder.path}`);
}

// 2. 搜索
{
  const r = await execute("bookmark.search", { query: "站点a" });
  ok("搜索（不区分大小写，带 path）", r.count === 1 && r.hits[0].id === ids.aId && r.hits[0].path === "收藏夹栏 > 新闻");
}

// 3. dryRun 只预演
{
  const r = await execute("bookmark.remove", { ids: [bId], dryRun: true });
  const still = (await execute("bookmark.get", { id: bId })).node;
  ok("dryRun 只预演不动数据", r.plan === true && r.willAffect === 1 && !!still);
}

// 4. 直接删除：书签立刻消失 + 撤销恢复（重建后 id 会变，内容/位置一致）
{
  const r = await execute("bookmark.remove", { ids: [bId] });
  const gone = (await execute("bookmark.get", { id: bId })).node;
  await execute("bookmark.undoLast", {});
  const found = await execute("bookmark.search", { query: "站点B" });
  ok("直接删除（树里立刻消失）+ 撤销恢复",
     r.removed === 1 && gone === null && found.count === 1 && found.hits[0].path === "收藏夹栏",
     `found=${found.count}`);
  bId = found.hits[0].id;
}

// 5. 移动 + 撤销
{
  await execute("bookmark.move", { id: bId, parentId: ids.f1 });
  await execute("bookmark.undoLast", {});
  const n = (await execute("bookmark.get", { id: bId })).node;
  ok("移动 + 撤销", n && n.parentId === ids.barId);
}

// 6. 改名 + 撤销
{
  await execute("bookmark.update", { id: bId, title: "改过的标题" });
  const t1 = (await execute("bookmark.get", { id: bId })).node.title;
  await execute("bookmark.undoLast", {});
  const t2 = (await execute("bookmark.get", { id: bId })).node.title;
  ok("改名 + 撤销", t1 === "改过的标题" && t2 === "站点B");
}

// 7. 删除文件夹（整树带走）+ 撤销重建（含子项）
{
  const before = (await execute("bookmark.search", { query: "站点" })).count;
  const r = await execute("bookmark.remove", { ids: [ids.f1] });
  const folderGone = (await execute("bookmark.get", { id: ids.f1 })).node;
  const childGone = (await execute("bookmark.get", { id: ids.aId })).node;
  await execute("bookmark.undoLast", {});
  const after = (await execute("bookmark.search", { query: "站点" })).count;
  ok("删除文件夹整树 + 撤销可重建", r.removed === 1 && folderGone === null && childGone === null && after === before,
     `before=${before} after=${after}`);
}

// 8. 关键回归：操作完全在书签机制内——不产生回收站/任何额外文件夹
{
  const recycle = await execute("bookmark.search", { query: "回收站" });
  const { tree } = await execute("bookmark.tree", { fresh: true });
  const roots = tree[0].children.map((n) => n.title);
  ok("书签树内不产生任何额外文件夹（无回收站）", recycle.count === 0 && roots.length === 3, `roots=${roots.join("/")}`);
}

// 9. 串行队列：并发下发按序执行（删除 + 立即撤销 必须成立）
{
  const p1 = execute("bookmark.remove", { ids: [bId] });
  const p2 = execute("bookmark.undoLast", {});
  await Promise.all([p1, p2]);
  const found = await execute("bookmark.search", { query: "站点B" });
  ok("串行队列（并发下发按序执行）", found.count === 1 && found.hits[0].path === "收藏夹栏", `found=${found.count}`);
  bId = found.hits[0].id;
}

// 10. 操作日志
{
  await execute("bookmark.create", { parentId: ids.barId, title: "临时条目", url: "https://tmp.example/" });
  const r = await execute("log.tail", { n: 5 });
  const last = r.entries[r.entries.length - 1];
  ok("操作日志可读（最近一条为 create）", r.total >= 1 && last && last.op === "bookmark.create");
}

// 11. create + 撤销
{
  await execute("bookmark.undoLast", {});
  const goneLive = (await execute("bookmark.search", { query: "tmp.example" })).count;
  ok("create + 撤销（新建条目被移除）", goneLive === 0);
}

// 12. 未知操作
{
  let threw = false;
  try { await execute("no.such.op", {}); } catch (e) { threw = true; }
  ok("未知操作被拒绝", threw);
}

// 13. 批量移动（一次调用）+ 撤销
{
  const tmp = (await execute("bookmark.create", { parentId: ids.barId, title: "临时批移目标" })).created;
  const r = await execute("bookmark.moveMany", { ids: [bId, ids.cId], parentId: tmp.id });
  const a = (await execute("bookmark.get", { id: bId })).node;
  const b = (await execute("bookmark.get", { id: ids.cId })).node;
  ok("批量移动（一次调用整批完成）", r.moved === 2 && a && b && a.parentId === tmp.id && b.parentId === tmp.id);
  await execute("bookmark.undoLast", {});
  const a2 = (await execute("bookmark.get", { id: bId })).node;
  const b2 = (await execute("bookmark.get", { id: ids.cId })).node;
  ok("批量移动 + 撤销（各自回原位）", a2 && b2 && a2.parentId === ids.barId && b2.parentId === ids.barId,
     `a=${a2 && a2.parentId} b=${b2 && b2.parentId}`);
}

// 14. 批量新建 + 撤销
{
  const r = await execute("bookmark.createMany", {
    parentId: ids.barId,
    items: [{ title: "批建文件夹" }, { title: "批建书签", url: "https://many.example/" }],
  });
  const madeFolder = r.created.find((c) => c.title === "批建文件夹");
  const madeLink = r.created.find((c) => c.title === "批建书签");
  const folderNode = madeFolder && (await execute("bookmark.get", { id: madeFolder.id })).node;
  const linkNode = madeLink && (await execute("bookmark.get", { id: madeLink.id })).node;
  ok("批量新建（文件夹 + 书签一次建好）",
     r.created.length === 2 && r.failed.length === 0 && folderNode && !folderNode.url && linkNode && linkNode.url === "https://many.example/",
     JSON.stringify(r.failed));
  await execute("bookmark.undoLast", {});
  const left = (await execute("bookmark.search", { query: "many.example" })).count;
  const folderGone = madeFolder && (await execute("bookmark.get", { id: madeFolder.id })).node;
  ok("批量新建 + 撤销（整批移除）", left === 0 && folderGone === null);
}

// 15. 复制（整棵文件夹 + 单条链接）+ 撤销
{
  const tree0 = (await execute("bookmark.tree", {})).tree[0];
  let newsFolder = null;
  (function w(ns) { for (const n of ns || []) { if (!n.url) { if (n.title === "新闻") newsFolder = n; w(n.children); } } })(tree0.children);
  const before = (await execute("bookmark.search", { query: "站点A" })).count;
  const r = await execute("bookmark.copy", { ids: [newsFolder.id, bId], parentId: ids.otherId });
  const afterCopy = (await execute("bookmark.search", { query: "站点A" })).count;
  const other1 = (await execute("bookmark.tree", {})).tree[0].children.find((n) => n.id === ids.otherId);
  ok("复制（整棵文件夹 + 单条链接，落入目标）",
     r.copied === 3 && before === 1 && afterCopy === 2 && (other1.children || []).length === 2,
     `copied=${r.copied} other=${(other1.children || []).length}`);
  await execute("bookmark.undoLast", {});
  const other2 = (await execute("bookmark.tree", {})).tree[0].children.find((n) => n.id === ids.otherId);
  const afterUndo = (await execute("bookmark.search", { query: "站点A" })).count;
  ok("复制 + 撤销（复制品全部移除）", (other2.children || []).length === 0 && afterUndo === before,
     `left=${(other2.children || []).length} after=${afterUndo}`);
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
