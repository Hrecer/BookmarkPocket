// 删除与排序（由 ui/manager.js 拆分而来）

import { S, nodeById, recLinks } from "./state.js";
import { op, setStatus, toast } from "./chan.js";
import { $, busyEl, fmt } from "./dom.js";
import { syncSelection } from "./list.js";
import { refresh } from "./nav.js";

// 选中集里的文件夹数量。文件夹的删除入口只保留工具栏那一个（见 askDeleteFromPane），
// 因为误删一个文件夹 = 连同里面的全部书签一起没，代价远大于误删一条书签。
export function selFolderCount() {
  let f = 0;
  for (const id of S.sel) { const n = nodeById.get(id); if (n && !n.url) f++; }
  return f;
}

// 删除入口的唯一等级划分：文件夹只有「浏览页工具栏的删除按钮」能删。
// 其余所有入口（快捷键、右键菜单、详情栏、搜索页工具栏）一律只放行书签；
// 选中里只要含文件夹就整体拒绝，并指明该去哪儿删 —— 不静默只删一半，
// 否则会出现「以为全删了、其实只删了书签」的哑巴亏。
export function askDeleteFromPane() {
  if (selFolderCount()) {
    toast("文件夹只能在「浏览」页用工具栏的「删除」按钮删除", { error: true });
    return;
  }
  askDelete();
}

export function askDelete() {
  const nodes = [...S.sel].map((id) => nodeById.get(id)).filter(Boolean);
  if (!nodes.length) return;
  const folders = nodes.filter((n) => !n.url).length;
  const links = nodes.length - folders;
  let msg;
  if (nodes.length === 1) {
    const n = nodes[0];
    if (n.url) {
      msg = "将书签「" + (n.title || "") + "」删除吗？";
    } else {
      // 文件夹会把内容一起带走：把影响面写成一行附在问句后面，不加第二层确认
      const inside = recLinks.get(n.id) || 0;
      msg = "将文件夹「" + (n.title || "") + "」删除吗？" +
        (inside ? "其中的 " + fmt.format(inside) + " 个书签会一并删除。" : "");
    }
  } else if (!folders) {
    msg = "将选中的 " + links + " 个书签删除吗？";
  } else if (!links) {
    const inside = nodes.reduce((a, n) => a + (recLinks.get(n.id) || 0), 0);
    msg = "将选中的 " + folders + " 个文件夹删除吗？" +
      (inside ? "其中的 " + fmt.format(inside) + " 个书签会一并删除。" : "");
  } else {
    msg = "将选中的 " + folders + " 个文件夹和 " + links + " 个书签删除吗？";
  }
  $("#cfTitle").textContent = "删除";
  $("#cfMsg").textContent = msg;
  $("#confirmOverlay").hidden = false;
  $("#cfOk").focus();
}

export function closeConfirm() { $("#confirmOverlay").hidden = true; }

export async function doDeleteConfirmed() {
  closeConfirm();
  const ids = [...S.sel];
  if (!ids.length) return;
  busyEl.hidden = false;
  try {
    const res = await op("bookmark.remove", { ids });
    S.sel.clear(); S.anchor = null;
    toast("已删除 " + fmt.format(res.removed) + " 项", { action: "撤销", onAction: doUndo });
    // 删除改的是「当前文件夹计数」：立即刷新状态栏的数字。
    // 删除反馈由上面的 toast（带撤销）承担，状态栏不再被那条文案占用。
    await refresh({ busy: false, counts: true });
    syncSelection();
  } catch (e) {
    toast(String((e && e.message) || e), { error: true });
    busyEl.hidden = true;
  }
}

export async function doUndo() {
  try {
    const r = await op("bookmark.undoLast");
    setStatus("已撤销：" + (r.summary || r.undone));
    await refresh({ busy: false, entering: true });
  } catch (e) { toast(String((e && e.message) || e), { error: true }); }
}

export function updateSortIndicators() {
  document.querySelectorAll("button.col[data-sort]").forEach((btn) => {
    const ind = btn.querySelector(".sortind");
    ind.textContent = btn.dataset.sort === S.sort.field ? (S.sort.dir > 0 ? "▲" : "▼") : "";
  });
}
