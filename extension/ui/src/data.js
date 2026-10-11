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

export function childrenOf(id) {
  if (id === "0") return S.treeRoots;
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

export function folderRows(id) {
  if (id === "0") return S.treeRoots.slice();   // 出厂抽屉（收藏夹栏/其他收藏夹）：浏览器写死的顺序，不参与排序
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
