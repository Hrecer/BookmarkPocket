// 搜索页（由 ui/manager.js 拆分而来）

import { S, nodeById, parentOf, qPool } from "./state.js";
import { setStatus, toast } from "./chan.js";
import { askDeleteFromPane } from "./crud.js";
import { flattenAll } from "./data.js";
import { esc } from "./details.js";
import { $, L_ROW_H, actionrow, busyEl, fmt, navrow, panesEl, qEl, qListEl, qemptyEl, qrowsEl, qspacerEl, rulesViewEl, searchViewEl, settingsViewEl } from "./dom.js";
import { openEditorFor } from "./edit.js";
import { cutClass, renderList, setRowIcon, syncSelection } from "./list.js";
import { goTo, refresh, scrollIdIntoView, updateStatusCounts } from "./nav.js";
import { loadSettings } from "./shell.js";
import { copyText, showCtxMenu } from "./transfer.js";
import { applyWindow, windowBounds } from "./virtual.js";
import { applySearchCardWindow } from "./cards.js";
import { syncCardMode, moveViewInd } from "./card-ops.js";

export function switchView(mode) {
  if (S.viewMode === mode) { if (mode === "search") qEl.focus(); return; }
  S.viewMode = mode;
  // 切视图一律清空选中：浏览与搜索的行集互不相同，把上一个视图的选中带过去会出现
  // 「列表空着、详情栏却挂着一个可删除的项」这种危险状态 —— 进了文件夹再切到搜索页，
  // 选中集里还留着那个文件夹，一按删除就是整个文件夹连同里面几万条书签一起没。
  S.sel.clear(); S.anchor = null; S.qanchor = null;
  syncCardMode();   // 影子标记与切换按钮跟随当前视图（两页布局各自独立）
  document.querySelectorAll(".navitem").forEach((b) => b.classList.toggle("active", b.dataset.view === mode));
  moveNavInd();
  const browse = [navrow, actionrow, panesEl];
  const panels = [...browse, searchViewEl, rulesViewEl, settingsViewEl];
  const show = { browse, search: [searchViewEl], rules: [rulesViewEl], settings: [settingsViewEl] }[mode] || browse;
  for (const el of panels) el.hidden = !show.includes(el);
  // 切换淡入（只动透明度，不做位移）
  for (const el of show) {
    el.classList.add("hide");
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("hide")));
  }
  if (mode === "search") qEl.focus();
  if (mode === "settings") loadSettings();
  if (mode === "browse") { renderList(false); updateStatusCounts(); }
  // 切到搜索页：输入框空着就先摆上待搜索提示（否则整片是空的）；已有结果则
  // 按真实高度重铺一次窗口 —— 面板刚从 display:none 出来时 clientHeight 为 0，
  // 窗口会被算小，只能看到最上面那几行。
  if (mode === "search") {
    if (!qEl.value.trim()) runSearch(false);
    else applySearchWindow(false);
  }
  syncSelection();
  // 面板刚从 hidden 变可见时才有宽度，指示块要在这之后才量得准
  requestAnimationFrame(moveViewInd);
}

export function moveNavInd() {
  const nav = $("#nav");
  const ind = nav && nav.querySelector(".nav-ind");
  const act = nav && nav.querySelector(".navitem.active");
  if (!ind || !act) return;
  ind.style.left = act.offsetLeft + "px";
  ind.style.width = act.offsetWidth + "px";
}

export const QFIELD = { title: "t", url: "u", path: "p" };

/**
 * 搜索页的空状态（待搜索 / 没选范围 / 无结果）。
 * 收敛到一个函数里：这份显隐与文案原本只写在 runSearch 内部，
 * 结果「切进搜索页」这条根本不经过 runSearch 的路径上就没人设置它 ——
 * 第一次点进搜索页整片是空的，必须先点一下搜索才出现提示。
 */
