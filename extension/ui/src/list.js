// 主列表渲染与选择（由 ui/manager.js 拆分而来）

import { S, lPool, qPool, recLinks, tPool } from "./state.js";
import { favUrl, fmtDate, folderRows } from "./data.js";
import { openNode, renderDetails } from "./details.js";
import { $, ICON, L_ROW_H, emptyEl, emptydescEl, emptytitleEl, fmt, listEl, panesEl, rowsEl, searchViewEl, spacerEl } from "./dom.js";
import { startRenameList } from "./edit.js";
import { applySearchWindow } from "./search.js";
import { rowMenuItems, showCtxMenu, startDragCandidate } from "./transfer.js";
import { applyTreeWindow } from "./tree.js";
import { applyWindow, windowBounds } from "./virtual.js";
import { applyCardWindow, cardItemTop, cardOn, cardRowHeight, colsOf, syncCardSelection } from "./cards.js";

export function makeListRow() {
  const el = document.createElement("div");
  el.className = "row";
  el.innerHTML = '<div class="cell-name"><span class="ico"></span><span class="nm"></span><span class="chip"></span></div>' +
    '<div class="cell-url"></div><div class="cell-date"></div>';
  const o = { ico: el.children[0].children[0], nm: el.children[0].children[1], chip: el.children[0].children[2], url: el.children[1], date: el.children[2] };
  el._ = o;
  el.addEventListener("click", (e) => onRowClick(e, el));
  el.addEventListener("pointerdown", (e) => {
    S.suppressClick = false;
    const r = S.viewRows[Number(el.dataset.idx)];
    if (r) startDragCandidate(e, r.node);
  });
  el.addEventListener("dblclick", () => {
    if (S.suppressClick) { S.suppressClick = false; return; }
    const r = S.viewRows[Number(el.dataset.idx)];
    if (r) openNode(r.node);
  });
  el.addEventListener("contextmenu", (e) => {
    if (S.rightDragJustEnded) { S.rightDragJustEnded = false; e.preventDefault(); return; }
    const r = S.viewRows[Number(el.dataset.idx)];
    if (!r) return;
    e.preventDefault();
    S.lastPane = "list";
    if (!S.sel.has(r.node.id)) { S.sel = new Set([r.node.id]); S.anchor = Number(el.dataset.idx); syncSelection(); }
    showCtxMenu(e.clientX, e.clientY, rowMenuItems(r.node));
  });
  return el;
}

// 行图标：复用同一个 <img>，只换 src。
// 重建 <img> 会让浏览器对同一张 favicon 重新走一次加载 + 解码 ——
// 滚动时每帧重建几十个 <img> 是「图标列发白 + 掉帧」的主因。
export function setRowIcon(ico, n, isFolder) {
  if (S.fastScroll) return;   // 超大幅滚动中：先不加载 favicon（解码是大头），停稳后整窗重绘补上
  if (isFolder) {
    if (ico._k !== "f") { ico._k = "f"; ico.innerHTML = ICON.folder; }
    return;
  }
  const fav = n.url && /^https?:/i.test(n.url) ? favUrl(n.url) : "";
  const key = fav || "l";
  if (ico._k === key) return;
  ico._k = key;
  if (!fav) { ico.innerHTML = ICON.link; return; }
  let img = ico.firstElementChild;
  if (!img || img.tagName !== "IMG") { ico.innerHTML = '<img alt="" loading="lazy" decoding="async">'; img = ico.firstElementChild; }
  img.onerror = () => { ico._k = "l"; ico.innerHTML = ICON.link; };
  img.src = fav;
}

export function updateListRow(el, r, idx) {
  const o = el._;
  const n = r.node;
  const same = el._idx === idx && el._ver === S.listVer;
  el._idx = idx;
  el.dataset.idx = String(idx);
  el._lock = S.editingId === n.id;
  // 同一行、同一份数据：滚动时绝大多数行都是这种，直接跳过 DOM 写入
  if (same) return;
  el._ver = S.listVer;
  el.className = "row" + (r.isFolder ? " folder" : "") + (S.sel.has(n.id) ? " sel" : "") + cutClass(n.id);
  setRowIcon(o.ico, n, r.isFolder);
  if (S.editingId === n.id) {
    // 改名编辑器接管
  } else {
    o.nm.textContent = n.title || "";
  }
  const direct = r.isFolder ? (recLinks.get(n.id) || 0) : 0;
  o.chip.textContent = direct ? fmt.format(direct) : "";
  o.chip.style.display = direct ? "" : "none";
  o.url.textContent = r.isFolder ? "" : n.url;
  o.date.textContent = fmtDate(n.dateAdded);
}

export function renderList(entering) {
  if (S.editingId) return;
  S.viewRows = folderRows(S.currentFolderId).map((n) => ({ node: n, isFolder: !n.url }));
  S.listVer++;
  emptyEl.hidden = S.viewRows.length > 0;
  if (!S.viewRows.length) {
    emptytitleEl.textContent = "此文件夹为空";
    emptydescEl.textContent = "当前文件夹中没有书签";
  }
  applyListWindow(entering);
}

// 只挪窗口、不重算数据：滚动时走这条（每帧最多一次）
// 按当前布局分派：列表走等高行，卡片走网格逻辑行（cards.js）。浏览页只认 S.browseCard。
export function applyListWindow(entering) {
  if (S.browseCard) { applyCardWindow(entering); return; }
  applyRowWindow(entering);
}

