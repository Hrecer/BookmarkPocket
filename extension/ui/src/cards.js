// 卡片模式：渲染 + 网格虚拟窗口层
//
// 与列表模式（list.js）并列的另一套呈现，数据仍是同一份 S.viewRows / S.qRows：
//   · 每个池元素是一条「逻辑行」（内含若干张卡片），行号 × 行高定位；复用 virtual.js 的
//     applyWindow，只是行高换成「卡片高 + 间距」，逻辑行数 = 向上取整(项数 / 列数)。
//   · 交互层（单击打开 / 就地编辑 / 两击删除 / 框选 / 视图切换）在 card-ops.js。
//
// 卡片样式全部用本项目设计变量，见 manager.css 的「卡片模式」一节。

import { S, cPool, qcPool, nodeById, parentOf, recLinks } from "./state.js";
import { fmtDate } from "./data.js";
import { ICON, fmt, crowsEl, qcrowsEl, listEl, qListEl, qspacerEl, spacerEl } from "./dom.js";
import { applyWindow, windowBounds } from "./virtual.js";
import { hlText } from "./search.js";
import { setRowIcon } from "./list.js";

const MIN_CARD_W = 240;   // 单卡最小宽度：窄到这个值就少排一列
const MAX_COLS = 3;       // 参考项目：一行三个。再密下去卡片就小得没法用了

/* ---------------- 尺寸度量（以 CSS 为准，读不到时用 state 兜底） ---------------- */

function metrics() {
  if (!S.metricsReady) {
    try {
      const cs = getComputedStyle(document.documentElement);
      const h = parseFloat(cs.getPropertyValue("--card-h"));
      const g = parseFloat(cs.getPropertyValue("--card-gap"));
      const p = parseFloat(cs.getPropertyValue("--card-pad-y"));
      if (h > 0) S.cardH = h;
      if (g >= 0) S.cardGap = g;
      if (p >= 0) S.cardPadY = p;
    } catch (e) { /* 预览 / 测试环境：用兜底常量 */ }
    S.metricsReady = true;
  }
  return { h: S.cardH, gap: S.cardGap, padY: S.cardPadY };
}

export function cardRowHeight() { const m = metrics(); return m.h + m.gap; }

/** 面板当前是否卡片布局（浏览 / 搜索各自独立） */
export function cardOn(pane) { return pane === "search" ? S.searchCard : S.browseCard; }
/** 面板的列数（浏览 / 搜索各自独立） */
export function colsOf(pane) { return pane === "search" ? S.qCardCols : S.cardCols; }
/** 第 i 项在卡片布局里的纵向偏移（逻辑行号 × 行高），列数由调用方按面板给出 */
export function cardItemTop(i, cols) { return Math.floor(i / Math.max(1, cols || 1)) * cardRowHeight() + (metrics().padY || 0); }

export function computeCols(width) {
  const m = metrics();
  if (!width) return 1;
  return Math.max(1, Math.min(MAX_COLS, Math.floor((width + m.gap) / (MIN_CARD_W + m.gap))));
}

/* ---------------- 项访问（浏览 / 搜索两态统一成同一种描述） ---------------- */

export function paneRows(pane) { return pane === "search" ? S.qRows : S.viewRows; }

// 出厂抽屉（父级是虚拟根 "0"）不可改名/删除；文件夹可改名但不在卡片上删（删除入口只在工具栏）
function capsOf(id, isFolder) {
  const fixed = parentOf.get(id) === "0";
  return { canEdit: !fixed, canDelete: !isFolder && !fixed };
}

function itemOf(pane, r, i) {
  if (pane === "search") {
    const row = r.row;
    const n = nodeById.get(row.id) || row.node || row;
    const isFolder = !!row.isFolder;
    return Object.assign({
      i, id: row.id, node: n || {}, isFolder,
      htmlTitle: hlText(row.title || ""),
      htmlSub: isFolder ? ("文件夹" + (row.path ? " · " + row.path : "")) : hlText(row.url),
      meta: "",
    }, capsOf(row.id, isFolder));
  }
  const n = r.node;
  const isFolder = r.isFolder;
  const cnt = isFolder ? (recLinks.get(n.id) || 0) : 0;
  return Object.assign({
    i, id: n.id, node: n, isFolder,
    title: n.title || "",
    sub: isFolder ? ("文件夹" + (cnt ? " · " + fmt.format(cnt) + " 个书签" : "")) : n.url,
    meta: fmtDate(n.dateAdded) || "",
  }, capsOf(n.id, isFolder));
}

export function itemAt(pane, i) { const r = paneRows(pane)[i]; return r ? itemOf(pane, r, i) : null; }

// 面板描述对象只建一次（池/容器引用都是常量），避免滚动时每行都新分配一个对象
const BOXES = {
  browse: { pool: cPool, container: crowsEl, scroller: listEl, spacer: spacerEl },
  search: { pool: qcPool, container: qcrowsEl, scroller: qListEl, spacer: qspacerEl },
};

