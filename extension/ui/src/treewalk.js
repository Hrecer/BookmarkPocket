// 书签树的「可见行」口径：左栏 / 「选目标文件夹」浮层共用同一套展开逻辑。
// 展开态由调用方传入——左栏用全局 expanded，浮层用自己那份 open 集合。
// 两侧都**只显示文件夹**（Windows 导航窗格口径）：链接不进树。

export function visibleRows(roots, isOpen) {
  const out = [];
  (function walk(kids, depth) {
    for (const n of kids || []) {
      if (n.url) continue;   // 链接不是导航节点：侧栏/目标选择器只列文件夹
      out.push({ node: n, depth, isFolder: true });
      if (isOpen.has(n.id)) walk(n.children || [], depth + 1);
    }
  })(roots, 0);
  return out;
}

// 全部文件夹（不看展开态），顺带算出完整路径与「有没有子文件夹」。
// 路径口径与 ops.js 的 addPaths 一致：文件夹的 path 含自身。
export function flatFolders(roots) {
  const out = [];
  (function walk(kids, prefix) {
    for (const n of kids || []) {
      if (n.url) continue;
      const self = prefix.concat(n.title || "");
      out.push({ node: n, path: self.join(" > "), hasKids: (n.children || []).some((c) => !c.url) });
      walk(n.children, self);
    }
  })(roots, []);
  return out;
}
