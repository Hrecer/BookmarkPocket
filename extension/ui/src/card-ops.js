// 卡片模式：交互层（参考项目的「直接操作」模型）
//
// 刻意不走列表的「先选后操作」，而是照参考项目的卡片语义：
//   · 单击卡片 = 打开；Ctrl/⌘ 单击 = 增减选择；Shift 单击 = 区间选择；空白拖拽 = 框选
//   · 点「编辑」= 就地改标题 / 网址；点空白或别的卡片 = 退出编辑（不写库）
//   · 点「删除」→ 按钮变对勾 → 再点一次直接删（不进确认弹窗）
//   · 工具栏删除与右键菜单仍走原有的确认弹窗（涉及文件夹必须确认），这是安全底线
//
// 渲染与网格窗口在 cards.js。两处共用同一份 S.viewRows / S.qRows。

import { S, clearRenamePair } from "./state.js";
import { K } from "../../src/keys.js";
import { $, ICON, fmt, listEl, qListEl } from "./dom.js";
import { itemAt, paneBox, paneRows, paintCard, findCardEl, cardOn, colsOf } from "./cards.js";
import { op, setStatus, toast } from "./chan.js";
import { openNode } from "./details.js";
import { refresh, updateStatusCounts } from "./nav.js";
import { doUndo } from "./crud.js";
import { showCtxMenu, rowMenuItems, startDragCandidate } from "./transfer.js";
import { applyListWindow, itemHeight, itemOffsetTop, renderList, syncSelection } from "./list.js";
import { openSearchNode, renderSearch, applySearchWindow } from "./search.js";

const MARQ_MIN = 8;   // 空白拖拽超过这个位移才算框选（否则当作普通点击）

/* ---------------- 就地编辑（改标题 + 网址） ---------------- */

function editingCard() { try { return document.querySelector(".bcard.editing"); } catch (e) { return null; } }

// 卡片属于哪个面板：看它在哪个滚动容器里（不能靠 dataset —— 未编辑过的卡片没有这个标记）。
// 搜索卡片的项下标是 S.qRows 的下标，浏览卡片是 S.viewRows 的下标，两者不能混用。
function paneOfCard(card) {
  try { return card.closest("#qlist") ? "search" : "browse"; } catch (e) { return "browse"; }
}

function enterCardEdit(card, pane) {
  if (S.editingId) return;
  const it = itemAt(pane, Number(card.dataset.idx));
  if (!it || !it.canEdit) return;
  S.editingId = it.id;
  if (card.parentElement) card.parentElement._lock = true;
  card.classList.add("editing");
  const o = card._;
  const t = document.createElement("input"); t.className = "bcard-input bcard-input-title"; t.value = it.node.title || ""; t.placeholder = "名称";
  o.name.textContent = ""; o.name.appendChild(t);
  // 文件夹只改名字（没有网址）；书签再挂一个网址输入框
  let u = null;
  if (!it.isFolder) {
    u = document.createElement("input"); u.className = "bcard-input bcard-input-url"; u.value = it.node.url || ""; u.placeholder = "https://…";
    o.sub.textContent = ""; o.sub.appendChild(u);
  }
  o.edit.innerHTML = ICON.check; o.edit.classList.add("save"); o.edit.title = "保存"; o.edit._s = "check";
  card._edit = { t, u };
  t.focus(); t.select();
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); saveCardEdit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelCardEdit(); }
  };
  for (const inp of [t, u]) {
    if (!inp) continue;
    inp.addEventListener("keydown", onKey);
    inp.addEventListener("mousedown", (e) => e.stopPropagation());
    inp.addEventListener("click", (e) => e.stopPropagation());
  }
}

function exitCardEdit(card) {
  const pane = paneOfCard(card);
  const o = card._;
  S.editingId = null;
  if (card.parentElement) card.parentElement._lock = false;
  card.classList.remove("editing");
  delete card._edit;
  o.edit.innerHTML = ICON.pencil; o.edit.classList.remove("save"); o.edit.title = "编辑"; o.edit._s = "pencil";
  const it = itemAt(pane, Number(card.dataset.idx));
  if (it) paintCard(card, it);
}

function cancelCardEdit() { const card = editingCard(); if (card) exitCardEdit(card); }

