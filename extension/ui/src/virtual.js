// 虚拟滚动窗口引擎（由 ui/manager.js 拆分而来）

export function ensurePool(pool, container, need, makeRow) {
  while (pool.length < need) { const el = makeRow(); pool.push(el); container.appendChild(el); }
  return pool;
}

export const OVER_MAX = 12;

/** 当前该铺哪一段行号（含上下余量）。overCap 可让某个面板用更小的余量（余量越小，一帧要重绘的行越少）。 */
export function windowBounds(total, scrollTop, viewH, rowH, overCap) {
  if (!total) return { first: 0, last: -1, need: 0 };
  // 上限 300 行（≈10800px）：正常窗口永远到不了，只是防止布局还没稳定时
  // 读到异常大的 clientHeight 就一口气铺出几千行 DOM。
  const perScreen = Math.min(300, Math.max(1, Math.ceil(viewH / rowH)));
  const over = Math.min(overCap || OVER_MAX, Math.ceil(perScreen / 2) + 4);
  const first = Math.max(0, Math.floor(scrollTop / rowH) - over);
  const last = Math.min(total - 1, first + perScreen + over * 2 - 1);
  return { first, last, need: last - first + 1 };
}

/** 滚动驱动的渲染：同一帧内只跑一次 */
export function onScrollFrame(el, fn) {
  if (el._raf) return;
  el._raf = requestAnimationFrame(() => { el._raf = 0; fn(); });
}

/** 把池里的行铺到 [first, last]；fill(el, idx) 负责填第 idx 行的内容 */
export function applyWindow(pool, container, makeRow, b, rowH, ver, fill) {
  const { first, last, need } = b;
  if (need <= 0) {
    for (const el of pool) { if (el._lock) continue; el._idx = -1; el.style.display = "none"; }
    pool._ver = ver;
    return;
  }
  ensurePool(pool, container, need, makeRow);

  // 数据换版了（切文件夹 / 展开收起 / 改名 / 排序 / 删除 / 撤销）：
  // 「行号没变」不等于「内容还对」—— 上一版同一行号上挂的是别的东西。
  // 少了这一步，切进新文件夹时窗口范围没变（都停在顶部），所有行都会被判定为
  // 可原样保留，fill 一次都不调用，于是上半截还是上一个文件夹的内容。
  const dataChanged = pool._ver !== ver;
  pool._ver = ver;

  const held = new Set();
  const idle = [];
  for (const el of pool) {
    const i = el._idx == null ? -1 : el._idx;
    if (el._lock) {                          // 行内改名中：既不回收也不隐藏
      if (i >= first && i <= last) held.add(i);
      continue;
    }
    if (!dataChanged && i >= first && i <= last) held.add(i);
    else { idle.push(el); el._idx = -1; }
  }

  let k = 0;
  for (let idx = first; idx <= last; idx++) {
    if (held.has(idx)) continue;
    let el = idle[k];
    if (el) k++;
    else { el = makeRow(); pool.push(el); container.appendChild(el); }   // 被改名行占位时的兜底
    el.style.display = "";
    el.style.transform = "translateY(" + idx * rowH + "px)";
    // 注意：_idx 由 fill 里的 updateXxxRow 负责写入 —— 它要在写入前
    // 用 _idx 判断「这行是不是原封不动」，所以这里不能抢先改。
    fill(el, idx);
  }
  for (; k < idle.length; k++) idle[k].style.display = "none";
}
