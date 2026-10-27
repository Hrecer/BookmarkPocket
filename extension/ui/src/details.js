// 详情栏（由 ui/manager.js 拆分而来）

import { S, nodeById, parentOf, recLinks, clearRenamePair } from "./state.js";
import { askDeleteFromPane } from "./crud.js";
import { childrenOf, favUrl, fmtDate, pathOf } from "./data.js";
import { ICON, details2El, detailsEl, fmt } from "./dom.js";
import { openEditorFor, startRenameSelected } from "./edit.js";
import { goTo } from "./nav.js";
import { locateRow, openSearchNode } from "./search.js";
import { copyText, isFixedRoot } from "./transfer.js";

export function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }

export function renderDetails() {
  const nodes = [...S.sel].map((id) => nodeById.get(id)).filter(Boolean);
  if (S.viewMode === "search") renderDetailsPane(details2El, nodes, "search");
  else renderDetailsPane(detailsEl, nodes, "browse");
}

export function renderDetailsPane(container, nodes, ctx) {
  if (!container) return;
  const pick = (q) => container.querySelector(q);
  if (!nodes.length) {
    container.innerHTML = '<div class="dempty"><div class="dempty-badge">' + ICON.eye + "</div><p>未选择任何项目</p><p>单击列表项查看详情</p></div>";
    return;
  }
  if (nodes.length > 1) {
    const folders = nodes.filter((n) => !n.url).length;
    const links = nodes.length - folders;
    // 详情栏不提供删文件夹的入口：含文件夹时把删除按钮换成一行提示，
    // 并点明正确去处（搜索页要回浏览页，浏览页就在顶上工具栏）
    const delHtml = folders
      ? '<div class="dstats-hint">含文件夹，' + (ctx === "search" ? "请回「浏览」页用工具栏的「删除」按钮" : "请用工具栏的「删除」按钮") + "</div>"
      : '<div class="dstats-del"><button id="dstatsDel" class="tbtn">' + ICON.trash + " 删除所选</button></div>";
    container.innerHTML = '<div class="details-inner"><div class="dcard dstats">' +
      '<div class="dstats-icon">' + ICON.pin + "</div>" +
      '<div class="dstats-title">已选中 ' + fmt.format(nodes.length) + " 项</div>" +
      '<div class="dstats-chips">' + (folders ? '<span class="dchip">' + fmt.format(folders) + " 个文件夹</span>" : "") +
      (links ? '<span class="dchip">' + fmt.format(links) + " 个书签</span>" : "") + "</div>" +
      '<div class="dstats-hint">Ctrl 单击可增减选择 · 点空白处取消</div>' +
      delHtml +
      "</div></div>";
    const b = pick("#dstatsDel");
    if (b) b.addEventListener("click", askDeleteFromPane);
    return;
  }
  const n = nodes[0];
  const isFolder = !n.url;
  const fixed = isFixedRoot(n.id);   // 出厂抽屉：浏览器写死，不可改名/删除
  const parent = parentOf.get(n.id);
  const parentPath = parent && parent !== "0" ? pathOf(n.id).map((x) => x.title || "").join(" › ") : "全部书签";
  let html = '<div class="details-inner">';
  // 头卡
  const icoHtml = isFolder ? ICON.folder : (n.url && /^https?:/i.test(n.url) ? '<img id="dheadFav" alt="">' : ICON.link);
  html += '<div class="dhead"><div class="dhead-ico">' + icoHtml + '</div><div class="dhead-name">' + esc(n.title || "") + "</div></div>";
  // URL 卡
  if (!isFolder) {
    html += '<div class="dcard"><div class="durl"><span class="durl-text">' + esc(n.url) + "</span>" +
      '<button class="copybtn" id="dCopyUrl" title="复制网址">' + ICON.copy + "</button></div></div>";
  }
  // 信息卡
  html += '<div class="dcard"><div class="dlabel">信息</div>';
  html += '<div class="irow"><span class="iico">' + ICON.folder + "</span><span class=\"ilabel\">位置</span><span class=\"ivalue\">" + esc(parentPath) + "</span><span></span></div>";
  if (isFolder) {
    const f = childrenOf(n.id).filter((x) => !x.url).length;
    html += '<div class="irow"><span class="iico">' + ICON.link + '</span><span class="ilabel">内容</span><span class="ivalue accent">' + fmt.format(recLinks.get(n.id) || 0) + " 个书签 · " + fmt.format(f) + " 个文件夹</span><span></span></div>";
  }
  html += '<div class="irow"><span class="iico">' + ICON.clock + '</span><span class="ilabel">添加时间</span><span class="ivalue">' + esc(fmtDate(n.dateAdded) || "—") + "</span><span></span></div>";
  html += '<div class="irow"><span class="iico">' + ICON.hash + '</span><span class="ilabel">ID</span><span class="ivalue mono">' + esc(n.id) + '</span><button class="copybtn icopy" id="dCopyId" title="复制 ID">' + ICON.copy + "</button></div>";
  html += "</div>";
  // 动作卡：搜索视图多一枚「跳转」（对齐 C# 搜索页的跳转入口；浏览页项就在眼前，无需再跳）
  html += '<div class="dcard"><div class="dlabel">操作</div>';
  if (ctx === "search") {
    html += '<div class="dpills">' +
      '<button id="dOpen" class="tbtn">' + ICON.open + (isFolder ? " 打开" : " 打开网站") + "</button>" +
      '<button id="dJump" class="tbtn">' + ICON.nav + " 跳转</button></div>";
  } else {
    html += '<div class="dpills"><button id="dOpen" class="tbtn span2">' + ICON.open + (isFolder ? " 打开" : " 打开网站") + "</button></div>";
  }
  html += '<div class="dicons">' +
    (!isFolder ? '<button id="dEdit" class="tbtn" title="编辑">' + ICON.edit + "</button>" : "") +
    (ctx === "browse" && !fixed ? '<button id="dRename" class="tbtn" title="重命名 (F2)">' + ICON.pencil + "</button>" : "") +
    // 文件夹不走详情栏删除：一次误点就是整棵子树没了，只留工具栏那一个入口
    (!isFolder && !fixed ? '<button id="dDelete" class="tbtn danger" title="删除 (Delete)">' + ICON.trash + "</button>" : "") +
    "</div></div></div>";
  container.innerHTML = html;

  const fav = pick("#dheadFav");
  if (fav) { fav.src = favUrl(n.url); fav.onerror = () => { const h = pick(".dhead-ico"); if (h) h.innerHTML = ICON.link; }; }
  const bindCopy = (q, text) => { const b = pick(q); if (b) b.addEventListener("click", () => copyText(text)); };
  bindCopy("#dCopyUrl", n.url);
  bindCopy("#dCopyId", n.id);
  const bOpen = pick("#dOpen");
  if (bOpen) bOpen.addEventListener("click", () => { if (ctx === "search") openSearchNode(nodeById.get(n.id) || n); else openNode(n); });
  const bJump = pick("#dJump");
  if (bJump) bJump.addEventListener("click", () => locateRow({ id: n.id }));
  const bEdit = pick("#dEdit");
  if (bEdit) bEdit.addEventListener("click", () => openEditorFor(nodeById.get(n.id) || n));
  const bRename = pick("#dRename");
  if (bRename) bRename.addEventListener("click", () => startRenameSelected());
  const bDelete = pick("#dDelete");
  if (bDelete) bDelete.addEventListener("click", askDeleteFromPane);
}

export function openNode(n) {
  clearRenamePair();   // 打开是另一种手势：双击打开后返回，第一击只能重新待命
  if (!n) return;
  if (n.url) chrome.tabs.create({ url: n.url });
  else goTo(n.id);
}
