// 导航与刷新（由 ui/manager.js 拆分而来）

import { S, expanded, nodeById, parentOf } from "./state.js";
import { op, setStatus, toast } from "./chan.js";
import { childrenOf, indexTree, pathOf } from "./data.js";
import { esc } from "./details.js";
import { $, busyEl, crumbsEl, fmt, listEl, qEl } from "./dom.js";
import { applyListWindow, itemHeight, itemOffsetTop, renderList, syncSelection } from "./list.js";
import { runSearch } from "./search.js";
import { renderTree } from "./tree.js";

export async function goTo(id, opts = {}) {
  await navigate(id, opts);
}

export async function navigate(id, { push = true } = {}) {
  if (id !== S.currentFolderId) {
    if (push) { S.backStack.push(S.currentFolderId); S.fwdStack.length = 0; }
    S.currentFolderId = id;
    // 换了文件夹就不保留选中：否则「刚进入的那个文件夹」会一直挂在选中集里，
    // 之后按 Delete 或点详情栏的删除按钮，删掉的就是整个文件夹（连同里面的书签）。
    S.sel.clear(); S.anchor = null;
  }
  // 展开到该目录所在链，便于树可见
  let cur = id;
  while (parentOf.has(cur) && parentOf.get(cur) !== "0") { expanded.add(cur); cur = parentOf.get(cur); }
  await refresh({ busy: false, entering: true, counts: true });
}

export function back() { if (!S.backStack.length) return; S.fwdStack.push(S.currentFolderId); S.currentFolderId = S.backStack.pop(); refresh({ entering: true, counts: true }); }

export function forward() { if (!S.fwdStack.length) return; S.backStack.push(S.currentFolderId); S.currentFolderId = S.fwdStack.pop(); refresh({ entering: true, counts: true }); }

export function up() {
  if (S.currentFolderId === "0") return;
  const p = parentOf.get(S.currentFolderId) || "0";
  goTo(p);
}

export function renderCrumbs() {
  const segs = pathOf(S.currentFolderId);
  const items = [{ id: "0", title: "全部书签" }, ...segs.map((n) => ({ id: n.id, title: n.title || "(无标题)" }))];
  if (S.currentFolderId !== "0" && !segs.some((n) => n.id === S.currentFolderId)) {
    const n = nodeById.get(S.currentFolderId);
    items.push({ id: S.currentFolderId, title: n ? (n.title || "(无标题)") : "" });
  }
  let html = "";
  items.forEach((it, i) => {
    const last = i === items.length - 1;
    if (i > 0) html += '<span class="crumbsep">›</span>';
    html += '<button class="crumb' + (last ? " last" : "") + '" data-id="' + esc(it.id) + '" type="button">' + esc(it.title) + "</button>";
  });
  crumbsEl.innerHTML = html;
  crumbsEl.querySelectorAll(".crumb").forEach((b) => {
    b.addEventListener("click", () => goTo(b.dataset.id));
  });
}

export function updateNavButtons() {
  $("#btnBack").disabled = !S.backStack.length;
  $("#btnFwd").disabled = !S.fwdStack.length;
  $("#btnUp").disabled = S.currentFolderId === "0";
}

export function updateStatusCounts() {
  if (S.viewMode !== "browse") return;
  const kids = childrenOf(S.currentFolderId);
  const f = kids.filter((x) => !x.url).length;
  setStatus("共 " + fmt.format(kids.length) + " 项（" + fmt.format(f) + " 个文件夹 / " + fmt.format(kids.length - f) + " 个书签）");
}

export async function refresh({ busy = true, entering = false, fresh = false, counts = false } = {}) {
  if (busy) busyEl.hidden = false;
  try {
    const { tree } = await op("bookmark.tree", { fresh });
    S.rootNode = tree[0];
    S.treeRoots = (S.rootNode && S.rootNode.children) || [];
    indexTree();
    S.allRows = null;   // 展平表只服务搜索：这里先作废，等真的搜索时再建（见 runSearch）
    if (!nodeById.has(S.currentFolderId)) { S.currentFolderId = "0"; S.backStack = []; S.fwdStack = []; }
    renderCrumbs();
    updateNavButtons();
    for (const id of [...S.sel]) if (!nodeById.has(id)) S.sel.delete(id);
    renderTree(entering);
    if (S.viewMode === "browse") { renderList(entering); if (counts) updateStatusCounts(); }
    if (S.viewMode === "search" && qEl.value.trim()) runSearch(false);
    syncSelection();
    window.__bpStats = { nodes: nodeById.size, view: S.viewRows.length, mode: S.viewMode };
  } catch (e) {
    toast(String((e && e.message) || e), { error: true });
  } finally {
    busyEl.hidden = true;
  }
}

export function scrollIdIntoView(id) {
  const idx = S.viewRows.findIndex((v) => v.node.id === id);
  if (idx < 0) return;
  const h = itemHeight();
  const y = itemOffsetTop(idx);
  if (y < listEl.scrollTop || y + h > listEl.scrollTop + listEl.clientHeight) {
    listEl.scrollTop = Math.max(0, y - listEl.clientHeight / 2 + h);
  }
  // 同步铺窗口（不再排 30ms 定时器，也不再重算整份列表）：
  // 定时器会让这一帧先画出空白，重算 5 万行则让每次定位都白等几十毫秒
  applyListWindow(false);
}