export function paneBox(pane) { return pane === "search" ? BOXES.search : BOXES.browse; }
export function boxVer(pane) { return pane === "search" ? S.qVer : S.listVer; }
export function setBoxCols(pane, c) { if (pane === "search") S.qCardCols = c; else S.cardCols = c; }

/* ---------------- 卡片 DOM ---------------- */

export function makeCard() {
  const el = document.createElement("div");
  el.className = "bcard";
  const hd = document.createElement("div"); hd.className = "bcard-hd";
  const ico = document.createElement("span"); ico.className = "bcard-ico";
  const name = document.createElement("span"); name.className = "bcard-name";
  hd.append(ico, name);
  const sub = document.createElement("div"); sub.className = "bcard-sub";
  const foot = document.createElement("div"); foot.className = "bcard-foot";
  const meta = document.createElement("span"); meta.className = "bcard-meta";
  const acts = document.createElement("span"); acts.className = "bcard-acts";
  // 「选中」键排在编辑键左边：卡片单击即打开，选中就靠它（Ctrl/Shift 仍可用）
  const pick = document.createElement("button"); pick.type = "button"; pick.tabIndex = -1; pick.className = "bcard-btn pick"; pick.title = "选中"; pick.innerHTML = ICON.pick; pick._s = "pick";
  const edit = document.createElement("button"); edit.type = "button"; edit.tabIndex = -1; edit.className = "bcard-btn edit"; edit.title = "编辑"; edit.innerHTML = ICON.pencil;
  const del = document.createElement("button"); del.type = "button"; del.tabIndex = -1; del.className = "bcard-btn del"; del.title = "删除"; del.innerHTML = ICON.trash;
  acts.append(pick, edit, del);
  foot.append(meta, acts);
  el.append(hd, sub, foot);
  el._ = { ico, name, sub, meta, pick, edit, del };
  return el;
}

export function makeCardRow() {
  const row = document.createElement("div");
  row.className = "cardrow";
  row.style.height = metrics().h + "px";
  return row;
}

// 「选中」键的两种图标只在状态变化时重设（和编辑/删除键同一套省法）
function applyPick(card, on) {
  const b = card._.pick;
  const want = on ? "picked" : "pick";
  if (b._s !== want) { b.innerHTML = ICON[want]; b._s = want; }
  b.classList.toggle("on", on);
}

export function paintCard(card, it) {
  const o = card._;
  card.dataset.idx = String(it.i);
  card.dataset.id = it.id;
  const picked = S.sel.has(it.id);
  // className / hidden 只在真的变了才写：大幅滚动时绝大多数卡都是「普通书签」，
  // 省掉这些写入就省掉每张卡的样式重算 —— 100K 量级下这是能不能跟手的关键。
  const cls = "bcard" + (it.isFolder ? " folder" : "") + (picked ? " sel" : "") +
    (S.clip && S.clip.mode === "cut" && S.clip.ids.includes(it.id) ? " cut" : "") +
    (S.editingId === it.id ? " editing" : "");
  if (card._cls !== cls) { card.className = cls; card._cls = cls; }
  if (S.editingId === it.id) return;   // 行内编辑器接管内容
  setRowIcon(o.ico, it.node, it.isFolder);
  // 浏览页没有高亮需求 → 直接写文本，省掉 esc() 每张卡新建一个 div 的开销；搜索页才用 innerHTML 渲染 <mark>
  if (it.htmlTitle != null) o.name.innerHTML = it.htmlTitle; else o.name.textContent = it.title;
  if (it.htmlSub != null) o.sub.innerHTML = it.htmlSub; else o.sub.textContent = it.sub;
  o.meta.textContent = it.meta || "";
  const eh = !it.canEdit, dh = !it.canDelete;
  if (o.edit._h !== eh) { o.edit.hidden = eh; o.edit._h = eh; }
  if (o.del._h !== dh) { o.del.hidden = dh; o.del._h = dh; }
  // 图标是常量 SVG：只有状态变了才重设 innerHTML。原来每张卡每次重绘都解析两个 SVG 字符串，
  // 拖动滚动条时一帧要重绘几十张卡 —— 这是掉帧的一个大头。
  if (o.edit._s !== "pencil") { o.edit.innerHTML = ICON.pencil; o.edit._s = "pencil"; }
  if (o.del._s !== "trash") { o.del.innerHTML = ICON.trash; o.del._s = "trash"; }
  o.edit.classList.remove("save"); o.edit.title = "编辑";
  o.del.classList.remove("confirm"); o.del.title = "删除";
  applyPick(card, picked);
}

function ensureCols(row, cols) {
  while (row.children.length > cols) row.lastElementChild.remove();
  while (row.children.length < cols) row.appendChild(makeCard());
}