function applyRowWindow(entering) {
  // 先读布局再写样式，且高度只在变化时写：滚动这种常见路径一次样式都不写，
  // 也就不会每帧「写样式 → 读 scrollTop/clientHeight」来回触发同步重排。
  const scrollTop = listEl.scrollTop, viewH = listEl.clientHeight;
  const hPx = Math.round(S.viewRows.length * L_ROW_H);
  if (spacerEl._h !== hPx) { spacerEl.style.height = hPx + "px"; spacerEl._h = hPx; }
  const b = windowBounds(S.viewRows.length, scrollTop, viewH, L_ROW_H);
  // 行区间没变、数据也没换版 → 不动 DOM（行随原生滚动一起走，行内滑动零开销）
  if (!entering && lPool._first === b.first && lPool._last === b.last && lPool._seenVer === S.listVer) return;
  lPool._first = b.first; lPool._last = b.last; lPool._seenVer = S.listVer;
  applyWindow(lPool, rowsEl, makeListRow, b, L_ROW_H, S.listVer, (el, idx) => {
    updateListRow(el, S.viewRows[idx], idx);
    if (entering) el.classList.add("enter");
  });
}

// 定位换算：列表=行号×行高；卡片=逻辑行号×行高（列数按面板取）。
// nav / shortcuts / boot 的方向键与「滚入视口」都走这两个，免得各处再各写一份 L_ROW_H。
export function itemHeight(pane = "browse") { return cardOn(pane) ? cardRowHeight() : L_ROW_H; }
export function itemOffsetTop(i, pane = "browse") { return cardOn(pane) ? cardItemTop(i, colsOf(pane)) : i * L_ROW_H; }

// 容器尺寸变了就重铺窗口（只挪窗口，不重算数据）。会走到这里的场景：
// 窗口缩放、拖分隔条、侧栏出现横向滚动条（横向滚动条会吃掉 16px 可视高度，
// 每屏行数随之变少），以及视图切换导致容器从 display:none 变回可见。
// 行是绝对定位的，重铺不会反过来改变容器尺寸，所以不会自激循环。
export function applyAllWindows() {
  if (!panesEl.hidden) { applyTreeWindow(false); applyListWindow(false); }
  if (!searchViewEl.hidden) applySearchWindow(false);
}

export function cutClass(id) { return S.clip && S.clip.mode === "cut" && S.clip.ids.includes(id) ? " cut" : ""; }

export function syncSelection() {
  // 更新三侧可视行 + 详情栏 + 状态栏胶囊
  for (const el of lPool) {
    const r = S.viewRows[Number(el.dataset.idx)];
    if (r) el.classList.toggle("sel", S.sel.has(r.node.id));
  }
  for (const el of tPool) {
    const r = S.treeView[Number(el.dataset.idx)];
    if (r) el.classList.toggle("sel", S.sel.has(r.node.id));
  }
  for (const el of qPool) {
    const r = S.qRows[Number(el.dataset.idx)];
    if (r) el.classList.toggle("sel", S.sel.has(r.row.id));
  }
  syncCardSelection();
  const pill = $("#selpill");
  pill.hidden = S.sel.size === 0;
  pill.textContent = "已选中 " + fmt.format(S.sel.size) + " 项";
  updateCommandStates();
  renderDetails();
}

// 按钮可用性随选中状态与所在层联动（照 LinkPocket CanExecute + 书签虚拟根硬限制）
export function updateCommandStates() {
  const atRoot = S.currentFolderId === "0";
  $("#btnNewFolder").disabled = atRoot;
  $("#btnNewLink").disabled = atRoot;
  $("#btnRename").disabled = S.sel.size !== 1;
  $("#btnDelete").disabled = S.sel.size === 0;
  const bj = $("#btnJump");
  if (bj) bj.disabled = S.sel.size !== 1;
  const bqd = $("#btnQDelete");
  if (bqd) bqd.disabled = S.sel.size === 0;
}

export function clearSel() {
  if (!S.sel.size) return;
  S.sel.clear(); S.anchor = null;
  syncSelection();
}

export function onRowClick(e, el) {
  if (S.suppressClick) { S.suppressClick = false; return; }
  S.lastPane = "list";
  const idx = Number(el.dataset.idx);
  const r = S.viewRows[idx];
  if (!r) return;
  const id = r.node.id;
  if (e.ctrlKey || e.metaKey) {
    if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
    S.anchor = idx;
  } else if (e.shiftKey && S.anchor != null && S.viewRows[S.anchor]) {
    const [a, b] = [S.anchor, idx].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) S.sel.add(S.viewRows[i].node.id);
  } else {
    // 单击未选中=单选；单击已选中唯一项：慢速第二击=行内改名，快速双击交给 dblclick 打开
    const wasSole = S.sel.size === 1 && S.sel.has(id);
    const now = Date.now();
    const slowSecond = wasSole && S.lastClick.id === id && now - S.lastClick.t > 500;
    S.lastClick = { id, t: now };
    if (slowSecond) { startRenameList(idx); return; }
    if (!wasSole) { S.sel = new Set([id]); S.anchor = idx; }
  }
  syncSelection();
}

export function selectOne(id, idx) {
  S.sel = new Set([id]); S.anchor = idx == null ? null : idx;
  syncSelection();
}
