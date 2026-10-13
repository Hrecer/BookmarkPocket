// 管理器页面冒烟测试：用桩 DOM + 桩 chrome 把 ui/manager.js 真跑起来，
// 覆盖启动、渲染、树展开、选择、详情栏、导航、增删改、撤销、搜索、外观。
// 跑法：node extension/test/manager.smoke.mjs
//
// 存在的意义：UI 层原本只有 ops/bridge/mcp 三套测试，页面本身零覆盖，
// 任何一次拆分/重构都只能靠肉眼。这里给页面装一张网。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 桩 DOM ---------------- */
let idSeq = 0;
const byId = new Map();
const allEls = [];

const VOID_TAGS = /^(img|input|br|hr|meta|link|source|col)$/i;

function mkEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    _id: ++idSeq,
    _listeners: {},
    _attrs: {},
    _classes: new Set(),
    _children: [],
    _html: "",
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    _text: "",
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    title: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    clientWidth: 0,
    tabIndex: 0,
    parentNode: null,
    _raf: 0,
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
    toggle: (c, on) => {
      const want = on === undefined ? !el._classes.has(c) : !!on;
      if (want) el._classes.add(c); else el._classes.delete(c);
      return want;
    },
  };
  el.setAttribute = (k, v) => { el._attrs[k] = String(v); if (k === "id") byId.set("#" + v, el); };
  el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null);
  el.removeAttribute = (k) => { delete el._attrs[k]; };
  el.hasAttribute = (k) => k in el._attrs;
  el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); };
  el.removeEventListener = (t, fn) => { const a = el._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  el.dispatch = (t, ev = {}) => {
    const e = { type: t, target: el, preventDefault() {}, stopPropagation() {}, key: "", clientX: 0, clientY: 0, button: 0, ...ev };
    (el._listeners[t] || []).slice().forEach((fn) => fn(e));
    return e;
  };
  el.appendChild = (c) => { if (!c) return c; el._children.push(c); c.parentNode = el; return c; };
  el.append = (...cs) => cs.forEach((c) => el.appendChild(c));
  el.insertBefore = (c) => el.appendChild(c);
  el.removeChild = (c) => { const i = el._children.indexOf(c); if (i >= 0) el._children.splice(i, 1); return c; };
  el.replaceChildren = (...cs) => { el._children = []; cs.forEach((c) => c && el.appendChild(c)); };
  el.remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };
  el.contains = (n) => n === el || el._children.some((c) => c.contains(n));
  el.closest = (sel) => (matchSel(el, sel) ? el : el.parentNode ? el.parentNode.closest(sel) : null);
  el.querySelector = (sel) => findIn(el, sel, true);
  el.querySelectorAll = (sel) => findIn(el, sel, false);
  el.getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 30, width: 100, height: 30 });
  el.focus = () => {}; el.select = () => {}; el.blur = () => {}; el.scrollIntoView = () => {};
  el.insertAdjacentHTML = (_, h) => parseHTML(h, el);
  Object.defineProperty(el, "textContent", {
    get: () => (el._children.length ? el._children.map((c) => c.textContent).join("") : el._text),
    set: (v) => { el._text = String(v); el._children = []; el._html = ""; },
  });
  Object.defineProperty(el, "className", {
    get: () => [...el._classes].join(" "),
    set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  Object.defineProperty(el, "children", { get: () => el._children });
  Object.defineProperty(el, "childNodes", { get: () => el._children });
  Object.defineProperty(el, "firstElementChild", { get: () => el._children[0] || null });
  Object.defineProperty(el, "innerHTML", {
    get: () => (el._text ? el._text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : el._html),
    set: (v) => { el._html = String(v); el._text = ""; el._children = []; parseHTML(el._html, el); },
  });
  allEls.push(el);
  return el;
}

/** 极简 HTML 解析：只处理「标签 + class/id/data-*」，够 manager 用的模板了 */
function parseHTML(html, target) {
  const stack = [target];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|[^>])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, attrs, selfClose] = m;
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const e = mkEl(tag);
    for (const a of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (a[1] === "class") a[2].split(/\s+/).forEach((c) => c && e.classList.add(c));
      else if (a[1] === "id") e.setAttribute("id", a[2]);
      else e.dataset[a[1]] = a[2];
    }
    stack[stack.length - 1].appendChild(e);
    if (!VOID_TAGS.test(tag) && !selfClose) stack.push(e);
  }
}

