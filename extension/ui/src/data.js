// 数据索引与排序（由 ui/manager.js 拆分而来）

import { S, nodeById, parentOf, recLinks } from "./state.js";
import { $, TITLE_COLLATOR } from "./dom.js";

export function indexTree() {
  nodeById.clear(); parentOf.clear(); recLinks.clear();
  function walk(node, parent) {
    nodeById.set(node.id, node);
    parentOf.set(node.id, parent);
    let n = 0;
    if (node.children) for (const c of node.children) n += walk(c, node.id);
    if (node.url) n = 0; else recLinks.set(node.id, n + (node.children ? 0 : 0));
    return node.url ? 1 : n;
  }
  if (S.rootNode) {
    nodeById.set("0", S.rootNode);
    for (const c of S.treeRoots) walk(c, "0");
  }
  recLinks.set("0", S.treeRoots.reduce((a, c) => a + (c.url ? 1 : (recLinks.get(c.id) || 0)), 0));
}

export function flattenAll(node, path, out) {
  for (const c of node.children || []) {
    const isFolder = !c.url;
    out.push({
      id: c.id, title: c.title || "", url: c.url || "", isFolder,
      path, node: c,
      t: (c.title || "").toLowerCase(),
      u: (c.url || "").toLowerCase(),
      p: path.toLowerCase(),
    });
    if (isFolder) flattenAll(c, path ? path + " › " + c.title : (c.title || ""), out);
  }
  return out;
}

// 部分浏览器（如本机这份）只有一个出厂抽屉「Bookmarks」，无法把分类挂到虚根 id=0。
// 此时把该抽屉视为透明：全部书签下直接露出其一级子文件夹。
export function soleDrawer() {
  return S.treeRoots.length === 1 && S.treeRoots[0] && !S.treeRoots[0].url ? S.treeRoots[0] : null;
}

export function rootFolderChildren() {
  const d = soleDrawer();
  return d ? (d.children || []) : S.treeRoots;
}

export function childrenOf(id) {
  if (id === "0") return rootFolderChildren();
  const n = nodeById.get(id);
  return (n && n.children) || [];
}

export function pathOf(id) {
  const segs = [];
  let cur = id;
  while (parentOf.has(cur) && parentOf.get(cur) !== "0") {
    cur = parentOf.get(cur);
    const n = nodeById.get(cur);
    if (n) segs.unshift(n);
  }
  // 面包屑跳过唯一出厂抽屉，避免「全部书签 › Bookmarks › 网络」
  const d = soleDrawer();
  if (d && segs[0] && segs[0].id === d.id) segs.shift();
  return segs;
}

export function sortCmp() {
  const { field, dir } = S.sort;
  return (a, b) => {
    let v;
    if (field === "dateAdded") v = (a.dateAdded || 0) - (b.dateAdded || 0);
    else v = TITLE_COLLATOR.compare(a.title || "", b.title || "");
    return v * dir;
  };
}

export function qSortCmp() {
  const { field, dir } = S.qSort;
  const byTitle = (a, b) => TITLE_COLLATOR.compare(a.title || "", b.title || "");
  return (a, b) => {
    let v;
    if (field === "url") v = TITLE_COLLATOR.compare(a.url || "", b.url || "");
    else if (field === "path") v = TITLE_COLLATOR.compare(a.path || "", b.path || "");
    else v = byTitle(a, b);
    if (v === 0 && field !== "title") v = byTitle(a, b);
    return v * dir;
  };
}

// 搜索结果：文件夹块恒在书签块之前，两块各自按当前排序键排（方向只作用于块内）
export function sortSearchRows(rows) {
  const cmp = qSortCmp();
  const folders = [], links = [];
  for (const r of rows) (r.isFolder ? folders : links).push(r);
  folders.sort(cmp); links.sort(cmp);
  return folders.concat(links);
}

export function folderRows(id) {
  // 根目录：多抽屉时列出厂抽屉；单抽屉时直接列出其内容（对用户等于「全部书签」根）
  if (id === "0") {
    if (!soleDrawer()) return S.treeRoots.slice();
    // fall through：按普通文件夹排 sole drawer 的孩子
  }
  const kids = childrenOf(id);
  const folders = [], links = [];
  for (const n of kids) (n.url ? links : folders).push(n);
  const cmp = sortCmp();
  folders.sort(cmp); links.sort(cmp);
  return S.sort.dir < 0 ? links.concat(folders) : folders.concat(links);
}

export function fmtDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function favUrl(u) {
  try { return chrome.runtime.getURL("/_favicon/?pageUrl=" + encodeURIComponent(u) + "&size=32"); }
  catch (e) { return ""; }
}
