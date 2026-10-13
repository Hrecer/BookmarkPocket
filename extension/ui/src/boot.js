// 接线与启动（由 ui/manager.js 拆分而来）
//
// 模块顶层只放声明；所有带副作用的接线集中到 wire()，按原顺序执行一次。
// 这样模块之间即使互相 import（如 tree ↔ nav）也不会碰到求值顺序问题。

import { S, expanded, nodeById } from "./state.js";
import { K } from "../../src/keys.js";
import { $, actionrow, busyEl, listEl, navrow, panesEl, qEl, qListEl, searchViewEl, settingsViewEl, treeEl } from "./dom.js";
import { op, setStatus, toast } from "./chan.js";
import { onScrollFrame } from "./virtual.js";
import { applyTreeWindow, onTreeClick, toggleExpand } from "./tree.js";
import { applyAllWindows, applyListWindow, clearSel, itemHeight, itemOffsetTop, renderList, selectOne, syncSelection } from "./list.js";
import { initViewMode, moveViewInd, setCardMode, wireCardGrid } from "./card-ops.js";
import { openNode } from "./details.js";
import { back, forward, refresh, up, updateNavButtons } from "./nav.js";
import { closeEditor, newFolder, openEditor, saveEditor, startRenameSelected } from "./edit.js";
import { askDelete, askDeleteFromPane, closeConfirm, doDeleteConfirmed, doUndo, updateSortIndicators } from "./crud.js";
import { applySearchWindow, locateRow, moveNavInd, openSearchNode, renderSearch, runSearch, switchView } from "./search.js";
import { blankMenuItems, cancelCut, cleanupDrag, ctxEl, doCopy, doCut, dragState, executeTransfer, hideCtxMenu, openMenuForSelection, pasteInto, resolveDropTarget, setDropHighlight, showCtxMenu, showTransferMenu } from "./transfer.js";
import { copyPath, ensureListVisible, ensureTreeVisible, expandToCurrent, initSplitter } from "./shortcuts.js";
import { applyTheme, cycleTheme, pollBridge, readThemeMode, refreshCfgStatus } from "./shell.js";
import { wireRulesView } from "./rulesview.js";

// 单帧位移超过约一屏 → 判为「超大幅滚动」：这期间先不加载 favicon（图片解码是最大头），
// 停稳 140ms 后再整窗重绘一次补上。100K 量级下，这是拖动滚动条时不掉帧的关键。
const FAST_JUMP = 900;
function noteScroll(sc) {
  const prev = sc._mark || 0;
  sc._mark = sc.scrollTop;
  if (Math.abs(sc.scrollTop - prev) > FAST_JUMP) S.fastScroll = true;
  clearTimeout(S.fastScrollT);
  S.fastScrollT = setTimeout(() => {
    if (!S.fastScroll) return;
    S.fastScroll = false;
    if (S.viewMode === "browse") { S.listVer++; applyListWindow(false); }
    else if (S.viewMode === "search") { S.qVer++; applySearchWindow(false); }
  }, 140);
}