export function showSearchIdle(title, desc) {
  S.qRows = [];
  qemptyEl.hidden = false;
  $("#qemptytitle").textContent = title;
  $("#qemptydesc").textContent = desc;
  renderSearch(false);
}

export async function runSearch(entering = true) {
  const raw = qEl.value.trim();
  const q = raw.toLowerCase();
  S.qLast = q;
  if (!q) {
    showSearchIdle("输入关键词后回车搜索", "范围：标题 / 网址 / 所在位置");
    return;
  }
  const scopes = ["title", "url", "path"].filter((k) => S.qActive[k]).map((k) => QFIELD[k]);
  if (!scopes.length) {
    showSearchIdle("请至少选择一个搜索范围", "在上方勾选：标题 / 网址 / 位置");
    return;
  }
  busyEl.hidden = false;
  // 全库展平表按需构建：几万条书签建一次要几十毫秒外加一堆垃圾对象，
  // 而绝大多数操作（切文件夹、增删改）根本用不到它。数据一变就作废重建。
  if (!S.allRows) S.allRows = flattenAll(S.rootNode, "", []);
  S.qRows = S.allRows.filter((r) => scopes.some((k) => r[k].includes(q))).map((r) => ({ row: r }));
  qemptyEl.hidden = S.qRows.length > 0;
  if (!S.qRows.length) {
    $("#qemptytitle").textContent = "没有找到匹配的书签";
    $("#qemptydesc").textContent = "试试更短的关键词，或放宽搜索范围";
  }
  setStatus("搜索「" + raw + "」：找到 " + fmt.format(S.qRows.length) + " 条");
  renderSearch(entering);
  busyEl.hidden = true;
}

// 命中高亮：转义后按关键词包 <mark>（不区分大小写）
export function hlText(s) {
  s = String(s == null ? "" : s);
  if (!S.qLast) return esc(s);
  const lower = s.toLowerCase();
  const out = [];
  let i = 0;
  while (true) {
    const at = lower.indexOf(S.qLast, i);
    if (at < 0) { out.push(esc(s.slice(i))); break; }
    out.push(esc(s.slice(i, at)));
    out.push("<mark>" + esc(s.slice(at, at + S.qLast.length)) + "</mark>");
    i = at + S.qLast.length;
  }
  return out.join("");
}

export function openSearchNode(n) {
  if (!n) return;
  if (n.url) { chrome.tabs.create({ url: n.url }); return; }
  switchView("browse");
  goTo(n.id);
}

export function makeQRow() {
  const el = document.createElement("div");
  el.className = "row";
  el.innerHTML = '<div class="cell-name"><span class="ico"></span><span class="nm"></span></div>' +
    '<div class="cell-url"></div><div class="cell-loc"></div>';
  const o = { ico: el.children[0].children[0], nm: el.children[0].children[1], url: el.children[1], loc: el.children[2] };
  el._ = o;
  el.addEventListener("click", (e) => {
    const r = S.qRows[Number(el.dataset.idx)];
    if (!r) return;
    S.lastPane = "list";
    const id = r.row.id;
    const idx = Number(el.dataset.idx);
    if (e.ctrlKey || e.metaKey) {
      if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
      S.qanchor = idx;
    } else if (e.shiftKey && S.qanchor != null && S.qRows[S.qanchor]) {
      const [a, b] = [S.qanchor, idx].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) S.sel.add(S.qRows[i].row.id);
    } else {
      S.sel = new Set([id]); S.qanchor = idx;
    }
    syncSelection();
  });
  el.addEventListener("dblclick", () => {
    const r = S.qRows[Number(el.dataset.idx)];
    if (r) openSearchNode(nodeById.get(r.row.id) || r.row.node);
  });
  el.addEventListener("contextmenu", (e) => {
    if (S.rightDragJustEnded) { S.rightDragJustEnded = false; e.preventDefault(); return; }
    const r = S.qRows[Number(el.dataset.idx)];
    if (!r) return;
    e.preventDefault();
    S.lastPane = "list";
    if (!S.sel.has(r.row.id)) { S.sel = new Set([r.row.id]); S.qanchor = Number(el.dataset.idx); syncSelection(); }
    const n = nodeById.get(r.row.id) || r.row.node;
    showCtxMenu(e.clientX, e.clientY, [
      { label: "打开", fn: () => openSearchNode(n) },
      { label: "跳转", fn: () => locateRow({ id: r.row.id }) },
      { label: "复制链接", disabled: !!r.row.isFolder, fn: () => copyText(r.row.url) },
      "-",
      { label: "编辑", disabled: r.row.isFolder || S.sel.size !== 1, fn: () => openEditorFor(n) },
      { label: "删除", fn: () => askDeleteFromPane() },
    ]);
  });
  return el;
}

