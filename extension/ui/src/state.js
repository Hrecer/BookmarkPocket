// 跨模块共享状态（由 ui/manager.js 拆分而来）
//
// 只有「顶层 let/var 且被两个以上模块读写」的才进 S —— 模块间无法给 import 进来的
// 绑定重新赋值，所以可变状态必须挂在一个对象上。const 不在此列：它导出的是同一个引用。

export const nodeById = new Map();
export const parentOf = new Map();
export const recLinks = new Map();     // 文件夹 → 递归书签数（树/行内 chip 用）
export const expanded = new Set();     // 会话内展开（不持久化，照 LinkPocket）
export const tPool = [], lPool = [], qPool = [];
// 卡片模式的行池：每个池元素是一「逻辑行」（内含若干张卡片）。浏览页与搜索页各一套。
export const cPool = [], qcPool = [];

// 改名两击对的间隔下限（毫秒）：第二击必须距第一击至少这么久才算「刻意的两击」，
// 选中后顺手再点一下（看详情等）绝不误触改名。
export const RENAME_PAIR_MIN_MS = 800;
// 改名两击对的间隔上限（毫秒）：第一击待命后超过它再点 = 不构成对（需重新起一对），
// 避免「选中很久之后再点一下」直接进改名。
export const RENAME_PAIR_WINDOW_MS = 5000;

// 作废改名两击对：双击的第二击、拖拽、右键菜单、打开详情/编辑器、导航与刷新等
// 任何其它手势都会调用它，保证下一击只能重新「待命」。
export function clearRenamePair() {
  S.renamePair = { id: null, t: 0 };
}

export const S = {
  treeRoots: [],
  rootNode: null,
  allRows: null,
  currentFolderId: "0",
  backStack: [],
  fwdStack: [],
  sel: new Set(),
  anchor: null,
  lastPane: "list",
  sort: { field: "title", dir: 1 },
  editingId: null,
  viewMode: "browse",
  viewRows: [],
  qRows: [],
  // 就地改名的「两击对」：单击永不改名（第一击只待命），第二击才可能改名。
  // 一对必须由连续两次无修饰键的普通单击构成，且同一行、间隔 ∈ [RENAME_PAIR_MIN_MS, RENAME_PAIR_WINDOW_MS]。
  renamePair: { id: null, t: 0 },
  qanchor: null,
  qActive: { title: true, url: true, path: true },
  qLast: "",
  clip: null,
  suppressClick: false,
  rightDragJustEnded: false,
  editorMode: "new",
  editorTarget: null,
  treeView: [],
  treeVer: 0,
  listVer: 0,
  qVer: 0,
  bkmTimer: 0,
  // 卡片模式：浏览页与搜索页各自独立开关（互不影响），cardMode 只是「当前视图」的影子，
  // 供 F2 这类只看当前页的代码读，避免每处都去判断 viewMode。
  cardMode: false,
  browseCard: false,
  searchCard: false,
  cardCols: 3,
  qCardCols: 3,
  cardRows: 0,
  cardH: 140,        // 由 CSS --card-h 读回，读不到时用这个兜底
  cardGap: 14,       // 由 CSS --card-gap 读回
  cardPadY: 0,       // 由 CSS --card-pad-y 读回：卡片区上下留白（虚拟滚动要算进总高）
  metricsReady: false,
  // 交互临时态：删除确认按钮、框选、卡片行内编辑
  delArm: null,
  mq: null,
  // 快速大幅滚动：此时跳过 favicon 加载（图片解码是大头），停下来后再补
  fastScroll: false,
  fastScrollT: 0,
};