/** 选择器匹配：支持 tag / .class / #id / [attr] / [attr="v"] 的组合，忽略伪类与 :not */
function matchSel(el, sel) {
  return String(sel).split(",").some((raw) => {
    let s = raw.trim().replace(/:[a-zA-Z-]+(\([^)]*\))?/g, "");
    if (!s) return false;
    const tag = /^[a-zA-Z][\w-]*/.exec(s);
    if (tag && el.tagName !== tag[0].toUpperCase()) return false;
    for (const c of s.matchAll(/\.([\w-]+)/g)) if (!el._classes.has(c[1])) return false;
    for (const at of s.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      const key = at[1].replace(/-(\w)/g, (_, c) => c.toUpperCase());
      const v = key in el.dataset ? el.dataset[key] : el.getAttribute(at[1]);
      if (v === null || v === undefined) return false;
      if (at[2] !== undefined && String(v) !== at[2]) return false;
    }
    return true;
  });
}
function findIn(root, sel, one) {
  const out = [];
  (function walk(n) {
    for (const c of n._children) { if (matchSel(c, sel)) out.push(c); walk(c); }
  })(root);
  return one ? out[0] || null : out;
}

const document = {
  documentElement: mkEl("html"),
  body: mkEl("body"),
  createElement: (t) => mkEl(t),
  createDocumentFragment: () => mkEl("fragment"),
  querySelector: (sel) => (sel.startsWith("#") ? byId.get(sel) || null : findIn(document.body, sel, true)),
  querySelectorAll: (sel) => findIn(document.body, sel, false),
  addEventListener() {}, removeEventListener() {},
  readyState: "complete",
};

