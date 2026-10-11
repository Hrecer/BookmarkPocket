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
  lastClick: { id: null, t: 0 },
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
