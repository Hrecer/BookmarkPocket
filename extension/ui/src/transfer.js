// 剪贴板 / 拖拽 / 右键菜单（由 ui/manager.js 拆分而来）

import { S, lPool, nodeById, parentOf, qPool, tPool } from "./state.js";
import { op, setStatus, toast } from "./chan.js";
import { askDeleteFromPane, doUndo } from "./crud.js";
import { esc, openNode } from "./details.js";
import { $, busyEl, fmt, listEl } from "./dom.js";
import { newFolder, openEditorFor, startRenameSelected } from "./edit.js";
import { applyListWindow, syncSelection } from "./list.js";
import { findCardEl } from "./cards.js";
import { goTo, refresh, scrollIdIntoView } from "./nav.js";
import { applySearchWindow } from "./search.js";
import { applyTreeWindow } from "./tree.js";

export function copyText(text) {
  navigator.clipboard.writeText(String(text == null ? "" : text)).then(() => toast("已复制"), () => toast("复制失败", { error: true }));
}

// 数据没变、只是行的标记变了（剪切态这类）：跳过重算数据，只把窗口里的行重填一遍
export function refreshRows() {
  S.listVer++; S.treeVer++; S.qVer++;
  applyTreeWindow(false);
  if (S.viewMode === "browse") applyListWindow(false);
  else if (S.viewMode === "search") applySearchWindow(false);
}

export function doCopy() {
  if (!S.sel.size) return;
  S.clip = { mode: "copy", ids: [...S.sel] };
  setStatus("已复制 " + fmt.format(S.sel.size) + " 项（Ctrl+V 粘贴到当前文件夹）");
  refreshRows();
}

export function doCut() {
  if (!S.sel.size) return;
  S.clip = { mode: "cut", ids: [...S.sel] };
  setStatus("已剪切 " + fmt.format(S.sel.size) + " 项（Ctrl+V 粘贴 · Esc 取消）");
  refreshRows();
}

export function cancelCut() {
  S.clip = null;
  refreshRows();
}

export async function pasteInto(targetId) {
  if (targetId === "0") { toast("「全部书签」是浏览器的虚拟根，不能粘贴——请先进入一个文件夹", { error: true }); return; }
  if (!S.clip || !S.clip.ids.length) return;
  const target = nodeById.get(targetId);
  const name = target ? (target.title || "(无标题)") : "文件夹";
  busyEl.hidden = false;
  try {
    if (S.clip.mode === "cut") {
      const work = S.clip.ids.filter((id) => nodeById.has(id) && parentOf.get(id) !== targetId);
      let moved = 0;
      if (work.length) { const res = await op("bookmark.moveMany", { ids: work, parentId: targetId }); moved = res.moved || 0; }
      S.clip = null;
      await refresh({ busy: false, counts: true });
      if (work.length && nodeById.has(work[0])) { S.sel = new Set([work[0]]); S.anchor = null; syncSelection(); scrollIdIntoView(work[0]); }
      toast("已粘贴（移动）" + fmt.format(moved) + " 项到「" + name + "」", { action: "撤销", onAction: doUndo });
    } else {
      const res = await op("bookmark.copy", { ids: S.clip.ids, parentId: targetId });
      await refresh({ busy: false, counts: true });
      const first = (res.created || [])[0];
      if (first && nodeById.has(first)) { S.sel = new Set([first]); S.anchor = null; syncSelection(); scrollIdIntoView(first); }
      toast("已粘贴（复制）" + fmt.format(res.copied || 0) + " 项到「" + name + "」", { action: "撤销", onAction: doUndo });
    }
  } catch (e) { toast(String((e && e.message) || e), { error: true }); busyEl.hidden = true; }
}

export const dragState = { pending: null, active: false, btn: 0, ids: [], target: null, el: null, ghost: null };

export function isFixedRoot(id) { return parentOf.get(id) === "0"; }