/* ---------------- 铺出 manager.html 的结构 ---------------- */
function el(sel, parent) {
  const tag = (/^[a-zA-Z][\w-]*/.exec(sel) || ["div"])[0];
  const e = mkEl(tag);
  const idm = /#([\w-]+)/.exec(sel);
  if (idm) e.setAttribute("id", idm[1]);
  for (const c of sel.matchAll(/\.([\w-]+)/g)) e.classList.add(c[1]);
  for (const a of sel.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) e.dataset[a[1]] = a[2] ?? "";
  (parent || document.body).appendChild(e);
  return e;
}
{
  const nav = el("nav#nav");
  el("span.nav-ind", nav);
  el("button.navitem[data-view=browse].active", nav);
  el("button.navitem[data-view=search]", nav);
  el("button.navitem[data-view=rules]", nav);
  el("button.navitem[data-view=settings]", nav);

  el("div.navrow");
  el("div.actionrow");

  const panes = el("div#panes.panes");
  const treePanel = el("aside.tree-panel", panes);
  el("div.panel-head", treePanel);
  const tree = el("div#tree.tree", treePanel);
  el("div#tspacer", tree);
  el("div#trows", tree);
  const crumbBar = el("div.crumbsbar");
  el("div#crumbs.crumbs", crumbBar);
  el("div#crumbs_holder", crumbBar);
  const card = el("section.list-card", panes);
  const head = el("div#listhead.list-head", card);
  el("button.col.col-name[data-sort=title]", head).appendChild(el("span.sortind"));
  el("div.col.col-url", head);
  el("button.col.col-date[data-sort=dateAdded]", head).appendChild(el("span.sortind"));
  const list = el("div#list.list", card);
  el("div#spacer", list);
  el("div#rows", list);
  el("div#empty", list);
  el("div#busy", list);
  el("div#splitter.splitter", panes);
  el("aside#details.details", panes);
  el("div#details2.details", panes);

  const sv = el("section#searchview.searchview");
  const bar = el("div.searchbar", sv);
  el("input#q", bar);
  el("button#btnSearchGo", bar);
  el("button#btnQCancel", bar);
  const chips = el("div.searchchips", sv);
  el("button.qchip[data-scope=title]", chips);
  el("button.qchip[data-scope=url]", chips);
  el("button.qchip[data-scope=path]", chips);
  const acts = el("div.actions", chips);
  el("button#btnJump", acts);
  el("button#btnQDelete", acts);
  const sp = el("div.searchpanes", sv);
  const card2 = el("section.list-card", sp);
  el("div.list-head", card2);
  const qlist = el("div#qlist.list", card2);
  el("div#qspacer", qlist);
  el("div#qrows", qlist);
  el("div#qempty.empty", qlist);
  el("p#qemptytitle.empty-title", byId.get("#qempty"));
  el("p#qemptydesc.empty-desc", byId.get("#qempty"));
  el("div#splitter2.splitter", sp);

  const stv = el("section#settingsview.settingsview");
  const c1 = el("div.spanel", stv);
  el("input#cfgPort", c1); el("input#cfgToken", c1); el("button#btnCfgPair", c1);
  el("button#btnCfgSave", c1); el("button#btnCfgReconnect", c1);
  el("span#cfgStatus", c1);
  el("div[data-theme-set=auto]", c1); el("div[data-theme-set=light]", c1); el("div[data-theme-set=dark]", c1);
  el("span#cfgExtId", c1); el("span#cfgOrigin", c1);
  const rv = el("section#rulesview.rulesview"); rv.hidden = true;
  const rc = el("div.card.spanel", rv);
  el("span#rvNote", rc); el("div#rvList.rvlist", rc); el("span#rvCount", rc); el("span#rvFbText", rc);
  el("button#btnRuleAdd[data-act=rule-add]", rc); el("button#btnFbPick[data-act=fb-pick]", rc);
  el("button.switch#swRules[data-rules-switch=1]", rc);
  el("button.switch#swFallback[data-fb-switch=1]", rc);

  const pk = el("div#pickOverlay.overlay"); pk.hidden = true;
  el("span#pickTitle", pk); el("div#pickList", pk); el("span#pickPath", pk);

  const ro = el("div#ruleOverlay.overlay"); ro.hidden = true;
  el("span#ruleHead", ro); el("input#ruleValue", ro); el("input#ruleTarget", ro); el("span#ruleHint", ro);

  el("div#confirmOverlay", document.body).hidden = true;
  el("div#cfTitle"); el("div#cfMsg"); el("button#cfOk"); el("button#cfCancel");
  el("div#editorOverlay", document.body).hidden = true;
  el("span#edHeadText"); el("input#edTitle"); el("input#edUrl"); el("button#edSave"); el("button#edCancel");
  el("div#ctxmenu", document.body).hidden = true;
  const status = el("div.statusbar");
  el("span#statusmsg", status);
  el("span#selpill", status).hidden = true;
  el("button#btnBack"); el("button#btnFwd"); el("button#btnUp");
  el("button#btnNewFolder"); el("button#btnNewLink"); el("button#btnRename"); el("button#btnDelete");
  el("span#bri"); el("span#britext"); el("div#bridgebox"); el("button#btnTheme");
  el("div#toast"); el("span#toastmsg"); el("button#toastaction");

  for (const id of ["tree", "list", "qlist"]) byId.get("#" + id).clientHeight = 600;
}
const $id = (id) => byId.get("#" + id);