async function saveCardEdit() {
  const card = editingCard();
  if (!card || !card._edit) return;
  const pane = paneOfCard(card);
  const it = itemAt(pane, Number(card.dataset.idx));
  const { t, u } = card._edit;
  const title = t.value.trim();
  if (!title) { toast("请填写名称", { error: true }); t.focus(); return; }
  let url = "";
  if (u) {                                    // 只有书签才有网址
    url = u.value.trim();
    if (!/^https?:\/\//i.test(url)) { toast("网址必须以 http:// 或 https:// 开头", { error: true }); u.focus(); return; }
  }
  if (!it) { exitCardEdit(card); return; }
  const changed = u ? (title !== (it.node.title || "") || url !== (it.node.url || "")) : (title !== (it.node.title || ""));
  if (!changed) { exitCardEdit(card); return; }
  try {
    await op("bookmark.update", u ? { id: it.id, title, url } : { id: it.id, title });
    exitCardEdit(card);
    setStatus("已保存「" + title + "」");
    await refresh({ busy: false });
  } catch (e) { toast(String((e && e.message) || e), { error: true }); }
}

/** F2：在卡片模式下对选中项启动就地编辑（edit.js 调用） */
export function startCardEdit(id) {
  const card = findCardEl(id);
  if (!card) { toast("请先滚动到该项再编辑"); return; }
  enterCardEdit(card, paneOfCard(card));
}

/* ---------------- 两击删除（点删除 → 变对勾 → 再点确认） ---------------- */

function disarmCardDelete() {
  const a = S.delArm; if (!a) return;
  S.delArm = null;
  clearTimeout(a.timer);
  document.removeEventListener("click", a.onDoc);
  document.removeEventListener("keydown", a.onKey);
  if (a.btn) { a.btn.classList.remove("confirm"); a.btn.innerHTML = ICON.trash; a.btn.title = "删除"; a.btn._s = "trash"; }
}

function armCardDelete(btn) {
  disarmCardDelete();
  btn.classList.add("confirm");
  btn.innerHTML = ICON.check;
  btn._s = "check";
  btn.title = "再点一次确认删除";
  const onDoc = (e) => { if (!btn.contains(e.target)) disarmCardDelete(); };
  const onKey = (e) => { if (e.key === "Escape") disarmCardDelete(); };
  const timer = setTimeout(disarmCardDelete, 3200);
  S.delArm = { btn, onDoc, onKey, timer };
  setTimeout(() => { document.addEventListener("click", onDoc); document.addEventListener("keydown", onKey); }, 0);
}

async function performCardDelete(card) {
  disarmCardDelete();
  const it = itemAt(paneOfCard(card), Number(card.dataset.idx));
  if (!it) return;
  if (S.editingId === it.id) cancelCardEdit();
  try {
    const res = await op("bookmark.remove", { ids: [it.id] });
    S.sel.delete(it.id);
    toast("已删除 " + fmt.format(res.removed || 1) + " 项", { action: "撤销", onAction: doUndo });
    // 删除改了当前文件夹的计数：立刻把状态栏的数字刷成最新（反馈由 toast 承担）
    await refresh({ busy: false, counts: true });
  } catch (e) { toast(String((e && e.message) || e), { error: true }); }
}

/* ---------------- 选择与打开 ---------------- */

function openItem(it, pane) { if (pane === "search") openSearchNode(it.node); else openNode(it.node); }

function toggleSelect(id, pane, i) {
  if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
  if (pane === "browse") S.anchor = i; else S.qanchor = i;
  syncSelection();
}

function rangeSelect(id, pane, i) {
  const anchor = pane === "browse" ? S.anchor : S.qanchor;
  const rows = paneRows(pane);
  if (anchor == null || !rows[anchor]) { S.sel = new Set([id]); if (pane === "browse") S.anchor = i; else S.qanchor = i; syncSelection(); return; }
  const [a, b] = [anchor, i].sort((x, y) => x - y);
  for (let k = a; k <= b; k++) { const it = itemAt(pane, k); if (it) S.sel.add(it.id); }
  syncSelection();
}

/* ---------------- 事件（独立委托层，不共用列表 handler） ---------------- */

function onGridClick(e, pane) {
  if (!cardOn(pane)) return;
  const card = e.target.closest(".bcard");
  if (!card) return;                       // 空白点击交给 boot 的清除逻辑
  // 「选中」键已在下面的 pointerdown（捕获）里处理完；这里只负责别让这次 click 掉进「打开」
  if (e.target.closest(".bcard-btn.pick")) { S.suppressClick = false; return; }
  if (S.suppressClick) { S.suppressClick = false; return; }
  const it = itemAt(pane, Number(card.dataset.idx));
  if (!it) return;
  const editBtn = e.target.closest(".bcard-btn.edit"), delBtn = e.target.closest(".bcard-btn.del");
  if (editBtn) { if (card.classList.contains("editing")) saveCardEdit(); else enterCardEdit(card, pane); return; }
  if (delBtn) { if (delBtn.classList.contains("confirm")) performCardDelete(card); else armCardDelete(delBtn); return; }
  if (card.classList.contains("editing")) return;
  if (e.ctrlKey || e.metaKey) { toggleSelect(it.id, pane, it.i); return; }
  if (e.shiftKey) { rangeSelect(it.id, pane, it.i); return; }
  openItem(it, pane);                      // 参考项目：单击直接打开
}

function onGridContext(e, pane) {
  if (!cardOn(pane)) return; clearRenamePair();   // 右键是另一种手势，不能夹在「两击对」之间
  if (S.rightDragJustEnded) { S.rightDragJustEnded = false; e.preventDefault(); return; }
  const card = e.target.closest(".bcard");
  if (!card) return;                       // 空白右键交给 boot
  const it = itemAt(pane, Number(card.dataset.idx));
  if (!it) return;
  e.preventDefault();
  S.lastPane = "list";
  if (!S.sel.has(it.id)) {
    S.sel = new Set([it.id]);
    if (pane === "browse") S.anchor = it.i; else S.qanchor = it.i;
    syncSelection();
  }
  showCtxMenu(e.clientX, e.clientY, rowMenuItems(it.node));
}

function onGridPointerDown(e, pane) {
  if (!cardOn(pane)) return;
  const card = e.target.closest(".bcard");
  if (card) {
    if (e.target.closest(".bcard-btn, input")) return;
    const it = itemAt(pane, Number(card.dataset.idx));
    if (!it) return;
    S.suppressClick = false;
    startDragCandidate(e, it.node);
    return;
  }
  if (e.button !== 0 || e.target.closest(".bcard-btn, input, .empty, .busy")) return;
  S.mq = { pending: { x0: e.clientX, y0: e.clientY }, active: false, el: null, pane };
}

// 点空白 / 点其他卡片 → 退出卡片编辑（照参考项目：pointerdown 捕获阶段先于一切 click）
function onDocPointerDown(e) {
  if (!S.editingId) return;
  const card = editingCard();
  if (!card || card.contains(e.target)) return;
  cancelCardEdit();
}

/* ---------------- 框选（空白处拖拽） ---------------- */

function marqueeRect(e) {
  const p = S.mq.pending;
  const w = Math.abs(e.clientX - p.x0), h = Math.abs(e.clientY - p.y0);
  const left = Math.min(p.x0, e.clientX), top = Math.min(p.y0, e.clientY);
  return { left, top, width: w, height: h, right: left + w, bottom: top + h };
}

function applyMarquee(r) {
  const pane = S.mq.pane;
  const box = paneBox(pane);
  const sel = new Set();
  for (const row of box.pool) {
    if (row.style.display === "none") continue;
    for (const card of row.children) {
      if (card.style.display === "none" || card.dataset.idx == null) continue;
      const b = card.getBoundingClientRect();
      if (b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) {
        const it = itemAt(pane, Number(card.dataset.idx));
        if (it) sel.add(it.id);
      }
    }
  }
  S.sel = sel;
  if (pane === "browse") S.anchor = null; else S.qanchor = null;
  syncSelection();
}

function onMarqueeMove(e) {
  const mq = S.mq; if (!mq) return;
  if (!mq.active) {
    if (Math.abs(e.clientX - mq.pending.x0) + Math.abs(e.clientY - mq.pending.y0) < MARQ_MIN) return;
    mq.active = true;
    const d = document.createElement("div"); d.className = "marquee";
    document.body.appendChild(d);
    mq.el = d;
  }
  const r = marqueeRect(e);
  mq.el.style.left = r.left + "px"; mq.el.style.top = r.top + "px";
  mq.el.style.width = r.width + "px"; mq.el.style.height = r.height + "px";
  applyMarquee(r);
}

function onMarqueeUp() {
  const mq = S.mq; if (!mq) return;
  if (mq.active) {
    if (mq.el) mq.el.remove();
    S.suppressClick = true;   // 吞掉紧随其后的空白 click，保住框选结果
  }
  S.mq = null;
}

function wirePane(container, pane) {
  // 「选中」键走 pointerdown 捕获：按下即切换，不受 suppressClick / 拖拽 / 编辑态 / 行复用影响
  container.addEventListener("pointerdown", (e) => {
    if (!cardOn(pane) || !e.target.closest || !e.target.closest(".bcard-btn.pick")) return;
    const card = e.target.closest(".bcard"), it = card ? itemAt(pane, Number(card.dataset.idx)) : null;
    e.preventDefault(); e.stopPropagation();   // 不抢焦点，也不走后面的卡片点击 / 拖拽
    if (it) toggleSelect(it.id, pane, it.i);
  }, true);
  container.addEventListener("click", (e) => onGridClick(e, pane));
  container.addEventListener("contextmenu", (e) => onGridContext(e, pane));
  container.addEventListener("pointerdown", (e) => onGridPointerDown(e, pane));
}

export function wireCardGrid() {
  if (listEl) wirePane(listEl, "browse");
  if (qListEl) wirePane(qListEl, "search");
  document.addEventListener("pointermove", onMarqueeMove, { passive: true });
  document.addEventListener("pointerup", onMarqueeUp);
  document.addEventListener("pointerdown", onDocPointerDown, true);
}

/* ---------------- 视图切换（浏览 / 搜索各自独立） ---------------- */

export function readCardPref() {
  try {
    const v = JSON.parse(localStorage.getItem(K.view) || "{}");
    return { browse: !!v.browse, search: !!v.search };
  } catch (e) { return { browse: false, search: false }; }
}

function saveCardPref() {
  try { localStorage.setItem(K.view, JSON.stringify({ browse: S.browseCard, search: S.searchCard })); } catch (e) { /* 无痕：本次会话生效 */ }
}

function applyLayoutClass() {
  if (!document.body) return;
  document.body.classList.toggle("card-browse", S.browseCard);
  document.body.classList.toggle("card-search", S.searchCard);
}

function markGroup(listBtn, gridBtn, on) {
  const l = $(listBtn), g = $(gridBtn);
  if (l) l.classList.toggle("on", !on);
  if (g) g.classList.toggle("on", on);
}

function moveInd(seg, active) {
  const ind = seg && active && seg.querySelector(".viewseg-ind");
  if (!ind) return;
  ind.style.left = active.offsetLeft + "px";
  ind.style.width = active.offsetWidth + "px";
}

/** 把两组的滑动指示块移到当前选中项上（与顶栏导航胶囊同一套动画） */
export function moveViewInd() {
  const l = $("#btnViewList"), g = $("#btnViewGrid");
  if (l && g) moveInd(l.parentElement, S.browseCard ? g : l);
  const ql = $("#btnQViewList"), qg = $("#btnQViewGrid");
  if (ql && qg) moveInd(ql.parentElement, S.searchCard ? qg : ql);
}

function updateViewToggle() {
  markGroup("#btnViewList", "#btnViewGrid", S.browseCard);   // 浏览页那组
  markGroup("#btnQViewList", "#btnQViewGrid", S.searchCard); // 搜索页那组
  moveViewInd();
}

/** 影子标记 S.cardMode = 当前视图的卡片开关；两组按钮外观一并同步 */
export function syncCardMode() {
  S.cardMode = S.viewMode === "search" ? S.searchCard : S.browseCard;
  updateViewToggle();
}

/* ---------------- 切换布局时保住「当前位置」 ---------------- */
// 两种布局共用同一份项序，只是行距/列数不同。锚点**固定取视口顶部那一项**：
// 之前「有选中就跳到选中项、否则取顶部」会导致同样的操作时而跳这里时而跳那里，
// 现在只认顶部那一项 —— 切换前后看到的东西不变，行为可预期。

function scrollerOf(pane) { return pane === "search" ? qListEl : listEl; }

function keepIndex(pane) {
  const rows = paneRows(pane); if (!rows.length) return 0;
  const h = itemHeight(pane); if (!h) return 0;   // 切换前的旧行距
  const per = cardOn(pane) ? colsOf(pane) : 1;
  const top = Math.floor(scrollerOf(pane).scrollTop / h) * per;
  return Math.min(rows.length - 1, Math.max(0, top));
}

function restoreIndex(pane, i) {
  if (i < 0) return;
  scrollerOf(pane).scrollTop = Math.max(0, itemOffsetTop(i, pane));   // 用切换后的新行距
  if (pane === "search") applySearchWindow(false); else applyListWindow(false);
}

/** 切换布局：改的是「当前所在页」的设置（浏览页点改浏览页、搜索页点改搜索页），两页互不影响 */
export function setCardMode(on, persist = true, rerender = true) {
  clearRenamePair();   // 切换视图形态也是另一种手势
  const pane = S.viewMode === "search" ? "search" : "browse";
  const keep = rerender ? keepIndex(pane) : -1;
  if (S.editingId) cancelCardEdit();   // 正在改的那张卡先退出，否则列表层不会重铺
  if (pane === "search") S.searchCard = !!on; else S.browseCard = !!on;
  if (persist) saveCardPref();
  applyLayoutClass(); syncCardMode();
  if (rerender) {
    if (S.viewMode === "browse") { S.listVer++; renderList(false); updateStatusCounts(); }
    else if (S.viewMode === "search") renderSearch(false);
    else applySearchWindow(false);
    restoreIndex(pane, keep);
  }
  moveViewInd();
}

export function initViewMode() {
  const p = readCardPref();
  S.browseCard = p.browse;
  S.searchCard = p.search;
  applyLayoutClass();
  syncCardMode();
}