// 规则页：收藏归位的开关、规则表、目标文件夹选择。
// 规则表按「表格」做：默认直接拖动整行排序；点「批量选择」才进入选择态，行首出圆选圈，
// 用于全选 / 批量删除。交互一律走 document 上的事件委托，行是渲染出来的。

import { $, ICON } from "./dom.js";
import { op } from "./chan.js";
import { esc } from "./details.js";
import { switchView } from "./search.js";
import { visibleRows, flatFolders } from "./treewalk.js";

const TYPE_LABEL = { host: "域名", url: "网址片段" };

// 行内图标写得尽量简单：一笔勾成的笔 + 一个叉，缩到 14px 也看得懂。
const I_EDIT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 12.6l.7-2.7 6.7-6.7 2 2-6.7 6.7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const I_DEL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.8 4.8l6.4 6.4M11.2 4.8l-6.4 6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

// 本模块私有的可变状态（顶层不用 let：跨模块状态归 state.js，模块私有的收进一个 const 对象）
const R = {
  cfg: null,        // 当前规则配置（后端 normalize 过）
  draft: null,      // 规则编辑器里的草稿
  pick: null,       // 文件夹选择器：{ kind: "rule" | "fallback", id, path }
  selmode: false,   // 是否处于「批量选择」态
  sel: new Set(),   // 选择态里勾中的规则 id
  drag: null,       // 正在拖动的规则 id
};

export async function refreshRulesUI() {
  R.cfg = await op("rules.get");
  exitSel();
  render();
}

function exitSel() {
  R.selmode = false;
  R.sel = new Set();
}

function setSwitch(el, on) {
  el.classList.toggle("on", !!on);
  el.setAttribute("aria-checked", on ? "true" : "false");
}

function render() {
  const cfg = R.cfg;
  const ids = new Set(cfg.list.map((r) => r.id));
  for (const id of [...R.sel]) if (!ids.has(id)) R.sel.delete(id);

  setSwitch($("#swRules"), cfg.enabled);
  setSwitch($("#swFallback"), cfg.fallback.enabled);
  $("#rvNote").textContent = cfg.enabled ? "已开启" : "已关闭";
  $("#rvFbText").textContent = "→ " + cfg.fallback.path;

  const list = $("#rvList");
  list.classList.toggle("selmode", R.selmode);
  list.innerHTML = cfg.list.length
    ? cfg.list.map((r) => rowHTML(r, R.sel.has(r.id))).join("")
    : '<p class="snote">还没有规则——所有新收藏都走下面的兜底。</p>';

  $("#btnRuleAdd").hidden = R.selmode;
  $("#btnRulePick").hidden = R.selmode;
  $("#btnRuleAll").hidden = !R.selmode;
  $("#btnRuleCancel").hidden = !R.selmode;
  $("#btnRuleDel").hidden = !R.selmode;

  const picked = R.sel.size;
  $("#rvCount").textContent = R.selmode
    ? (picked ? `已选 ${picked} / 共 ${cfg.list.length} 条` : `共 ${cfg.list.length} 条`)
    : `共 ${cfg.list.length} 条`;
  $("#btnRuleAll").textContent = cfg.list.length && picked === cfg.list.length ? "取消全选" : "全选";
  $("#btnRuleDel").disabled = picked === 0;
}

// 选择态才在行首出圆选圈；平时这行是「启用开关 · 修改 · 删除 · 匹配 → 目标」。
function rowHTML(r, picked) {
  const sel = R.selmode
    ? `<button class="rvpick${picked ? " on" : ""}" data-act="rule-pick" type="button" title="选中这条">${picked ? ICON.picked : ICON.pick}</button>`
    : "";
  return `<div class="rvrow${r.enabled ? "" : " off"}${picked ? " picked" : ""}" data-rule-id="${esc(r.id)}" draggable="${R.selmode ? "false" : "true"}">
    ${sel}
    <button class="switch sm${r.enabled ? " on" : ""}" data-act="rule-toggle" type="button" role="switch" aria-checked="${r.enabled}" title="${r.enabled ? "停用这条" : "启用这条"}"></button>
    <button class="rvico" data-act="rule-edit" type="button" title="修改">${I_EDIT}</button>
    <button class="rvico danger" data-act="rule-del" type="button" title="删除">${I_DEL}</button>
    <span class="rvmatch">${TYPE_LABEL[r.match.type]}：<b>${esc(r.match.value)}</b></span>
    <span class="rvarrow">→</span>
    <span class="rvtarget">${esc(r.target)}</span>
  </div>`;
}

async function save(next) {
  R.cfg = await op("rules.set", { config: next });
  render();
}

function ruleIdOf(el) {
  const row = el.closest("[data-rule-id]");
  return row && row.dataset.ruleId;
}

/* ---------- 批量选择 ---------- */