export function canDrop(ids, folderId) {
  if (!folderId || folderId === "0") return false;   // 虚拟根不可作为落点
  const folder = nodeById.get(folderId);
  if (!folder || folder.url) return false;
  for (const id of ids) {
    if (id === folderId) return false;
    const n = nodeById.get(id);
    if (n && !n.url) {
      // 拖文件夹时：目标不能是该文件夹的子孙
      let cur = folderId;
      while (parentOf.has(cur)) {
        cur = parentOf.get(cur);
        if (cur === id) return false;
      }
    }
  }
  return true;
}

export function startDragCandidate(e, node) {
  if (S.editingId || !node || isFixedRoot(node.id)) return;   // 出厂抽屉不可拖
  if (e.button !== 0 && e.button !== 2) return;
  if (e.target.closest(".inline-edit, input, .tchev, .bcard-btn")) return;
  dragState.pending = { node, btn: e.button, x0: e.clientX, y0: e.clientY };
}

export function setDropHighlight(t) {
  if (dragState.el) dragState.el.classList.remove("dropok");
  dragState.el = null; dragState.target = null;
  if (!t || !canDrop(dragState.ids, t.folderId)) return;
  dragState.target = t.folderId;
  dragState.el = t.el;
  t.el.classList.add("dropok");
}

export function resolveDropTarget(el) {
  if (!el) return null;
  const rowEl = el.closest(".row.folder");
  if (rowEl && rowEl.closest("#list")) {
    const r = S.viewRows[Number(rowEl.dataset.idx)];
    if (r) return { folderId: r.node.id, el: rowEl };
  }
  // 卡片模式下，文件夹卡片同样是合法落点（卡片元素上带的是项下标）
  const cardEl = el.closest(".bcard.folder");
  if (cardEl && cardEl.closest("#list")) {
    const r = S.viewRows[Number(cardEl.dataset.idx)];
    if (r) return { folderId: r.node.id, el: cardEl };
  }
  const tnEl = el.closest(".tnode.folder");
  if (tnEl && tnEl.closest("#tree")) {
    const r = S.treeView[Number(tnEl.dataset.idx)];
    if (r) return { folderId: r.node.id, el: tnEl };
  }
  const crumbEl = el.closest(".crumb");
  if (crumbEl) {
    const n = nodeById.get(crumbEl.dataset.id);
    if (n && !n.url) return { folderId: n.id, el: crumbEl };
  }
  if (el.closest("#list") && !el.closest(".row, .bcard")) {
    return { folderId: S.currentFolderId, el: listEl };   // 列表空白 = 当前目录
  }
  return null;
}

export function cleanupDrag() {
  document.body.classList.remove("dragging");
  if (dragState.ghost) { dragState.ghost.remove(); dragState.ghost = null; }
  if (dragState.el) dragState.el.classList.remove("dropok");
  dragState.active = false; dragState.pending = null; dragState.ids = []; dragState.target = null; dragState.el = null;
}

export async function executeTransfer(mode, ids, targetFolderId) {
  const target = nodeById.get(targetFolderId);
  const name = target ? (target.title || "(无标题)") : "文件夹";
  const work = ids.filter((id) => nodeById.has(id) && parentOf.get(id) !== targetFolderId);
  const skipped = ids.length - work.length;
  if (!work.length) { toast("已经在「" + name + "」里了"); return; }
  busyEl.hidden = false;
  try {
    if (mode === "move") {
      const res = await op("bookmark.moveMany", { ids: work, parentId: targetFolderId });
      const tail = (res.failed && res.failed.length) ? "，失败 " + res.failed.length + " 项" : (skipped ? "（跳过 " + skipped + " 项）" : "");
      toast("已移动 " + fmt.format(res.moved || 0) + " 项到「" + name + "」" + tail, { action: "撤销", onAction: doUndo });
    } else {
      const res = await op("bookmark.copy", { ids: work, parentId: targetFolderId });
      const tail = (res.failed && res.failed.length) ? "，失败 " + res.failed.length + " 项" : "";
      toast("已复制 " + fmt.format(res.copied || 0) + " 项到「" + name + "」" + tail, { action: "撤销", onAction: doUndo });
    }
    await refresh({ busy: false, counts: true });
  } catch (e) { toast(String((e && e.message) || e), { error: true }); busyEl.hidden = true; }
}