/* ---------------- 桩 chrome ---------------- */
const bookmarkTree = {
  id: "0", title: "", children: [
    { id: "1", parentId: "0", title: "书签栏", children: [
      { id: "10", parentId: "1", title: "技术", children: [
        { id: "100", parentId: "10", title: "Rust 官网", url: "https://rust-lang.org", dateAdded: 1700000000000 },
      ] },
      { id: "11", parentId: "1", title: "Rust 官网", url: "https://rust-lang.org", dateAdded: 1700000000001 },
      { id: "12", parentId: "1", title: "MDN", url: "https://developer.mozilla.org", dateAdded: 1700000000002 },
    ] },
    { id: "2", parentId: "0", title: "其他书签", children: [] },
  ],
};
const storage = {};
const calls = [];
const chrome = {
  runtime: {
    id: "test-ext-id",
    getURL: (p) => "chrome-extension://test-ext-id" + p,
    sendMessage: async (msg) => {
      if (!msg || msg.channel !== "op") return undefined;
      calls.push(msg.op);
      const A = msg.args || {};
      switch (msg.op) {
        case "bookmark.tree": return { ok: true, data: { tree: [bookmarkTree], cached: false } };
        case "sys.bridge.status": return { ok: true, data: { connected: false, url: null, lastError: null } };
        case "sys.bridge.reconnect": return { ok: true, data: { connected: false, lastError: "无中枢" } };
        case "bookmark.create": return { ok: true, data: { created: { id: "900", title: A.title, parentId: A.parentId } } };
        case "bookmark.update": return { ok: true, data: { updated: true } };
        case "bookmark.remove": return { ok: true, data: { removed: (A.ids || []).length } };
        case "bookmark.move": return { ok: true, data: { moved: (A.ids || []).length } };
        case "bookmark.undo_last": return { ok: true, data: { undone: "bookmark.create" } };
        case "rules.get": return { ok: true, data: { enabled: true, fallback: { enabled: true, path: "收藏夹栏" }, list: [] } };
        case "rules.set": return { ok: true, data: Object.assign({ enabled: true, fallback: { enabled: true, path: "收藏夹栏" }, list: [] }, A.config) };
        default: return { ok: true, data: {} };
      }
    },
    onMessage: { addListener() {} },
  },
  storage: {
    local: {
      async get(k) { const out = {}; for (const key of [].concat(k)) if (key in storage) out[key] = storage[key]; return out; },
      async set(o) { Object.assign(storage, o); },
    },
  },
  bookmarks: { getTree: async () => [bookmarkTree] },
  alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
  tabs: { create() {} },
};

/* ---------------- 桩全局 ---------------- */
const rafQ = [];
globalThis.requestAnimationFrame = (fn) => { rafQ.push(fn); return rafQ.length; };
globalThis.cancelAnimationFrame = () => {};
const flushRaf = () => { let n = 0; while (rafQ.length && n++ < 50) rafQ.shift()(0); };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const lsMap = {};
globalThis.localStorage = { getItem: (k) => (k in lsMap ? lsMap[k] : null), setItem: (k, v) => { lsMap[k] = String(v); }, removeItem: (k) => { delete lsMap[k]; } };
globalThis.location = { hash: "" };
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.document = document;
globalThis.chrome = chrome;
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1600, innerHeight: 900, matchMedia: globalThis.matchMedia, requestAnimationFrame: globalThis.requestAnimationFrame, location: globalThis.location };

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("PASS  " + label); }
  else { fail++; console.log("FAIL  " + label + (extra ? "  → " + extra : "")); }
};

/* ---------------- 跑起来 ---------------- */
let M = null;
try {
  M = await import("../ui/manager.js");
  flushRaf();
  await new Promise((r) => setTimeout(r, 80));
  flushRaf();
  ok(true, "模块加载 + 启动无异常");
} catch (e) {
  ok(false, "模块加载 + 启动无异常", (e && e.stack ? String(e.stack).split("\n").slice(0, 2).join(" | ") : String(e)));
}

