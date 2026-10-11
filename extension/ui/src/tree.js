// 侧栏树渲染（由 ui/manager.js 拆分而来）

import { S, expanded, parentOf, recLinks, tPool } from "./state.js";
import { ICON, T_ROW_H, fmt, treeEl, trowsEl, tspacer } from "./dom.js";
import { startRenameSelected } from "./edit.js";
import { cutClass, setRowIcon, syncSelection } from "./list.js";
import { goTo, navigate, scrollIdIntoView } from "./nav.js";
import { isFixedRoot, showCtxMenu, startDragCandidate } from "./transfer.js";
import { applyWindow, windowBounds } from "./virtual.js";

export function buildTreeRows() {
  const out = [];
  (function walk(kids, depth) {
    for (const n of kids) {
      const isFolder = !n.url;
      out.push({ node: n, depth, isFolder });
      if (isFolder && expanded.has(n.id)) walk(n.children || [], depth + 1);
    }
  })(S.treeRoots, 0);
  return out;
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
    if (r && r.isFolder) { toggleExpand(r.node.id); }
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
    if (r) startDragCandidate(e, r.node);
  });
  el.addEventListener("contextmenu", (e) => {
    if (S.rightDragJustEnded) { S.rightDragJustEnded = false; e.preventDefault(); return; }
    const r = S.treeView[Number(el.dataset.idx)];
    e.preventDefault();
    if (!r) return;
    if (!r.isFolder || isFixedRoot(r.node.id)) return;   // 树叶与出厂抽屉不挂菜单（照 LinkPocket 虚根口径）
    S.lastPane = "tree";
    S.sel = new Set([r.node.id]); S.anchor = null; syncSelection();
    showCtxMenu(e.clientX, e.clientY, [
      { label: "重命名", disabled: S.sel.size !== 1, fn: () => startRenameSelected() },
      // 这里只可能是文件夹（树叶与出厂抽屉在上面已 return）：不给删除项，
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
  const isExp = r.isFolder && expanded.has(n.id);
  el.className = "tnode" + (r.isFolder ? " folder" : "") + (isExp ? " expanded" : "") +
    (n.id === S.currentFolderId ? " current" : "") + (S.sel.has(n.id) ? " sel" : "") + cutClass(n.id);
  o.chev.classList.toggle("empty", !(r.isFolder && (n.children || []).length));
  el.style.paddingLeft = 6 + r.depth * 20 + "px";
  setRowIcon(o.ico, n, r.isFolder);
  if (S.editingId === n.id) {
    // 由 startRename 接管，不覆盖
  } else {
    o.name.textContent = n.title || "";
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
  if (r.isFolder) {
    expanded.add(n.id);
    await goTo(n.id);
  } else {
    // 叶子：定位到所在文件夹并选中
    const pid = parentOf.get(n.id) || "0";
    await navigate(pid);
    S.sel = new Set([n.id]);
    S.anchor = null;
    syncSelection();
    scrollIdIntoView(n.id);
  }
}
