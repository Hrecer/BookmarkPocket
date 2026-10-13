// 规则引擎冒烟：匹配语义、优先级与兜底、脏数据归一、以及「收藏一落地就归位」。
// 跑法：node extension/test/rules.smoke.mjs
import { execute, defineOps, invalidateTree, isInternalWrite } from "../src/ops.js";
import { normalize, matches, pickTarget, read, write, autoRoute, settleMove } from "../src/rules.js";

function makeChrome() {
  let seq = 1;
  const N = new Map();
  const kids = (pid) => [...N.values()].filter((n) => n.parentId === pid).sort((a, b) => a.index - b.index);
  function add(parentId, title, url = null) {
    const id = String(seq++);
    N.set(id, { id, parentId, title, url, index: kids(parentId).length });
    return id;
  }
  const shallow = (n) => ({ id: n.id, parentId: n.parentId, title: n.title, url: n.url === null ? undefined : n.url, index: n.index });
  const deep = (n) => {
    const o = { id: n.id, parentId: n.parentId, title: n.title, index: n.index };
    if (n.url !== null) o.url = n.url;
    else o.children = kids(n.id).map(deep);
    return o;
  };

  const barId = add("0", "收藏夹栏");
  const catId = add(barId, "示例分类");
  const store = new Map();

  const bookmarks = {
    async getTree() { return [{ id: "0", title: "", children: kids("0").map(deep) }]; },
    async get(id) { if (id === "0") return [{ id: "0", title: "" }]; const n = N.get(id); return n ? [shallow(n)] : []; },
    async create(spec) {
      const id = add(spec.parentId, spec.title || "", spec.url || null);
      return { id, parentId: spec.parentId, title: spec.title || "", url: spec.url };
    },
    async move(id, spec) {
      const n = N.get(id);
      if (!n) throw new Error("no node " + id);
      n.parentId = spec.parentId;
      n.index = spec.index === undefined ? kids(spec.parentId).length : spec.index;
      return shallow(n);
    },
    async update(id, ch) { const n = N.get(id); if (ch.title !== undefined) n.title = ch.title; return shallow(n); },
    async remove(id) { N.delete(id); },
    async removeTree(id) { N.delete(id); },
  };
  const storage = {
    local: {
      async get(keys) {
        const out = {};
        for (const k of typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {})) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) { for (const k of Object.keys(obj)) store.set(k, obj[k]); },
    },
  };
  return {
    chrome: { bookmarks, storage, runtime: { getManifest: () => ({ version: "test" }) } },
    ids: { barId, catId },
    addExternal: (parentId, title, url) => add(parentId, title, url),
  };
}

const { chrome, ids, addExternal } = makeChrome();
globalThis.chrome = chrome;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  " + extra : "")); }
};

// 1. 匹配语义
{
  const host = { id: "a", enabled: true, match: { type: "host", value: "example.com" }, target: "X" };
  ok("域名匹配：主站与子域都算",
     matches(host, "https://www.example.com/class/1.html") && matches(host, "https://center.example.com/601015/"));
  ok("域名匹配：不是这个域就不算",
     !matches(host, "https://notexample.com/") && !matches(host, "https://example.com.evil.example/"));

  const frag = { id: "b", enabled: true, match: { type: "url", value: "example.com/class" }, target: "X" };
  ok("网址片段匹配（能按路径细分）",
     matches(frag, "https://www.example.com/class/3391.html") && !matches(frag, "https://www.example.com/author/1.html"));

  ok("停用的规则不参与", !matches({ ...host, enabled: false }, "https://www.example.com/"));
}

// 2. 优先级与兜底
const base = normalize({
  enabled: true,
  fallback: { enabled: true, path: "收藏夹栏" },
  list: [
    { match: { type: "url", value: "example.com/class" }, target: "收藏夹栏 > 示例分类 > 子目录" },
    { match: { type: "host", value: "example.com" }, target: "收藏夹栏 > 示例分类" },
  ],
});
{
  ok("自上而下先命中先用", pickTarget(base, "https://www.example.com/class/1.html") === "收藏夹栏 > 示例分类 > 子目录");
  ok("后面的规则兜住同域其他页面", pickTarget(base, "https://www.example.com/author/1.html") === "收藏夹栏 > 示例分类");
  ok("都没命中走兜底", pickTarget(base, "https://example.org/") === "收藏夹栏");
  ok("总开关关掉：一律不动", pickTarget({ ...base, enabled: false }, "https://www.example.com/class/1.html") === null);
  ok("兜底关掉且没命中：不动", pickTarget({ ...base, fallback: { enabled: false, path: "x" } }, "https://example.org/") === null);
}

// 3. 脏数据归一
{
  const c = normalize({
    enabled: "",
    list: [{ match: { type: "nope", value: "a" }, target: "t" }, { match: { value: "" }, target: "t" }, null],
  });
  ok("残缺规则被清掉、type 归一到 host", c.list.length === 1 && c.list[0].match.type === "host");
  ok("缺字段回默认（开启 + 兜底收藏夹栏）", c.enabled === true && c.fallback.enabled === true && c.fallback.path === "收藏夹栏");
}

// 4. 没存过时读出默认
{
  const c = await read();
  ok("默认就是全开 + 兜底收藏夹栏", c.enabled === true && c.fallback.enabled === true && c.fallback.path === "收藏夹栏");
}

