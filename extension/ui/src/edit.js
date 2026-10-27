// 行内改名与新建（由 ui/manager.js 拆分而来）

import { S, lPool, nodeById, tPool, clearRenamePair } from "./state.js";
import { op, setStatus, toast } from "./chan.js";
import { $ } from "./dom.js";
import { syncSelection } from "./list.js";
import { startCardEdit } from "./card-ops.js";
import { refresh, scrollIdIntoView } from "./nav.js";

export function startRenameList(idx) {
  const r = S.viewRows[idx];
  if (!r) return;
  const el = lPool.find((x) => x.style.display !== "none" && Number(x.dataset.idx) === idx);
  if (el) startRenameIn(el._.nm, r.node);
}

export function startRenameSelected() {
  const nodes = [...S.sel].map((id) => nodeById.get(id)).filter(Boolean);
  if (nodes.length !== 1) { toast("请先选中一个项目"); return; }
  // 卡片模式：F2 就地编辑（书签改标题+网址，文件夹只改标题，与卡片上的「编辑」按钮同一套）
  if (S.cardMode) { startCardEdit(nodes[0].id); return; }
  if (S.lastPane === "tree") {
    const row = tPool.find((x) => x.style.display !== "none" && S.treeView[Number(x.dataset.idx)] && S.treeView[Number(x.dataset.idx)].node.id === nodes[0].id);
    if (row) { startRenameIn(row._.name, nodes[0]); return; }
  }
  const idx = S.viewRows.findIndex((v) => v.node.id === nodes[0].id);
  if (idx < 0) { toast("请先进入它所在的文件夹再改名"); return; }
  const el = lPool.find((x) => x.style.display !== "none" && Number(x.dataset.idx) === idx);
  if (el) startRenameIn(el._.nm, nodes[0]);
  else { scrollIdIntoView(nodes[0].id); toast("已定位，请再按一次 F2 改名"); }
}

export function startRenameIn(nameEl, node) {
  clearRenamePair();   // F2 / 右键菜单 / 新建后改名都算插入动作，不得留下「下一击进改名」的待命
  if (S.editingId) return;
  if (!nameEl) { toast("请先选中列表里可见的项目"); return; }
  S.editingId = node.id;
  // 这一行改名期间不参与虚拟滚动复用（回收会拆掉输入框，隐藏会让它失焦误提交）
  const rowEl = nameEl.closest(".row, .tnode");
  if (rowEl) rowEl._lock = true;
  const input = document.createElement("input");
  input.className = "inline-edit";
  input.value = node.title || "";
  const host = nameEl;
  host.textContent = "";
  host.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    S.editingId = null;
    if (rowEl) rowEl._lock = false;   // 改名结束，这一行可以重新参与复用了
    if (!commit || !v || v === (node.title || "")) {
      host.textContent = node.title || "";
      return;
    }
    op("bookmark.update", { id: node.id, title: v }).then(() => {
      node.title = v;
      host.textContent = v;
      setStatus("已重命名为「" + v + "」");
      refresh({ busy: false });
    }).catch((e) => {
      host.textContent = node.title || "";
      toast(String((e && e.message) || e), { error: true });
    });
  };
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

export async function newFolder() {
  if (S.currentFolderId === "0") { toast("「全部书签」是虚拟根，不能新建——请先进入一个文件夹", { error: true }); return; }
  try {
    const res = await op("bookmark.create", { parentId: S.currentFolderId, title: "新建文件夹" });
    await refresh({ busy: false });
    setStatus("已创建文件夹「" + (res.created.title || "新建文件夹") + "」");
    S.sel = new Set([res.created.id]);
    syncSelection();
    scrollIdIntoView(res.created.id);
    const idx = S.viewRows.findIndex((v) => v.node.id === res.created.id);
    const el = lPool.find((x) => x.style.display !== "none" && Number(x.dataset.idx) === idx);
    if (el) startRenameIn(el._.nm, nodeById.get(res.created.id) || res.created);
  } catch (e) { toast(String((e && e.message) || e), { error: true }); }
}

export let editorParent = null;

export function openEditor() {
  clearRenamePair();   // 打开编辑器是另一种手势，作废改名两击对
  if (S.currentFolderId === "0") { toast("「全部书签」是虚拟根，不能新建——请先进入一个文件夹", { error: true }); return; }
  S.editorMode = "new";
  S.editorTarget = null;
  editorParent = S.currentFolderId;
  $("#edHeadText").textContent = "新建书签";
  $("#edTitle").value = "";
  $("#edUrl").value = "";
  $("#editorOverlay").hidden = false;
  $("#edTitle").focus();
}

export function openEditorFor(n) {
  clearRenamePair();   // 打开编辑器是另一种手势，作废改名两击对
  if (!n || !n.url) return;
  S.editorMode = "edit";
  S.editorTarget = n;
  $("#edHeadText").textContent = "编辑书签";
  $("#edTitle").value = n.title || "";
  $("#edUrl").value = n.url || "";
  $("#editorOverlay").hidden = false;
  $("#edTitle").focus();
  $("#edTitle").select();
}

export function closeEditor() { $("#editorOverlay").hidden = true; }

export async function saveEditor() {
  const title = $("#edTitle").value.trim();
  const url = $("#edUrl").value.trim();
  if (!/^https?:\/\//i.test(url)) { toast("网址必须以 http:// 或 https:// 开头", { error: true }); return; }
  if (!title) { toast("请填写名称", { error: true }); return; }
  try {
    if (S.editorMode === "edit" && S.editorTarget) {
      await op("bookmark.update", { id: S.editorTarget.id, title, url });
      closeEditor();
      setStatus("已保存「" + title + "」");
    } else {
      await op("bookmark.create", { parentId: editorParent, title, url });
      closeEditor();
      setStatus("已创建书签「" + title + "」");
    }
    await refresh({ busy: false });
  } catch (e) { toast(String((e && e.message) || e), { error: true }); }
}