export function wire() {
  treeEl.addEventListener("scroll", () => onScrollFrame(treeEl, applyTreeWindow), { passive: true });

  listEl.addEventListener("scroll", () => { noteScroll(listEl); onScrollFrame(listEl, applyListWindow); }, { passive: true });

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => onScrollFrame(ro, applyAllWindows));
    ro.observe(treeEl); ro.observe(listEl); ro.observe(qListEl);
  } else {
    window.addEventListener("resize", () => onScrollFrame(document.documentElement, applyAllWindows));
  }

  // 点面板空白处清空选中：浏览页与搜索页共用同一份逻辑。
  // 之前只给浏览页 #list 接了这条，搜索页 #qlist 靠下面的文档级 handler 兜底 ——
  // 而那条 handler 把 .list / .searchpanes 整片排除了，于是搜索页（列表与卡片都是）
  // 点空白根本清不掉选中。
  const onPaneBlankClick = (e) => {
    if (e.target.closest(".row, .bcard")) return;
    // 框选刚结束：吞掉这一下空白 click，别把框选结果清空
    if (S.suppressClick) { S.suppressClick = false; return; }
    S.lastPane = "list"; clearSel();
  };
  listEl.addEventListener("click", onPaneBlankClick);
  qListEl.addEventListener("click", onPaneBlankClick);

  listEl.addEventListener("contextmenu", (e) => {
    if (S.rightDragJustEnded) { S.rightDragJustEnded = false; e.preventDefault(); return; }
    if (e.target.closest(".row, .bcard")) return;   // 行 / 卡片菜单由各自处理
    e.preventDefault();
    S.lastPane = "list";
    showCtxMenu(e.clientX, e.clientY, blankMenuItems());
  });

  treeEl.addEventListener("click", (e) => { if (!e.target.closest(".tnode")) clearSel(); });

  document.addEventListener("click", (e) => {
    if (e.target.closest(".row, .tnode, .details, .overlay, .notice, .ctxmenu, .searchchips, button, input, a, kbd, .list, .tree, .searchpanes")) return;
    clearSel();
  });

  document.querySelectorAll("button.col[data-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = btn.dataset.sort;
      if (S.sort.field === f) S.sort.dir = -S.sort.dir;
      else { S.sort.field = f; S.sort.dir = 1; }
      updateSortIndicators();
      if (S.viewMode === "browse") renderList(false);
    });
  });

  qListEl.addEventListener("scroll", () => { noteScroll(qListEl); onScrollFrame(qListEl, applySearchWindow); }, { passive: true });

  document.addEventListener("pointermove", (e) => {
    if (dragState.active) {
      if (dragState.ghost) {
        dragState.ghost.style.left = e.clientX + 14 + "px";
        dragState.ghost.style.top = e.clientY + 12 + "px";
      }
      setDropHighlight(resolveDropTarget(document.elementFromPoint(e.clientX, e.clientY)));
      return;
    }
    const p = dragState.pending;
    if (!p) return;
    if (Math.abs(e.clientX - p.x0) + Math.abs(e.clientY - p.y0) < 5) return;
    if (!S.sel.has(p.node.id)) { S.sel = new Set([p.node.id]); S.anchor = null; syncSelection(); }
    dragState.active = true; dragState.btn = p.btn; dragState.ids = [...S.sel]; dragState.pending = null;
    S.suppressClick = true;
    document.body.classList.add("dragging");
    const g = document.createElement("div");
    g.className = "dragghost";
    const first = nodeById.get(dragState.ids[0]);
    g.textContent = dragState.ids.length > 1
      ? "拖动 " + dragState.ids.length + " 项"
      : "拖动「" + String((first && (first.title || first.url)) || "").slice(0, 30) + "」";
    g.style.left = e.clientX + 14 + "px";
    g.style.top = e.clientY + 12 + "px";
    document.body.appendChild(g);
    dragState.ghost = g;
  });

  document.addEventListener("pointerup", (e) => {
    if (!dragState.active) { dragState.pending = null; return; }
    const btn = dragState.btn, ids = dragState.ids, target = dragState.target;
    cleanupDrag();
    if (btn === 2) S.rightDragJustEnded = true;
    if (!target || !ids.length) return;
    if (btn === 0) executeTransfer(e.ctrlKey || e.metaKey ? "copy" : "move", ids, target);
    else showTransferMenu(e.clientX, e.clientY, ids, target);
  });

  document.addEventListener("pointercancel", () => { if (dragState.active || dragState.pending) cleanupDrag(); });

  document.addEventListener("pointerdown", (e) => { if (ctxEl && !ctxEl.hidden && (!e.target.closest || !e.target.closest("#ctxmenu"))) hideCtxMenu(); }, true);

  document.addEventListener("scroll", hideCtxMenu, true);

  window.addEventListener("blur", hideCtxMenu);

  document.addEventListener("contextmenu", (e) => { if (S.rightDragJustEnded) { S.rightDragJustEnded = false; e.preventDefault(); } });

  document.addEventListener("keydown", (e) => {
    // 覆盖层优先
    if (!$("#confirmOverlay").hidden) {
      if (e.key === "Escape") { e.preventDefault(); closeConfirm(); }
      else if (e.key === "Enter") { e.preventDefault(); doDeleteConfirmed(); }
      return;
    }
    if (!$("#editorOverlay").hidden) {
      if (e.key === "Enter") { e.preventDefault(); saveEditor(); }
      // 照 LinkPocket：编辑器不响应 Esc（防误触）
      return;
    }
    if (S.editingId) return; // 行内编辑器自己处理
    const inInput = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
    const mod = e.ctrlKey || e.metaKey;
    // —— 移动逻辑相关键位（照 LinkPocket；Esc 先取消剪切态）——
    if (e.key === "Escape" && S.clip && S.clip.mode === "cut") { e.preventDefault(); cancelCut(); setStatus("已取消剪切"); return; }
    if (e.key === "F10" && e.shiftKey) { e.preventDefault(); openMenuForSelection(); return; }
    if (mod && e.shiftKey && (e.key === "e" || e.key === "E")) { e.preventDefault(); expandToCurrent(); return; }
    if (mod && e.shiftKey && (e.key === "c" || e.key === "C") && !inInput) { e.preventDefault(); copyPath(); return; }
    if (mod && !e.shiftKey && !inInput && (e.key === "x" || e.key === "X")) { e.preventDefault(); doCut(); return; }
    if (mod && !e.shiftKey && !inInput && (e.key === "c" || e.key === "C")) { e.preventDefault(); doCopy(); return; }
    if (mod && !e.shiftKey && !inInput && (e.key === "v" || e.key === "V")) { e.preventDefault(); pasteInto(S.currentFolderId); return; }
    if (mod && (e.key === "f" || e.key === "F" || e.key === "e" || e.key === "E")) {
      e.preventDefault(); switchView("search"); return;
    }
    if (mod && e.shiftKey && (e.key === "N")) { e.preventDefault(); newFolder(); return; }
    if (mod && (e.key === "z")) { e.preventDefault(); doUndo(); return; }
    if (e.key === "F5") { e.preventDefault(); refresh({ busy: true, fresh: true, entering: true, counts: true }); return; }
    if (e.key === "F2") { e.preventDefault(); startRenameSelected(); return; }
    if (e.key === "Backspace" && !inInput) { e.preventDefault(); back(); return; }
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); back(); return; }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); forward(); return; }
    if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); up(); return; }
    if (inInput) return;
    if (S.viewMode === "search") {
      if (e.key === "Escape") {
        if (S.sel.size) { clearSel(); }
        else if (qEl.value) { qEl.value = ""; runSearch(false); }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!S.qRows.length) return;
        const cur = S.sel.size ? S.qRows.findIndex((r) => S.sel.has(r.row.id)) : -1;
        const next = Math.max(0, Math.min(S.qRows.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
        S.sel = new Set([S.qRows[next].row.id]);
        syncSelection();
        const h = itemHeight("search");
        const y = itemOffsetTop(next, "search");
        if (y < qListEl.scrollTop || y + h > qListEl.scrollTop + qListEl.clientHeight) qListEl.scrollTop = Math.max(0, y - qListEl.clientHeight / 2);
        renderSearch(false);
        return;
      }
      if (e.key === "Enter") {
        const id = [...S.sel][0];
        const n = id && nodeById.get(id);
        if (n) openSearchNode(n);
        return;
      }
      return;
    }
    if (e.key === "Escape") { clearSel(); return; }
    if (e.key === "Delete") { e.preventDefault(); askDeleteFromPane(); return; }
    if (e.key === "Enter") {
      const nodes = [...S.sel].map((id) => nodeById.get(id)).filter(Boolean);
      if (nodes.length === 1) openNode(nodes[0]);
      return;
    }
    if (mod && e.key === "a") {
      e.preventDefault();
      S.sel = new Set((S.lastPane === "tree" ? S.treeView.map((r) => r.node) : S.viewRows.map((r) => r.node)).map((n) => n.id));
      syncSelection();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (S.lastPane === "tree") {
        // 左栏：按可见树序移动；文件夹=选中+进入，叶子=定位
        const cur = S.sel.size ? S.treeView.findIndex((r) => S.sel.has(r.node.id)) : -1;
        const next = Math.max(0, Math.min(S.treeView.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
        const r = S.treeView[next];
        if (r) { onTreeClick(r); ensureTreeVisible(next); }
        return;
      }
      if (!S.viewRows.length) return;
      const cur = S.anchor != null ? S.anchor : -1;
      const next = Math.max(0, Math.min(S.viewRows.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
      selectOne(S.viewRows[next].node.id, next);
      ensureListVisible(next);
      return;
    }
    if (e.key === "End") {
      if (S.viewMode === "browse" && S.lastPane === "list" && S.viewRows.length) {
        e.preventDefault();
        selectOne(S.viewRows[S.viewRows.length - 1].node.id, S.viewRows.length - 1);
        ensureListVisible(S.viewRows.length - 1);
      }
      return;
    }
    if (S.lastPane === "tree" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const r = S.treeView.find((x) => S.sel.has(x.node.id));
      if (!r || !r.isFolder) return;
      e.preventDefault();
      if (e.key === "ArrowRight" && !expanded.has(r.node.id)) toggleExpand(r.node.id);
      if (e.key === "ArrowLeft" && expanded.has(r.node.id)) toggleExpand(r.node.id);
      return;
    }
  });

  initSplitter($("#splitter"));

  initSplitter($("#splitter2"));

  document.querySelectorAll(".navitem").forEach((b) => {
    b.addEventListener("click", () => switchView(b.dataset.view));
  });

  $("#btnBack").addEventListener("click", back);

  $("#btnFwd").addEventListener("click", forward);

  $("#btnUp").addEventListener("click", up);

  $("#btnNewFolder").addEventListener("click", newFolder);

  $("#btnNewLink").addEventListener("click", openEditor);

  $("#btnRename").addEventListener("click", startRenameSelected);

  // 全项目唯一允许删文件夹的入口（浏览页工具栏）。
  // 视图保险：即便该按钮因异常状态可见，非浏览页也退化为「只放行书签」。
  $("#btnDelete").addEventListener("click", () => {
    if (S.viewMode === "browse") askDelete();
    else askDeleteFromPane();
  });

  $("#edSave").addEventListener("click", saveEditor);

  $("#edCancel").addEventListener("click", closeEditor);

  $("#cfOk").addEventListener("click", doDeleteConfirmed);

  $("#cfCancel").addEventListener("click", closeConfirm);

  $("#confirmOverlay").addEventListener("mousedown", (e) => { if (e.target === $("#confirmOverlay")) closeConfirm(); });

  $("#btnSearchGo").addEventListener("click", () => runSearch(true));

  $("#btnQCancel").addEventListener("click", () => { clearSel(); qEl.value = ""; runSearch(false); qEl.focus(); });

  $("#btnJump").addEventListener("click", () => { const id = [...S.sel][0]; if (id) locateRow({ id }); });

  // 搜索页工具栏：与详情栏同档，不删文件夹（搜索结果里可能夹着文件夹，误点就是整棵子树）
  $("#btnQDelete").addEventListener("click", askDeleteFromPane);

  document.querySelectorAll(".qchip").forEach((b) => {
    b.addEventListener("click", () => {
      S.qActive[b.dataset.scope] = !S.qActive[b.dataset.scope];
      b.classList.toggle("on", S.qActive[b.dataset.scope]);
      if (qEl.value.trim()) runSearch(false);
    });
  });

  qEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(true); } e.stopPropagation(); });

  qEl.addEventListener("input", () => {
    // 把关键词删空 → 立刻回到待搜索提示，不让上一批结果显示在空输入框下面。
    // 同时清掉选中：结果行都已经没了，选中项却还挂着，删除按钮会是热的。
    if (qEl.value.trim()) return;
    clearSel();
    runSearch(false);
  });

  // 一键配对：向本机中枢索取端口与令牌并落存，省掉手抄。失败仍可回到手填。
  $("#btnCfgPair").addEventListener("click", async () => {
    $("#cfgStatus").textContent = "正在向本机中枢索取端口与令牌…";
    try {
      const r = await op("sys.bridge.pair");
      $("#cfgStatus").textContent = r.connected ? "已连接 " + r.url : "未连接：" + (r.lastError || "请确认 mcp 中枢已启动");
      await refreshCfgStatus();
      pollBridge();
    } catch (e) { $("#cfgStatus").textContent = "配对失败：" + ((e && e.message) || e); }
  });

  $("#btnCfgSave").addEventListener("click", async () => {
    try {
      await chrome.storage.local.set({
        [K.port]: Number($("#cfgPort").value) || 19127,
        [K.token]: $("#cfgToken").value.trim(),
      });
      const r = await op("sys.bridge.reconnect");
      $("#cfgStatus").textContent = r.connected ? "已连接 " + r.url : "未连接：" + (r.lastError || "请确认 mcp 中枢已启动");
      pollBridge();
      setTimeout(refreshCfgStatus, 900);
    } catch (e) { $("#cfgStatus").textContent = "失败：" + ((e && e.message) || e); }
  });

  $("#btnCfgReconnect").addEventListener("click", async () => {
    try {
      const r = await op("sys.bridge.reconnect");
      $("#cfgStatus").textContent = r.connected ? "已连接 " + r.url : "未连接：" + (r.lastError || "等待中枢");
      pollBridge();
      setTimeout(refreshCfgStatus, 900);
    } catch (e) { $("#cfgStatus").textContent = "失败：" + ((e && e.message) || e); }
  });

  $("#btnTheme").addEventListener("click", cycleTheme);

  wireRulesView();

  // 卡片模式：容器级事件委托 + 两组「列表 / 卡片」切换（浏览页与搜索页各自独立）
  wireCardGrid();
  const bvl = $("#btnViewList"), bvg = $("#btnViewGrid");
  if (bvl) bvl.addEventListener("click", () => setCardMode(false));
  if (bvg) bvg.addEventListener("click", () => setCardMode(true));
  const qvl = $("#btnQViewList"), qvg = $("#btnQViewGrid");
  if (qvl) qvl.addEventListener("click", () => setCardMode(false));
  if (qvg) qvg.addEventListener("click", () => setCardMode(true));

  document.querySelectorAll("[data-theme-set]").forEach((b) => {
    b.addEventListener("click", () => applyTheme(b.dataset.themeSet, true));
  });

  // 首帧的 data-theme 已由 theme-boot.js 写好，这里只是把状态读回来、同步控件外观
  applyTheme(readThemeMode(), false);

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.channel !== "bkm") return;
      clearTimeout(S.bkmTimer);
      S.bkmTimer = setTimeout(() => { refresh({ busy: false }).catch(() => {}); }, 800);
    });
  } catch (e) { /* 预览环境无 onMessage */ }

  (async function main() {
    initViewMode();
    updateSortIndicators();
    updateNavButtons();
    [navrow, actionrow, panesEl, searchViewEl, settingsViewEl].forEach((el) => el.classList.add("fade"));
    moveNavInd();
    window.addEventListener("resize", moveNavInd);
    window.addEventListener("resize", moveViewInd);
    setTimeout(moveNavInd, 350);
    setTimeout(moveViewInd, 350);
    busyEl.hidden = false;
    try {
      await refresh({ busy: false, entering: true, counts: true });
    } catch (e) {
      toast(String((e && e.message) || e), { error: true });
    }
    busyEl.hidden = true;
    pollBridge();
    setInterval(pollBridge, 5000);
    if (location.hash === "#settings") switchView("settings");
  })();
}