export const ctxEl = $("#ctxmenu");

export function hideCtxMenu() { if (ctxEl) { ctxEl.hidden = true; ctxEl.innerHTML = ""; } }

export function showCtxMenu(x, y, items) {
  if (!ctxEl) return;
  ctxEl.innerHTML = items.map((it, i) =>
    it === "-" ? '<div class="ctxsep"></div>' :
    '<button class="ctxitem" data-i="' + i + '"' + (it.disabled ? " disabled" : "") + ">" + esc(it.label) + "</button>"
  ).join("");
  ctxEl.hidden = false;
  const rect = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 6)) + "px";
  ctxEl.style.top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 6)) + "px";
  ctxEl.querySelectorAll(".ctxitem").forEach((b) => {
    b.addEventListener("click", () => {
      const it = items[Number(b.dataset.i)];
      hideCtxMenu();
      if (it && it.fn) it.fn();
    });
  });
}

export function rowMenuItems(node) {
  const isFolder = !node.url;
  const fixed = isFixedRoot(node.id);
  const items = [{ label: "打开", fn: () => openNode(node) }];
  if (!isFolder) items.push({ label: "复制链接", fn: () => copyText(node.url) });
  if (isFolder && !fixed) items.push({ label: "新建文件夹", fn: async () => { await goTo(node.id); newFolder(); } });
  if (!isFolder) items.push({ label: "编辑", disabled: S.sel.size !== 1, fn: () => openEditorFor(node) });
  if (!fixed) items.push({ label: "重命名", disabled: S.sel.size !== 1, fn: () => startRenameSelected() });
  // 行菜单只有书签能删；文件夹请走工具栏的「删除」按钮
  if (!isFolder) items.push({ label: "删除", fn: () => askDeleteFromPane() });
  return items;
}

export function blankMenuItems() {
  const atRoot = S.currentFolderId === "0";
  return [
    { label: "新建文件夹", disabled: atRoot, fn: () => newFolder() },
    { label: "粘贴", disabled: atRoot || !S.clip || !S.clip.ids.length, fn: () => pasteInto(S.currentFolderId) },
    "-",
    { label: "全选", fn: () => { S.sel = new Set((S.lastPane === "tree" ? S.treeView.map((r) => r.node) : S.viewRows.map((r) => r.node)).map((n) => n.id)); syncSelection(); } },
    { label: "刷新", fn: () => refresh({ busy: true, fresh: true, entering: true, counts: true }) },
  ];
}

export function showTransferMenu(x, y, ids, targetId) {
  const target = nodeById.get(targetId);
  const name = target ? (target.title || "(无标题)") : "文件夹";
  showCtxMenu(x, y, [
    { label: "移动到「" + name + "」", fn: () => executeTransfer("move", ids, targetId) },
    { label: "复制到「" + name + "」", fn: () => executeTransfer("copy", ids, targetId) },
    "-",
    { label: "取消", fn: () => {} },
  ]);
}

export function openMenuForSelection() {
  const id = [...S.sel][0];
  if (!id) return;
  const hit = (pool, list) => pool.find((x) => x.style.display !== "none" && list[Number(x.dataset.idx)] && (list[Number(x.dataset.idx)].node ? list[Number(x.dataset.idx)].node.id : list[Number(x.dataset.idx)].row.id) === id);
  let el = hit(lPool, S.viewRows.length && S.viewMode === "browse" ? S.viewRows : []);
  if (!el) el = hit(tPool, S.treeView);
  if (!el) el = hit(qPool, S.qRows);
  if (!el && S.cardMode) el = findCardEl(id);   // 卡片模式下元素在卡池里
  if (!el) return;
  const node = nodeById.get(id);
  if (!node) return;
  const rect = el.getBoundingClientRect();
  showCtxMenu(rect.left + 60, rect.bottom - 4, rowMenuItems(node));
}
