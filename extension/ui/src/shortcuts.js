// 快捷键与分栏拖拽（由 ui/manager.js 拆分而来）

import { S, expanded, nodeById, parentOf } from "./state.js";
import { pathOf } from "./data.js";
import { T_ROW_H, listEl, treeEl } from "./dom.js";
import { applyListWindow, itemHeight, itemOffsetTop } from "./list.js";
import { copyText } from "./transfer.js";
import { applyTreeWindow, renderTree } from "./tree.js";

export function expandToCurrent() {
  let cur = S.currentFolderId;
  while (parentOf.has(cur) && parentOf.get(cur) !== "0") { expanded.add(cur); cur = parentOf.get(cur); }
  renderTree(false);
  const idx = S.treeView.findIndex((r) => r.node.id === S.currentFolderId);
  if (idx >= 0) ensureTreeVisible(idx);
}

export async function copyPath() {
  const ids = [...S.sel];
  let text;
  if (ids.length) {
    text = ids.map((id) => {
      const parts = pathOf(id).map((x) => x.title || "(无标题)");
      const n = nodeById.get(id);
      if (n) parts.push(n.url ? (n.title || n.url || "") : (n.title || "(无标题)"));
      return parts.join(" › ");
    }).join("\n");
  } else {
    text = pathOf(S.currentFolderId).map((x) => x.title || "").join(" › ") || "全部书签";
  }
  await copyText(text);
}

export function ensureListVisible(i) {
  const h = itemHeight();
  const y = itemOffsetTop(i);
  if (y < listEl.scrollTop || y + h > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = Math.max(0, y - listEl.clientHeight / 2);
  applyListWindow(false);   // 只挪窗口：方向键连按时不再重排整份列表
}

export function ensureTreeVisible(i) {
  const y = i * T_ROW_H;
  if (y < treeEl.scrollTop || y + T_ROW_H > treeEl.scrollTop + treeEl.clientHeight) treeEl.scrollTop = Math.max(0, y - treeEl.clientHeight / 2);
  applyTreeWindow(false);
}

export function initSplitter(sp) {
  if (!sp) return;
  const panes = sp.closest(".panes, .searchpanes");
  let dragging = false;
  sp.addEventListener("pointerdown", (e) => {
    dragging = true; sp.classList.add("dragging");
    sp.setPointerCapture(e.pointerId);
  });
  sp.addEventListener("pointermove", (e) => {
    if (!dragging || !panes) return;
    const rect = panes.getBoundingClientRect();
    const w = Math.max(230, Math.min(400, rect.right - e.clientX));
    document.documentElement.style.setProperty("--details-w", w + "px");
  });
  sp.addEventListener("pointerup", () => { dragging = false; sp.classList.remove("dragging"); });
}