if (M) {
  const rowEls = () => $id("rows")._children.filter((c) => c._classes.has("row") && c.style.display !== "none");
  const treeEls = () => $id("trows")._children.filter((c) => c._classes.has("tnode") && c.style.display !== "none");

  console.log("\n— 启动首屏 —");
  ok(calls.includes("bookmark.tree"), "启动即请求书签树");
  // refresh() 内部是 try/catch + toast，出错时页面只是静静少渲染 —— 这里把它抓出来
  ok($id("toastmsg").textContent === "", "启动过程没有弹错误提示", $id("toastmsg").textContent);
  ok(rowEls().length > 0, "主列表铺出了行（" + rowEls().length + "）");
  ok(treeEls().length > 0, "侧栏铺出了节点（" + treeEls().length + "）");
  ok($id("crumbs")._children.length > 0, "面包屑已渲染");
  ok(calls.includes("sys.bridge.status"), "启动即查询桥状态");
  ok($id("spacer").style.height && $id("spacer").style.height.endsWith("px"), "滚动区高度已设定（" + $id("spacer").style.height + "）");

  console.log("\n— 树：展开 / 折叠 —");
  const n0 = treeEls().length;
  M.toggleExpand("1");
  flushRaf();
  const n1 = treeEls().length;
  ok(n1 > n0, "展开书签栏后节点变多（" + n0 + " → " + n1 + "）");
  M.toggleExpand("1");
  flushRaf();
  ok(treeEls().length === n0, "再点一次收回去（" + treeEls().length + "）");
  M.toggleExpand("1");
  flushRaf();

  console.log("\n— 选择 / 详情栏 —");
  M.selectOne("1", 0);
  flushRaf();
  ok($id("selpill").hidden === false, "选中后状态栏胶囊出现");
  ok($id("details")._html.includes("书签栏"), "详情栏渲染了选中项");
  ok($id("btnDelete").disabled === false, "删除按钮随选中启用");
  ok($id("btnRename").disabled === false, "重命名按钮随选中启用");
  M.clearSel();
  flushRaf();
  ok($id("selpill").hidden === true, "取消选择后胶囊收起");
  ok($id("btnDelete").disabled === true, "删除按钮重新禁用");

  console.log("\n— 导航 —");
  await M.navigate("10");
  flushRaf();
  ok($id("crumbs")._children.length >= 2, "进入子文件夹后面包屑有两段以上（" + $id("crumbs")._children.length + "）");
  ok(rowEls().length > 0, "子文件夹里渲染出了行（" + rowEls().length + "）");
  M.up();
  flushRaf();
  await new Promise((r) => setTimeout(r, 30));
  flushRaf();

  console.log("\n— 新建 / 删除 / 撤销 —");
  calls.length = 0;
  await M.newFolder();
  flushRaf();
  ok(calls.includes("bookmark.create"), "新建文件夹走通 ops 通道");
  calls.length = 0;
  M.selectOne("1", 0);
  M.askDelete();
  flushRaf();
  ok($id("confirmOverlay").hidden === false, "删除先弹确认框");
  await M.doDeleteConfirmed();
  flushRaf();
  ok(calls.includes("bookmark.remove"), "确认后执行删除");
  calls.length = 0;
  await M.doUndo();
  flushRaf();
  ok(calls.includes("bookmark.undoLast"), "撤销走通 ops 通道");

  console.log("\n— 搜索 —");
  $id("q").value = "";
  M.switchView("search");
  flushRaf();
  ok($id("qempty").hidden === false, "空关键词：搜索页显示待搜索提示");
  ok($id("qemptytitle").textContent.includes("输入关键词"), "提示文案正确");
  $id("q").value = "rust";
  await M.runSearch(true);
  flushRaf();
  ok($id("qempty").hidden === true, "有关键词后空提示收起");
  ok($id("qrows")._children.some((c) => c._classes.has("row")), "搜到了结果并铺出行");
  $id("q").value = "";
  await M.runSearch(false);
  flushRaf();
  ok($id("qempty").hidden === false, "清空关键词回到待搜索提示");
  M.switchView("browse");
  flushRaf();

  console.log("\n— 排序 / 数据层 —");
  ok(typeof M.sortCmp === "function" && typeof M.folderRows === "function", "数据层函数可用");
  ok(M.folderRows("1").length === 3, "folderRows('1') 取到该层全部 3 项", String(M.folderRows("1").length));
  ok(M.childrenOf("1").length === 3 && M.childrenOf("10").length === 1, "childrenOf 按层取子节点");
  ok(M.pathOf("100").length >= 1, "pathOf 能回溯路径");

  console.log("\n— 外观 —");
  M.applyTheme("dark", true);
  ok(document.documentElement.getAttribute("data-theme") === "dark", "固定深色写入 data-theme");
  ok(lsMap["bookmarkpocket.theme"] === "dark", "外观偏好落到 localStorage");
  M.cycleTheme();
  ok(document.documentElement.getAttribute("data-theme") === null, "三态循环：深色 → 跟随系统");
  M.cycleTheme();
  ok(document.documentElement.getAttribute("data-theme") === "light", "三态循环：跟随系统 → 浅色");
  M.applyTheme("auto", true);
  ok(document.documentElement.getAttribute("data-theme") === null, "跟随系统移除 data-theme");

  console.log("\n— 设置页 —");
  storage["bookmarkpocket.port"] = 19127;
  storage["bookmarkpocket.token"] = "TOKEN-XYZ";
  await M.loadSettings();
  flushRaf();
  ok($id("cfgPort").value === 19127, "端口读回（" + $id("cfgPort").value + "）");
  ok($id("cfgToken").value === "TOKEN-XYZ", "令牌读回");
  ok($id("cfgExtId").textContent === "test-ext-id", "扩展 ID 回填");
}