// 5. execute 期间被标为内部写入（否则自动归位会把自己建的东西再搬一次）
{
  let inside = null;
  defineOps({ "test.probe": { fn: async () => { inside = isInternalWrite(); return {}; } } });
  await execute("test.probe", {});
  ok("execute 期间是内部写入状态", inside === true);
  ok("execute 之外不是", isInternalWrite() === false);
}

// 6. 收藏一落地就归位
{
  await write({
    enabled: true,
    fallback: { enabled: true, path: "收藏夹栏" },
    list: [{ match: { type: "host", value: "test.example" }, target: "收藏夹栏 > 临时 > 深一层" }],
  });

  const id = addExternal(ids.barId, "某条目", "https://sub.test.example/mod/1");
  invalidateTree();
  const path = await autoRoute(id, { id, url: "https://sub.test.example/mod/1", parentId: ids.barId });
  const moved = (await execute("bookmark.get", { id })).node;
  const mid = await execute("bookmark.search", { query: "深一层" });
  ok("命中规则：搬到目标，缺失的中间层会建出来",
     path === "收藏夹栏 > 临时 > 深一层" && moved && moved.parentId !== ids.barId && mid.count === 1,
     `path=${path} parent=${moved && moved.parentId} mid=${mid.count}`);

  const id2 = addExternal(ids.barId, "别的站", "https://other.example/x");
  invalidateTree();
  const r2 = await autoRoute(id2, { id: id2, url: "https://other.example/x", parentId: ids.barId });
  ok("已在该去的地方就不白搬一次", r2 === null);

  const id3 = addExternal(ids.catId, "文件夹不管", null);
  const r3 = await autoRoute(id3, { id: id3, parentId: ids.catId });
  ok("文件夹不参与归位", r3 === null);
}

// 7. 总开关关掉后不再动
{
  await write({ enabled: false, fallback: { enabled: true, path: "收藏夹栏" }, list: [] });
  const id = addExternal(ids.barId, "关掉后", "https://sub.test.example/mod/9");
  invalidateTree();
  const r = await autoRoute(id, { id, url: "https://sub.test.example/mod/9", parentId: ids.barId });
  const n = (await execute("bookmark.get", { id })).node;
  ok("总开关关掉：新收藏原地不动", r === null && n && n.parentId === ids.barId);
}

// 8. 浏览器自己挪的书签，也按规则摆回去
{
  await write({
    enabled: true,
    fallback: { enabled: true, path: "收藏夹栏" },
    list: [{ match: { type: "host", value: "test.example" }, target: "收藏夹栏 > 示例分类 > 子目录" }],
  });

  // 原生移动：只改 parentId，不经 ops（收藏弹窗里改文件夹后确认 / 原生管理器拖动都长这样）
  const id = addExternal(ids.barId, "被浏览器挪走的", "https://sub.test.example/mod/2");
  await chrome.bookmarks.move(id, { parentId: ids.catId });
  invalidateTree();
  const p = await settleMove(id);
  const n = (await execute("bookmark.get", { id })).node;
  ok("浏览器挪到错的地方：按规则摆回去",
     p === "收藏夹栏 > 示例分类 > 子目录" && n && n.parentId !== ids.catId,
     `p=${p} parent=${n && n.parentId}`);

  // 我们自己搬的（管理器里拖动 / 撤销）：位置是用户明确指定的，规则不抢
  const id2 = addExternal(ids.barId, "我们自己搬的", "https://sub.test.example/mod/3");
  await execute("bookmark.move", { id: id2, parentId: ids.catId });
  const r2 = await settleMove(id2, ids.catId);
  const n2 = (await execute("bookmark.get", { id: id2 })).node;
  ok("我们自己搬的书签：规则不抢回去",
     r2 === null && n2 && n2.parentId === ids.catId,
     `r=${r2} parent=${n2 && n2.parentId}`);

  // 同一条书签随后又被浏览器挪走：不能因为我们刚搬过它就放过
  await chrome.bookmarks.move(id2, { parentId: ids.barId });
  invalidateTree();
  const r3 = await settleMove(id2, ids.barId);
  const n3 = (await execute("bookmark.get", { id: id2 })).node;
  ok("随后被浏览器挪走：照样按规则摆回去",
     r3 === "收藏夹栏 > 示例分类 > 子目录" && n3 && n3.parentId !== ids.barId,
     `r=${r3} parent=${n3 && n3.parentId}`);

  // 归位要留痕：外部移动、以及「已在位」的判定，都要能在日志里查到
  const tail = await execute("log.tail", { n: 20 });
  const sums = tail.entries.map((e) => e.summary || "");
  ok("外部移动写进了操作日志",
     tail.entries.some((e) => e.op === "rules.settle" && e.summary.indexOf("外部移动") === 0),
     sums.join(" | "));
  ok("「已在位」的判定也留痕",
     tail.entries.some((e) => e.op === "rules.route" && e.summary.indexOf("归位检查") === 0),
     sums.join(" | "));

  // 复制出来的整棵子树也是「我们写的」：里面的叶子不该被规则再搬走
  const pack = addExternal(ids.catId, "整包", null);
  const inner = addExternal(pack, "包里的条目", "https://sub.test.example/inside");
  invalidateTree();
  await execute("bookmark.copy", { ids: [pack], parentId: ids.barId });
  const hit = (await execute("bookmark.search", { query: "包里的条目" })).hits.find((h) => h.id !== inner);
  const cn = hit && (await execute("bookmark.get", { id: hit.id })).node;
  const rc = cn ? await autoRoute(cn.id, cn) : "no-copy";
  ok("复制出来的子树：叶子不会被规则再搬走", rc === null, `r=${rc} hit=${hit && hit.id}`);
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);