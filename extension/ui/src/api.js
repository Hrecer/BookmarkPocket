// 测试接口：把内部接口按模块再导出一次，供 extension/test/manager.smoke.mjs 驱动。
// 页面本身不 import 它。

export { S } from "./state.js";
export { anchorScrollTop, centerAnchor } from "./anchor.js";
export { op, setStatus, toast } from "./chan.js";
export { askDelete, askDeleteFromPane, doDeleteConfirmed, doUndo } from "./crud.js";
export { childrenOf, favUrl, flattenAll, fmtDate, folderRows, indexTree, pathOf, sortCmp } from "./data.js";
export { renderDetails, renderDetailsPane } from "./details.js";
export { newFolder, openEditor, saveEditor, startRenameSelected } from "./edit.js";
export { applyAllWindows, applyListWindow, clearSel, favCache, prefetchFavicons, renderList, selectOne, setRowIcon, setStaticIcon, syncSelection } from "./list.js";
export { back, forward, goTo, navigate, refresh, renderCrumbs, up } from "./nav.js";
export { locateRow, renderSearch, runSearch, setQSort, switchView } from "./search.js";
export { openRulesPicker, pickChoose, pickToggle, refreshRulesUI } from "./rulesview.js";
export { applyTheme, cycleTheme, loadSettings, readThemeMode } from "./shell.js";
export { expandToCurrent } from "./shortcuts.js";
export { cancelCut, doCopy, doCut, executeTransfer, pasteInto } from "./transfer.js";
export { applyTreeWindow, buildTreeRows, renderTree, toggleExpand } from "./tree.js";