// 结构守护：入口必须是薄壳，逻辑按模块拆开，且每个模块都真的被引用到
console.log("\n— 代码结构 —");
{
  const uiDir = path.join(HERE, "..", "ui");
  const srcDir = path.join(uiDir, "src");
  const entry = fs.readFileSync(path.join(uiDir, "manager.js"), "utf8");
  ok(entry.split("\n").length <= 40, "入口 manager.js 是薄壳（" + entry.split("\n").length + " 行）");
  const mods = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js"));
  ok(mods.length >= 12, "逻辑拆成了 " + mods.length + " 个模块");
  const tooBig = mods.map((f) => [f, fs.readFileSync(path.join(srcDir, f), "utf8").split("\n").length])
    .filter(([, n]) => n > 400);
  ok(tooBig.length === 0, "没有上帝文件（最大 " + Math.max(...mods.map((f) => fs.readFileSync(path.join(srcDir, f), "utf8").split("\n").length)) + " 行）", tooBig.map(([f, n]) => f + ":" + n).join(", "));
  // 可达性：每个模块要么被别的模块 import，要么被入口 import
  const all = [entry, ...mods.map((f) => fs.readFileSync(path.join(srcDir, f), "utf8"))].join("\n");
  const orphan = mods.filter((f) => !new RegExp('from "\\./' + f.replace(".", "\\.") + '"').test(all) && !new RegExp('from "\\./src/' + f.replace(".", "\\.") + '"').test(all));
  ok(orphan.length === 0, "每个模块都被引用（无孤儿）", orphan.join(", "));
  // 共享可变状态只出现在 state.js（其它模块不得出现顶层 let/var）
  const strayLet = mods.filter((f) => f !== "state.js" && /^(let|var)\s/m.test(fs.readFileSync(path.join(srcDir, f), "utf8")));
  ok(strayLet.length === 0, "顶层可变状态集中在 state.js + 各自模块私有（无跨模块裸 let）", strayLet.join(", "));
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