function toggleSelMode() {
  if (R.selmode) exitSel();
  else { R.selmode = true; R.sel = new Set(); }
  render();
}

function togglePick(id) {
  if (!id) return;
  if (R.sel.has(id)) R.sel.delete(id);
  else R.sel.add(id);
  render();
}

function toggleAll() {
  const all = R.cfg.list.map((r) => r.id);
  R.sel = all.length && R.sel.size === all.length ? new Set() : new Set(all);
  render();
}

function removePicked() {
  if (!R.sel.size) return;
  const list = R.cfg.list.filter((r) => !R.sel.has(r.id));
  exitSel();
  save({ ...R.cfg, list });
}

/* ---------- 拖动整行排序 ---------- */

function clearDropMarks() {
  for (const el of $("#rvList").querySelectorAll(".rvrow")) el.classList.remove("drop-before", "drop-after");
}

function dropAfter(e, row) {
  const r = row.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
}

function onDragStart(e) {
  const row = e.target.closest && e.target.closest("[data-rule-id]");
  if (!row || R.selmode) return;
  R.drag = row.dataset.ruleId;
  row.classList.add("dragging");
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", R.drag);
  }
}

function onDragOver(e) {
  if (!R.drag) return;
  const row = e.target.closest && e.target.closest("[data-rule-id]");
  if (!row) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  clearDropMarks();
  if (row.dataset.ruleId !== R.drag) row.classList.add(dropAfter(e, row) ? "drop-after" : "drop-before");
}

// 落点只在放手时应用：拖动过程中不重渲染，否则会把浏览器自己的拖拽会话打断。
function onDrop(e) {
  if (!R.drag) return;
  const id = R.drag;
  R.drag = null;
  const row = e.target.closest && e.target.closest("[data-rule-id]");
  clearDropMarks();
  if (!row || row.dataset.ruleId === id) return render();
  e.preventDefault();
  const after = dropAfter(e, row);
  const list = R.cfg.list.slice();
  const from = list.findIndex((r) => r.id === id);
  if (from < 0) return render();
  const [moved] = list.splice(from, 1);
  let to = list.findIndex((r) => r.id === row.dataset.ruleId);
  if (after) to += 1;
  list.splice(to, 0, moved);
  save({ ...R.cfg, list });
}

function onDragEnd() {
  R.drag = null;
  clearDropMarks();
  for (const el of $("#rvList").querySelectorAll(".rvrow")) el.classList.remove("dragging");
}

/* ---------- 目标文件夹选择 ---------- */

// 默认收起、按需展开：目录再多也只是一屏顶层。行本身复用左栏那套
// （visibleRows + .tnode/.tchev/.tico/.tname），只是不吃虚拟化。
// 目标路径上的祖先自动展开，并把当前项滚进视野，省得手动翻。
export async function openRulesPicker(kind) {
  const t = await op("bookmark.tree");
  const roots = (t.tree[0] && t.tree[0].children) || [];
  const cur = pickCurrent(kind);
  const flat = flatFolders(roots);
  const open = new Set(
    flat.filter((f) => cur && (f.path === cur || cur.startsWith(f.path + " > "))).map((f) => f.node.id)
  );
  R.pick = { kind, id: null, path: null, cur, roots, flat, open };
  $("#pickTitle").textContent = kind === "fallback" ? "兜底归到这里" : "规则的目标文件夹";
  $("#pickPath").textContent = "";
  renderPick();
  $("#pickOverlay").hidden = false;
}

function pickCurrent(kind) {
  if (kind === "fallback") return String((R.cfg && R.cfg.fallback.path) || "");
  return String((R.draft && R.draft.target) || "");
}

function renderPick() {
  const p = R.pick;
  if (!p) return;
  const byId = new Map(p.flat.map((f) => [f.node.id, f]));
  const rows = visibleRows(p.roots, p.open).filter((r) => r.isFolder);
  $("#pickList").innerHTML = rows.map((r) => pickRowHTML(r, byId.get(r.node.id) || {}, p)).join("");
  const sel = $("#pickList").querySelector(".tnode.current");
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
}

function pickRowHTML(r, info, p) {
  const n = r.node;
  const exp = p.open.has(n.id);
  const path = info.path || n.title || "";
  const on = p.id ? p.id === n.id : path === p.cur;
  return `<div class="tnode folder prow${info.hasKids ? "" : " leaf"}${exp ? " expanded" : ""}${on ? " current" : ""}"`
    + ` data-pick-id="${esc(n.id)}" data-pick-path="${esc(path)}" data-pick-kids="${info.hasKids ? "1" : ""}"`
    + ` title="${esc(path)}" style="padding-left:${6 + r.depth * 20}px">`
    + `<button class="tchev${info.hasKids ? "" : " empty"}" data-pick-chev="${esc(n.id)}" type="button" tabindex="-1">${ICON.chev}</button>`
    + `<span class="tico">${ICON.folder}</span><span class="tname">${esc(n.title)}</span></div>`;
}

