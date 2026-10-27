// 导航与刷新（由 ui/manager.js 拆分而来）

import { S, expanded, nodeById, parentOf, clearRenamePair } from "./state.js";
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

// 从 descendantId 往上找，返回「它落在 ancestorId 名下时」那一层的直接子节点 id。
// 只服务「退出文件夹」语义（返回上级 / 后退 / 点面包屑祖先段）：父目录里选中刚退出的子文件夹。
// 平级跳转 / 进入子目录都返回 null。
function childOnPath(ancestorId, descendantId) {
  let cur = descendantId;
  while (cur && cur !== ancestorId) {
    const p = parentOf.get(cur);
    if (!p) return null;
    if (p === ancestorId) return cur;
    cur = p;
  }
  return null;
}

function expandTo(id) {
  let cur = id;
  while (parentOf.has(cur) && parentOf.get(cur) !== "0") { expanded.add(cur); cur = parentOf.get(cur); }
}

// selectExitedChild = 「退出文件夹」收尾：导航落地后把刚退出的那一层子文件夹写进选中集合。
// 唯一判据是导航前后的目录关系，不读当前选中集合——在子目录里点空白清过选中、或选中过链接，
// 退出后来源都不会丢。树行点击 / 跳转定位 / 前进都不传（那是"跳转"，不是"退出"）。
export async function navigate(id, { push = true, selectExitedChild = false } = {}) {
  clearRenamePair();   // 导航是另一种手势：返回后的第一击只能重新待命
  if (id !== S.currentFolderId) {
    const prev = S.currentFolderId;
    if (push) { S.backStack.push(prev); S.fwdStack.length = 0; }
    S.currentFolderId = id;
    // 换了文件夹就不保留选中：否则「刚进入的那个文件夹」会一直挂在选中集里，
    // 之后按 Delete 或点详情栏的删除按钮，删掉的就是整个文件夹（连同里面的书签）。
    S.sel.clear(); S.anchor = null;
    const cameFrom = selectExitedChild && prev ? childOnPath(id, prev) : null;
    if (cameFrom) S.sel = new Set([cameFrom]);
    // 滚动位置也按目录归零：否则在子文件夹里滚到底，回到父文件夹还停在底部。
    listEl.scrollTop = 0;
    listEl._mark = 0;   // 同步滚动标记，免得被判成「用户超大幅滚动」而短暂停掉图标
    expandTo(id);
    await refresh({ busy: false, entering: true, counts: true });
    if (cameFrom) {
      scrollIdIntoView(cameFrom);
      const idx = S.viewRows.findIndex((v) => v.node.id === cameFrom);
      if (idx >= 0) S.anchor = idx;
    }
    return;
  }
  expandTo(id);
  await refresh({ busy: false, entering: true, counts: true });
}

// 前进/后退同样走 navigate，好让「滚动归零 + 选中来源子文件夹」这套只写一处。
export async function back() {
  if (!S.backStack.length) return;
  S.fwdStack.push(S.currentFolderId);
  await navigate(S.backStack.pop(), { push: false, selectExitedChild: true });
}

export async function forward() {
  if (!S.fwdStack.length) return;
  S.backStack.push(S.currentFolderId);
  await navigate(S.fwdStack.pop(), { push: false });
}

export function up() {
  if (S.currentFolderId === "0") return;
  goTo(parentOf.get(S.currentFolderId) || "0", { selectExitedChild: true });
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
    b.addEventListener("click", () => goTo(b.dataset.id, { selectExitedChild: true }));
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
  clearRenamePair();   // 刷新会重建行，作废旧的两击对
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