function rowHasEditing(pane, start, end) {
  if (!S.editingId) return false;
  const rows = paneRows(pane);
  for (let i = start; i < end; i++) {
    const r = rows[i];
    if (!r) continue;
    const id = pane === "search" ? (r.row && r.row.id) : (r.node && r.node.id);
    if (id === S.editingId) return true;
  }
  return false;
}

function updateCardRow(row, vIdx, pane, entering) {
  const cols = colsOf(pane);
  const rows = paneRows(pane);
  const start = vIdx * cols;
  const end = Math.min(start + cols, rows.length);
  const ver = boxVer(pane);
  const same = row._vIdx === vIdx && row._cols === cols && row._ver === ver;
  row._vIdx = vIdx; row._cols = cols; row.dataset.idx = String(vIdx);
  row._lock = rowHasEditing(pane, start, end);   // 编辑中的行不参与复用
  if (same) return;
  row._ver = ver;
  row.style.height = metrics().h + "px";
  ensureCols(row, cols);
  for (let k = 0; k < cols; k++) {
    const card = row.children[k];
    const i = start + k;
    if (i < end) {
      card.style.display = "";
      paintCard(card, itemOf(pane, rows[i], i));
      if (entering) card.classList.add("enter");
    } else {
      card.style.display = "none";
    }
  }
}

// 滚动每帧都会走这里，所以：① 所有布局读取集中在写样式之前，避免「写 → 读」来回触发同步重排；
// ② 列数按容器宽度缓存、间距/总高只在值变化时才写一次 —— 滚动这种常见路径一次样式都不写。
function applyCardPane(pane, entering) {
  const box = paneBox(pane);
  const scroller = box.scroller;
  if (!box.container || !scroller) return;

  const w = scroller.clientWidth || 0;        // —— 读布局（先读）——
  const scrollTop = scroller.scrollTop;
  const viewH = scroller.clientHeight;
  if (box._w !== w) { box._w = w; box._cols = computeCols(w); }
  const c = box._cols || 1;
  if (c !== colsOf(pane)) { setBoxCols(pane, c); if (pane === "search") S.qVer++; else S.listVer++; }

  const m = metrics();
  const rowH = m.h + m.gap;
  const totalRows = Math.ceil(paneRows(pane).length / c) || 0;
  if (pane === "browse") S.cardRows = totalRows;

  // —— 写样式（后写，且只在变化时写）——
  if (box.container._cols !== c) { box.container.style.setProperty("--card-cols", c); box.container._cols = c; }
  // 上下各留一段 --card-pad-y（行层本身在 CSS 里下移了同样的距离）：卡片不紧贴面板边缘
  const hPx = totalRows ? Math.round(totalRows * rowH - m.gap + 2 * (m.padY || 0)) : 0;
  // 高度缓存在元素上（列表 / 卡片共用同一个 spacer），切换模式时才会正确重写
  if (box.spacer._h !== hPx) { box.spacer.style.height = hPx + "px"; box.spacer._h = hPx; }

  const b = windowBounds(totalRows, scrollTop, viewH, rowH, 4);   // 卡片模式余量取小：一帧要重绘的卡片更少
  // 视口对应的行区间没变、数据也没换版 → 一行都不用动。行是绝对定位、随原生滚动一起走，
  // 所以「在同一行内滑动」这条最常见的路径上，这里一次 DOM 操作、一次样式都不做。
  const ver = boxVer(pane);
  if (!entering && box._first === b.first && box._last === b.last && box._ver === ver) return;
  box._first = b.first; box._last = b.last; box._ver = ver;
  applyWindow(box.pool, box.container, makeCardRow, b, rowH, ver, (el, vIdx) => updateCardRow(el, vIdx, pane, entering));
}

export function applyCardWindow(entering) { applyCardPane("browse", entering); }
export function applySearchCardWindow(entering) { applyCardPane("search", entering); }

/* ---------------- 选中态与元素查找 ---------------- */

export function syncCardSelection() {
  for (const pane of ["browse", "search"]) {
    const box = paneBox(pane);
    for (const row of box.pool) {
      if (row.style.display === "none") continue;
      for (const card of row.children) {
        if (card.style.display === "none" || card.dataset.idx == null) continue;
        const it = itemAt(pane, Number(card.dataset.idx));
        const on = !!(it && S.sel.has(it.id));
        card.classList.toggle("sel", on);
        card._cls = card.className;   // 与「只在变化时写 className」的缓存保持一致
        applyPick(card, on);
      }
    }
  }
}

export function findCardEl(id) {
  for (const pane of ["browse", "search"]) {
    const box = paneBox(pane);
    for (const row of box.pool) {
      if (row.style.display === "none") continue;
      for (const card of row.children) {
        if (card.style.display !== "none" && card.dataset.id === id) return card;
      }
    }
  }
  return null;
}