export function pickToggle(id) {
  if (!R.pick || !id) return;
  if (R.pick.open.has(id)) R.pick.open.delete(id);
  else R.pick.open.add(id);
  renderPick();
}

// 选中即展开（和左栏点文件夹的行为一致），选中项留在视野里
export function pickChoose(id) {
  const p = R.pick;
  if (!p || !id) return;
  const f = p.flat.find((x) => x.node.id === id);
  if (!f) return;
  p.id = f.node.id;
  p.path = f.path;
  p.open.add(f.node.id);
  $("#pickPath").textContent = f.path;
  renderPick();
}

function closePick() {
  $("#pickOverlay").hidden = true;
  R.pick = null;
}

function onPick(what) {
  if (what === "cancel") return closePick();
  if (!R.pick || !R.pick.path) { $("#pickPath").textContent = "先点一行选个文件夹"; return; }
  const { kind, path } = R.pick;
  closePick();
  if (kind === "fallback") return save({ ...R.cfg, fallback: { ...R.cfg.fallback, path } });
  if (R.draft) { R.draft.target = path; $("#ruleTarget").value = path; }
}

/* ---------- 规则编辑器 ---------- */

function openEditor(id) {
  const r = id ? R.cfg.list.find((x) => x.id === id) : null;
  R.draft = { id: id || null, type: r ? r.match.type : "host", target: r ? r.target : R.cfg.fallback.path };
  $("#ruleHead").textContent = r ? "编辑规则" : "新建规则";
  $("#ruleValue").value = r ? r.match.value : "";
  $("#ruleTarget").value = R.draft.target;
  $("#ruleHint").textContent = "";
  syncType();
  $("#ruleOverlay").hidden = false;
}

function syncType() {
  for (const b of $("#ruleOverlay").querySelectorAll("[data-rule-type]")) b.classList.toggle("on", b.dataset.ruleType === R.draft.type);
}

function onRuleFoot(what) {
  if (what === "cancel") { $("#ruleOverlay").hidden = true; return; }
  const value = $("#ruleValue").value.trim();
  const target = $("#ruleTarget").value.trim();
  if (!value) { $("#ruleHint").textContent = "匹配内容不能为空"; return; }
  if (!target) { $("#ruleHint").textContent = "还没选目标文件夹"; return; }
  const list = R.cfg.list.slice();
  if (R.draft.id) {
    const i = list.findIndex((x) => x.id === R.draft.id);
    if (i >= 0) list[i] = { ...list[i], match: { type: R.draft.type, value }, target };
  } else {
    list.push({ enabled: true, match: { type: R.draft.type, value }, target });
  }
  $("#ruleOverlay").hidden = true;
  save({ ...R.cfg, list });
}

/* ---------- 接线 ---------- */

function onAct(act, el) {
  if (act === "open-rules") return switchView("rules");
  if (act === "rule-add") return openEditor(null);
  if (act === "rule-selmode") return toggleSelMode();
  if (act === "rule-all") return toggleAll();
  if (act === "rule-del-sel") return removePicked();
  if (act === "rule-pick") return togglePick(ruleIdOf(el));
  if (act === "rule-target-pick") return openRulesPicker("rule");
  if (act === "fb-pick") return openRulesPicker("fallback");
  const id = ruleIdOf(el);
  if (!id) return;
  if (act === "rule-edit") return openEditor(id);
  if (act === "rule-del") { R.sel.delete(id); return save({ ...R.cfg, list: R.cfg.list.filter((r) => r.id !== id) }); }
  if (act === "rule-toggle") return save({ ...R.cfg, list: R.cfg.list.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)) });
}

function onClick(e) {
  const el = e.target.closest("[data-act],[data-rules-switch],[data-fb-switch],[data-pick],[data-pick-chev],[data-rule],[data-rule-type],[data-pick-id]");
  if (!el) return;
  const d = el.dataset;
  if (d.act) return onAct(d.act, el);
  if (d.rulesSwitch) return save({ ...R.cfg, enabled: !R.cfg.enabled });
  if (d.fbSwitch) return save({ ...R.cfg, fallback: { ...R.cfg.fallback, enabled: !R.cfg.fallback.enabled } });
  if (d.pickChev) return pickToggle(d.pickChev);
  if (d.pick) return onPick(d.pick);
  if (d.rule) return onRuleFoot(d.rule);
  if (d.ruleType) { R.draft.type = d.ruleType; syncType(); return; }
  if (d.pickId) return pickChoose(d.pickId);
}

export function wireRulesView() {
  document.addEventListener("click", onClick);
  document.addEventListener("dragstart", onDragStart);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("drop", onDrop);
  document.addEventListener("dragend", onDragEnd);
  refreshRulesUI().catch(() => {});
}
