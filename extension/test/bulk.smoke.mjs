// 批量操作冒烟：长批量自写认领、迟到事件不外归位、bulk_status 不排队、控制操作不被慢写入阻塞。
// 跑法：node extension/test/bulk.smoke.mjs
import {
  execute, defineOps, beginBulk, noteBulk, endBulk,
  isSelfWrite, isBulkActive, getBulkStatus,
} from "../src/ops.js";
import { write, settleMove } from "../src/rules.js";

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
  const targetId = add(barId, "目标");
  const store = new Map();
  const bookmarks = {
    async getTree() { return [{ id: "0", title: "", children: kids("0").map(deep) }]; },
    async get(id) { if (id === "0") return [{ id: "0", title: "" }]; const n = N.get(id); return n ? [shallow(n)] : []; },
    async getChildren(pid) { return kids(pid).map(shallow); },
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
  return { chrome: { bookmarks, storage, runtime: { getManifest: () => ({ version: "test" }) } }, ids: { barId, targetId }, addExternal: (parentId, title, url) => add(parentId, title, url) };
}

const { chrome, ids, addExternal } = makeChrome();
globalThis.chrome = chrome;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  " + extra : "")); }
};

// 1. 批量标记超过 10 秒仍然认自己（原实现 10 秒 TTL 的回归）
{
  beginBulk("test.bulk", 1);
  noteBulk("fake-id", ids.targetId);
  const realNow = Date.now;
  Date.now = () => realNow() + 20000;
  ok("批量标记超过 10 秒仍被认领", isSelfWrite("fake-id", ids.targetId) === true);
  ok("不同父目录不会被误认", isSelfWrite("fake-id", ids.barId) === false);
  Date.now = realNow;
  ok("批量进行中状态正确", isBulkActive() === true);
  endBulk({ done: 1, total: 1 });
  ok("批量结束后状态归零、留认领宽限", isBulkActive() === false && isSelfWrite("fake-id", ids.targetId) === true);
}

// 2. 批量移动 + 进度 + 迟到 onMoved 不再归位
{
  await write({
    enabled: true,
    fallback: { enabled: false, path: "收藏夹栏" },
    list: [{ match: { type: "host", value: "example.com" }, target: "收藏夹栏 > 目标" }],
  });
  const idsToMove = [];
  for (let i = 0; i < 120; i++) idsToMove.push(addExternal(ids.barId, "条目" + i, `https://example.com/item/${i}`));
  const progresses = [];
  const r = await execute("bookmark.moveMany", { ids: idsToMove, parentId: ids.targetId, chunk: 8 }, {
    onProgress: (p) => progresses.push(p),
  });
  const first = (await execute("bookmark.get", { id: idsToMove[0] })).node;
  const late = await settleMove(idsToMove[0], ids.targetId);
  ok("批量移动完成", r.moved === 120 && r.failed.length === 0 && first && first.parentId === ids.targetId);
  ok("批量进度持续上报", progresses.length >= 2 && progresses[progresses.length - 1].done === 120);
  ok("迟到 onMoved 不再被归位", late === null, `late=${late}`);
  const st = await execute("sys.bulk.status", {});
  ok("bulk_status 能读到最近一次批量结果",
     st.status === "done" && st.total === 120 && st.done === 120 && st.active === false, JSON.stringify(st));
  ok("批量结束后 isSelfWrite 仍认领刚才的 id", isSelfWrite(idsToMove[0], ids.targetId) === true);
}

// 3. 控制操作不被慢写入阻塞（状态/重连/规则读取必须能插队）
{
  defineOps({
    "test.slow": { fn: async () => { await new Promise((r) => setTimeout(r, 80)); return { ok: true }; } },
  });
  const slow = execute("test.slow", {});
  await new Promise((r) => setTimeout(r, 10));
  const t0 = Date.now();
  const pong = await execute("sys.ping", {});
  const dt = Date.now() - t0;
  await slow;
  ok("控制操作不被慢写入阻塞", pong.pong === true && dt < 30, `dt=${dt}ms`);
}

// 4. 批量新建也走批量上下文与进度
{
  const progresses = [];
  const r = await execute("bookmark.createMany", {
    parentId: ids.targetId,
    items: [{ title: "批建A", url: "https://a.example/" }, { title: "批建B" }],
  }, { onProgress: (p) => progresses.push(p) });
  const st = getBulkStatus();
  ok("批量新建完成并进入批量状态",
     r.created.length === 2 && r.failed.length === 0 && st.op === "bookmark.createMany" && st.status === "done" && progresses.length >= 1,
     JSON.stringify(st));
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
