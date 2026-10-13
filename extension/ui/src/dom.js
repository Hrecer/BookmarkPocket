// DOM 元素引用与常量（由 ui/manager.js 拆分而来）

export const $ = (s) => document.querySelector(s);

export const fmt = new Intl.NumberFormat("zh-CN");

// 标题排序用的比较器：Intl.Collator 建一次复用。
// 用 String.prototype.localeCompare(b, "zh-CN") 的话，每次比较都要重新走一遍
// ICU 的 locale 解析 —— 几万条的书签排一次就是几百毫秒，是「进文件夹要等一下」的主因。
export const TITLE_COLLATOR = new Intl.Collator("zh-CN");

export const treeEl = $("#tree"), tspacer = $("#tspacer"), trowsEl = $("#trows");

export const listEl = $("#list"), spacerEl = $("#spacer"), rowsEl = $("#rows");

// 卡片模式的行层：与 #rows 平级，同样绝对定位；由 body.card-browse / body.card-search 决定显隐
export const crowsEl = $("#crows");

export const busyEl = $("#busy"), emptyEl = $("#empty"), emptytitleEl = $("#emptytitle"), emptydescEl = $("#emptydesc");

export const detailsEl = $("#details"), crumbsEl = $("#crumbs");

export const details2El = $("#details2");

export const qEl = $("#q"), qListEl = $("#qlist"), qspacerEl = $("#qspacer"), qrowsEl = $("#qrows"), qemptyEl = $("#qempty");

export const qcrowsEl = $("#qcrows");

export const searchViewEl = $("#searchview");

export const settingsViewEl = $("#settingsview");

export const rulesViewEl = $("#rulesview");

export const navrow = $(".navrow"), actionrow = $(".actionrow"), panesEl = $("#panes");

export const T_ROW_H = 30;

export const L_ROW_H = 36;

export const ICON = {
  folder: '<svg viewBox="0 0 16 16"><path d="M2 4.2c0-.8.6-1.4 1.4-1.4h3l1.3 1.6h4.9c.8 0 1.4.6 1.4 1.4v6.6c0 .8-.6 1.4-1.4 1.4H3.4c-.8 0-1.4-.6-1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  link: '<svg viewBox="0 0 16 16"><path d="M6.6 9.4a3 3 0 0 0 4.2 0l2.2-2.2a3 3 0 0 0-4.2-4.2L7.6 4.2M9.4 6.6a3 3 0 0 0-4.2 0L3 8.8a3 3 0 0 0 4.2 4.2l1.2-1.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  nav: '<svg viewBox="0 0 16 16"><path d="M4.5 2.5h7v11l-3.5-2.4-3.5 2.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  chev: '<svg viewBox="0 0 16 16"><path d="M6 3.8 10.2 8 6 12.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  open: '<svg viewBox="0 0 16 16"><path d="M9.5 3.5h3v3M12.2 3.8 7.6 8.4M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pencil: '<svg viewBox="0 0 16 16"><path d="m3 11.8.3-2.2 7-7a1.1 1.1 0 0 1 1.6 0l1.5 1.5a1.1 1.1 0 0 1 0 1.6l-7 7-2.2.3zM9.6 3.3l3.1 3.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M2.6 4.3h10.8M6.4 2.6h3.2M4.1 4.3l.6 9a1.2 1.2 0 0 0 1.2 1.1h4.2a1.2 1.2 0 0 0 1.2-1.1l.6-9M6.6 6.9v4.7M9.4 6.9v4.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eye: '<svg viewBox="0 0 16 16"><path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  pin: '<svg viewBox="0 0 16 16"><path d="M8 2.5a4.2 4.2 0 0 1 2.6 7.5l-.4 3.5H5.8l-.4-3.5A4.2 4.2 0 0 1 8 2.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6.7 13.5h2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  clock: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5.2V8l2 1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  hash: '<svg viewBox="0 0 16 16"><path d="M6.2 2.8 4.8 13.2M11.2 2.8 9.8 13.2M3 6h10.2M2.8 10h10.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>',
  edit: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m5.8 10.2.2-1.5 3.7-3.7a.8.8 0 0 1 1.2 0l.5.5a.8.8 0 0 1 0 1.2l-3.7 3.7z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  // 外观三态图标：半明半暗=跟随系统 / 太阳 / 月亮
  themeAuto: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor"/></svg>',
  themeLight: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  themeDark: '<svg viewBox="0 0 16 16"><path d="M13.2 9.9A5.6 5.6 0 0 1 6.1 2.8a5.6 5.6 0 1 0 7.1 7.1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  // 卡片操作：保存 / 已确认删除，用同一枚对勾
  check: '<svg viewBox="0 0 16 16"><path d="m3.4 8.4 3 3 6.2-6.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // 卡片上的「选中」键：空心圈 / 勾选圈
  pick: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  picked: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m5.3 8.2 1.8 1.9 3.6-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
