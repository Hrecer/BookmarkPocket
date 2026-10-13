// 规则页：收藏归位的规则表 + 目标文件夹选择。
// 交互一律走 document 上的事件委托，行是渲染出来的，所以不需要逐行接线。

import { $ } from "./dom.js";
import { op } from "./chan.js";
import { esc } from "./details.js";
import { switchView } from "./search.js";

const TYPE_LABEL = { host: "域名", url: "网址片段" };

// 本模块私有的可变状态（顶层不用 let：跨模块状态归 state.js，模块私有的收进一个 const 对象）
const R = {
  cfg: null,     // 当前规则配置（后端 normalize 过）
  draft: null,   // 规则编辑器里的草稿
  pick: null,    // 文件夹选择器：{ kind: "rule" | "fallback", id, path }
};

export async function refreshRulesUI() {
  R.cfg = await op("rules.get");
  render();
}

function render() {
  const cfg = R.cfg;
  for (const b of document.querySelectorAll("[data-rules-on]")) b.classList.toggle("on", (b.dataset.rulesOn === "1") === cfg.enabled);
  for (const b of document.querySelectorAll("[data-fb-on]")) b.classList.toggle("on", (b.dataset.fbOn === "1") === cfg.fallback.enabled);
  $("#rvNote").textContent = cfg.enabled ? "已开启" : "已关闭";
  $("#rvCount").textContent = cfg.list.length ? `共 ${cfg.list.length} 条` : "";
  $("#rvFbText").textContent = "→ " + cfg.fallback.path;
  $("#setFbPath").textContent = "→ " + cfg.fallback.path;
  $("#rvList").innerHTML = cfg.list.length
    ? cfg.list.map(rowHTML).join("")
    : '<p class="snote">还没有规则——所有新收藏都走下面的兜底。</p>';
}

function rowHTML(r, i, n) {
  return `<div class="rvrow${r.enabled ? "" : " off"}" data-rule-id="${esc(r.id)}">
    <button class="rvbtn" data-act="rule-up" title="上移" type="button"${i === 0 ? " disabled" : ""}>↑</button>
    <button class="rvbtn" data-act="rule-down" title="下移" type="button"${i === n - 1 ? " disabled" : ""}>↓</button>
    <span class="rvmatch">${TYPE_LABEL[r.match.type]}：<b>${esc(r.match.value)}</b></span>
    <span class="rvarrow">→</span>
    <span class="rvtarget">${esc(r.target)}</span>
    <button class="tbtn rvmini" data-act="rule-toggle" type="button">${r.enabled ? "停用" : "启用"}</button>
    <button class="tbtn rvmini" data-act="rule-edit" type="button">改</button>
    <button class="tbtn rvmini" data-act="rule-del" type="button">删</button>
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

function moveRule(id, delta) {
  const list = R.cfg.list.slice();
  const i = list.findIndex((r) => r.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  save({ ...R.cfg, list });
}

function onAct(act, el) {
  if (act === "open-rules") return switchView("rules");
  if (act === "rule-add") return openEditor(null);
  if (act === "fb-pick") return openPicker("fallback");
  if (act === "rule-pick") return openPicker("rule");
  const id = ruleIdOf(el);
  if (!id) return;
  if (act === "rule-up") return moveRule(id, -1);
  if (act === "rule-down") return moveRule(id, 1);
  if (act === "rule-edit") return openEditor(id);
  if (act === "rule-del") return save({ ...R.cfg, list: R.cfg.list.filter((r) => r.id !== id) });
  if (act === "rule-toggle") return save({ ...R.cfg, list: R.cfg.list.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)) });
}

/* ---------- 目标文件夹选择 ---------- */

async function openPicker(kind) {
  const t = await op("bookmark.tree");
  const rows = [];
  (function walk(nodes, depth) {
    for (const n of nodes || []) {
      if (n.url) continue;
      rows.push(
        `<div class="pickrow" data-pick-id="${esc(n.id)}" data-pick-path="${esc(n.path || n.title)}" style="padding-left:${10 + depth * 14}px">${esc(n.title)}</div>`
      );
      walk(n.children, depth + 1);
    }
  })(t.tree[0].children, 0);
  R.pick = { kind, id: null, path: null };
  $("#pickTitle").textContent = kind === "fallback" ? "兜底归到这里" : "规则的目标文件夹";
  $("#pickList").innerHTML = rows.join("");
  $("#pickPath").textContent = "";
  $("#pickOverlay").hidden = false;
}

function choosePickRow(el) {
  if (!R.pick) return;
  R.pick.id = el.dataset.pickId;
  R.pick.path = el.dataset.pickPath;
  for (const r of $("#pickList").querySelectorAll(".pickrow")) r.classList.toggle("on", r === el);
  $("#pickPath").textContent = R.pick.path;
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

function onClick(e) {
  const el = e.target.closest("[data-act],[data-rules-on],[data-fb-on],[data-pick],[data-rule],[data-rule-type],[data-pick-id]");
  if (!el) return;
  const d = el.dataset;
  if (d.act) return onAct(d.act, el);
  if (d.rulesOn) return save({ ...R.cfg, enabled: d.rulesOn === "1" });
  if (d.fbOn) return save({ ...R.cfg, fallback: { ...R.cfg.fallback, enabled: d.fbOn === "1" } });
  if (d.pick) return onPick(d.pick);
  if (d.rule) return onRuleFoot(d.rule);
  if (d.ruleType) { R.draft.type = d.ruleType; syncType(); return; }
  if (d.pickId) return choosePickRow(el);
}

export function wireRulesView() {
  document.addEventListener("click", onClick);
  refreshRulesUI().catch(() => {});
}