export function renderSearch(entering) {
  S.qVer++;
  applySearchWindow(entering);
}

// 只挪窗口、不重算数据：滚动时走这条（每帧最多一次）
// 与浏览页一样按布局分派：列表走等高行，卡片走网格逻辑行。搜索页只认 S.searchCard。
export function applySearchWindow(entering) {
  if (S.searchCard) { applySearchCardWindow(entering); return; }
  applySearchRowWindow(entering);
}

function applySearchRowWindow(entering) {
  if (S.editingId) return;
  // 同浏览页：先读布局再写样式，高度只在变化时写 —— 滚动时不触发同步重排
  const scrollTop = qListEl.scrollTop, viewH = qListEl.clientHeight;
  const hPx = Math.round(S.qRows.length * L_ROW_H);
  if (qspacerEl._h !== hPx) { qspacerEl.style.height = hPx + "px"; qspacerEl._h = hPx; }
  const b = windowBounds(S.qRows.length, scrollTop, viewH, L_ROW_H);
  // 行区间没变、数据也没换版 → 不动 DOM
  if (!entering && qPool._first === b.first && qPool._last === b.last && qPool._seenVer === S.qVer) return;
  qPool._first = b.first; qPool._last = b.last; qPool._seenVer = S.qVer;
  applyWindow(qPool, qrowsEl, makeQRow, b, L_ROW_H, S.qVer, (el, idx) => {
    updateQRow(el, S.qRows[idx], idx);
    if (entering) el.classList.add("enter");
  });
}

export function updateQRow(el, r, idx) {
  const o = el._;
  const row = r.row;
  const same = el._idx === idx && el._ver === S.qVer;
  el._idx = idx;
  el.dataset.idx = String(idx);
  el._lock = S.editingId === row.id;
  // 同一行、同一份结果：滚动时绝大多数行都是这种，直接跳过 DOM 写入
  if (same) return;
  el._ver = S.qVer;
  el.className = "row" + (row.isFolder ? " folder" : "") + (S.sel.has(row.id) ? " sel" : "") + cutClass(row.id);
  setRowIcon(o.ico, row, row.isFolder);
  o.nm.innerHTML = hlText(row.title || "");
  o.url.innerHTML = row.isFolder ? "" : hlText(row.url);
  o.loc.innerHTML = hlText(row.path || "全部书签");
}

export function locateRow(row) {
  // 跳转：回浏览页，进入所在目录并选中、滚入视口（照 LinkPocket 定位组件语义）
  const id = row && row.id;
  const node = id && nodeById.get(id);
  if (!node) { toast("找不到该项目（可能已被删除）", { error: true }); return; }
  switchView("browse");
  const pid = parentOf.get(id) || "0";
  S.backStack.push(S.currentFolderId); S.fwdStack.length = 0;
  S.currentFolderId = pid;
  refresh({ busy: false, entering: true, counts: true }).then(() => {
    S.sel = new Set([id]);
    S.anchor = null;
    syncSelection();
    scrollIdIntoView(id);
  });
}
