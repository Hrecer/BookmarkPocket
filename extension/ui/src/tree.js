// 侧栏树渲染（由 ui/manager.js 拆分而来）
//
// 左栏 = Windows 导航窗格口径：顶部固定「全部书签」根行，其下**只列文件夹**（链接不进树）。
// 高亮只有一种含义——**当前所在目录**（根目录 = 「全部书签」行），任何时刻恰好一个文件夹行亮着；
// 主栏的选中集合不在这里投影，点空白清选中不会把它抹掉。

import { S, expanded, recLinks, tPool, clearRenamePair } from "./state.js";
import { ICON, T_ROW_H, fmt, treeEl, trowsEl, tspacer } from "./dom.js";
import { visibleRows } from "./treewalk.js";
import { startRenameSelected } from "./edit.js";
import { cutClass, setRowIcon, syncSelection } from "./list.js";
import { goTo } from "./nav.js";
import { isFixedRoot, showCtxMenu, startDragCandidate } from "./transfer.js";
import { applyWindow, windowBounds } from "./virtual.js";

export function buildTreeRows() {
  const rows = [];
  if (!S.rootNode) return rows;
  // 虚拟根「全部书签」：固定展开、不可折叠（与 Windows 导航窗格的顶层入口一致）
  rows.push({ node: S.rootNode, depth: 0, isFolder: true, isRoot: true });
  for (const r of visibleRows(S.treeRoots, expanded)) rows.push({ ...r, depth: r.depth + 1 });
  return rows;
}

export function makeTreeRow() {
  const el = document.createElement("div");
  el.className = "tnode";
  el.innerHTML = '<button class="tchev" type="button" tabindex="-1">' + ICON.chev + "</button>" +
    '<span class="tico"></span><span class="tname"></span><span class="tchip"></span>';
  const o = { chev: el.children[0], ico: el.children[1], name: el.children[2], chip: el.children[3] };
  o.chev.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = S.treeView[Number(el.dataset.idx)];
    if (r && r.isFolder && !r.isRoot) { toggleExpand(r.node.id); }
  });
  el.addEventListener("click", (e) => {
    if (S.suppressClick) { S.suppressClick = false; return; }
    const r = S.treeView[Number(el.dataset.idx)];
    if (!r) return;
    S.lastPane = "tree";
    onTreeClick(r);
  });
  el.addEventListener("pointerdown", (e) => {
    S.suppressClick = false;
    const r = S.treeView[Number(el.dataset.idx)];
    if (r && !r.isRoot) startDragCandidate(e, r.node);   // 虚根不是实体，不可拖
  });
  el.addEventListener("contextmenu", (e) => {
    clearRenamePair();   // 右键是另一种手势，不能夹在「两击对」之间
    if (S.rightDragJustEnded) { S.rightDragJustEnded = false; e.preventDefault(); return; }
    const r = S.treeView[Number(el.dataset.idx)];
    e.preventDefault();
    if (!r) return;
    if (r.isRoot || isFixedRoot(r.node.id)) return;   // 虚根与出厂抽屉不挂菜单
    S.lastPane = "tree";
    S.sel = new Set([r.node.id]); S.anchor = null; syncSelection();
    showCtxMenu(e.clientX, e.clientY, [
      { label: "重命名", disabled: S.sel.size !== 1, fn: () => startRenameSelected() },
      // 文件夹的删除入口统一收敛到工具栏的「删除」按钮
    ]);
  });
  el._ = o;
  return el;
}

export function renderTree(entering) {
  S.treeView = buildTreeRows();
  S.treeVer++;
  applyTreeWindow(entering);
}

export function applyTreeWindow(entering) {
  if (S.editingId) return;
  tspacer.style.height = S.treeView.length * T_ROW_H + "px";
  const b = windowBounds(S.treeView.length, treeEl.scrollTop, treeEl.clientHeight, T_ROW_H);
  applyWindow(tPool, trowsEl, makeTreeRow, b, T_ROW_H, S.treeVer, (el, idx) => {
    updateTreeRow(el, S.treeView[idx], idx);
    if (entering) el.classList.add("enter");
  });
}

export function updateTreeRow(el, r, idx) {
  const o = el._;
  const n = r.node;
  const same = el._idx === idx && el._ver === S.treeVer;
  el._idx = idx;
  el.dataset.idx = String(idx);
  el._lock = S.editingId === n.id;
  // 同一行、同一份数据：滚动时绝大多数行都是这种，直接跳过 DOM 写入
  if (same) return;
  el._ver = S.treeVer;
  const isRoot = !!r.isRoot;
  const isExp = r.isFolder && !isRoot && expanded.has(n.id);
  el.className = "tnode" + (isRoot ? " root" : " folder") + (isExp ? " expanded" : "") +
    (n.id === S.currentFolderId ? " current" : "") + cutClass(n.id);
  o.chev.classList.toggle("empty", isRoot || !(r.isFolder && (n.children || []).length));
  el.style.paddingLeft = 6 + r.depth * 20 + "px";
  if (isRoot) {
    o.ico.innerHTML = ICON.nav;   // 虚拟根画书签图标（与文件夹区分）
  } else {
    setRowIcon(o.ico, n, r.isFolder);
  }
  if (S.editingId === n.id) {
    // 由 startRename 接管，不覆盖
  } else {
    o.name.textContent = isRoot ? "全部书签" : (n.title || "");
  }
  const cnt = r.isFolder ? (recLinks.get(n.id) || 0) : 0;
  o.chip.textContent = cnt ? fmt.format(cnt) : "";
  o.chip.style.display = cnt ? "" : "none";
}

export function toggleExpand(id) {
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  renderTree(true);
}

export async function onTreeClick(r) {
  const n = r.node;
  if (!n) return;
  if (!r.isRoot) expanded.add(n.id);
  await goTo(n.id);   // 文件夹 = 进入（虚拟根 = 回根目录）
}

// 左栏键盘 ↑/↓：按可见树序在文件夹间移动，语义与点击树行完全同一条路径。
// 光标 = 选中行；无选中时以**当前所在目录**为锚（树行高亮本来就是位置，不是选中）。
// 返回落点下标（调用方据此滚入视口）；无行可落 = null。
export function moveTreeCursor(delta) {
  const selIdx = S.sel.size ? S.treeView.findIndex((r) => S.sel.has(r.node.id)) : -1;
  const curIdx = S.treeView.findIndex((r) => r.node.id === S.currentFolderId);
  const cur = selIdx >= 0 ? selIdx : curIdx;
  const next = Math.max(0, Math.min(S.treeView.length - 1, cur + delta));
  const r = S.treeView[next];
  if (!r) return null;
  onTreeClick(r);
  return next;
}

// 左栏键盘 ←/→：折叠/展开当前树节点（虚根无操作）。返回 true = 命中并已处理。
export function toggleCurrentTreeFolder(open) {
  const r = S.treeView.find((x) => S.sel.has(x.node.id))
    || S.treeView.find((x) => x.node.id === S.currentFolderId);
  if (!r || !r.isFolder || r.isRoot) return false;
  if (open && !expanded.has(r.node.id)) toggleExpand(r.node.id);
  if (!open && expanded.has(r.node.id)) toggleExpand(r.node.id);
  return true;
}
