// 布局切换的滚动锚点：列表与卡片共用同一份项序，但行距/列数不同。
// 锚点取视口正中间那一项（卡片取中间列），切换后把这一项放回视口正中间；
// 顶部/底部保持贴边，避免在列表两端切换时无缘无故跳走。

import { listEl, qListEl, L_ROW_H } from "./dom.js";
import { cardItemHeight, cardItemTop, cardOn, cardRowHeight, colsOf, paneRows } from "./cards.js";

function scrollerOf(pane) { return pane === "search" ? qListEl : listEl; }
function itemTop(i, pane) { return cardOn(pane) ? cardItemTop(i, colsOf(pane)) : i * L_ROW_H; }
function itemHeight(pane) { return cardOn(pane) ? cardItemHeight() : L_ROW_H; }

export function centerAnchor(pane) {
  const sc = scrollerOf(pane);
  const rows = paneRows(pane);
  if (!sc || !rows.length) return { i: -1, edge: null };
  if (sc.scrollTop <= 1) return { i: 0, edge: "top" };
  if (sc.scrollHeight > sc.clientHeight && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1) {
    return { i: rows.length - 1, edge: "bottom" };
  }
  const centerY = sc.scrollTop + sc.clientHeight / 2;
  let i;
  if (cardOn(pane)) {
    const cols = Math.max(1, colsOf(pane));
    const rowH = cardRowHeight();
    const top0 = cardItemTop(0, cols);          // 第一行卡片的顶（含 --card-pad-y）
    const totalRows = Math.ceil(rows.length / cols);
    let row = Math.round((centerY - top0 - cardItemHeight() / 2) / rowH);
    row = Math.max(0, Math.min(totalRows - 1, row));
    const col = Math.min(cols - 1, Math.floor(cols / 2));
    i = row * cols + col;
  } else {
    i = Math.floor(centerY / L_ROW_H);
  }
  return { i: Math.max(0, Math.min(rows.length - 1, i)), edge: null };
}

export function anchorScrollTop(pane, anchor) {
  const sc = scrollerOf(pane);
  if (!sc || !anchor || anchor.i < 0) return 0;
  if (anchor.edge === "top") return 0;
  const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
  if (anchor.edge === "bottom") return max;
  const rows = paneRows(pane);
  const i = Math.min(anchor.i, Math.max(0, rows.length - 1));
  return Math.max(0, Math.min(max, itemTop(i, pane) + itemHeight(pane) / 2 - sc.clientHeight / 2));
}
