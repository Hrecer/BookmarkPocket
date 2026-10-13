// 外观 / 设置 / 桥状态（由 ui/manager.js 拆分而来）

import { K } from "../../src/keys.js";
import { op, toast } from "./chan.js";
import { $, ICON } from "./dom.js";

export const THEME_KEY = K.theme;

export const THEME_ORDER = ["auto", "light", "dark"];

export const THEME_META = {
  auto: { label: "跟随系统", icon: "themeAuto" },
  light: { label: "浅色", icon: "themeLight" },
  dark: { label: "深色", icon: "themeDark" },
};

export let themeMode = "auto";

export function readThemeMode() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEME_META[v] ? v : "auto";
  } catch (e) { return "auto"; }
}

export function applyTheme(mode, persist) {
  themeMode = THEME_META[mode] ? mode : "auto";
  const root = document.documentElement;
  if (themeMode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", themeMode);
  if (persist) {
    try { localStorage.setItem(THEME_KEY, themeMode); } catch (e) { /* 无痕模式：本次会话生效，不持久化 */ }
  }
  updateThemeUI();
}

export function updateThemeUI() {
  const meta = THEME_META[themeMode];
  const btn = $("#btnTheme");
  if (btn) {
    btn.innerHTML = ICON[meta.icon];
    btn.title = "外观：" + meta.label + "（点击切换）";
    btn.setAttribute("aria-label", "外观：" + meta.label);
  }
  document.querySelectorAll("[data-theme-set]").forEach((b) => {
    b.classList.toggle("on", b.dataset.themeSet === themeMode);
  });
}

// 顶栏按钮：三态循环（跟随系统 → 浅色 → 深色 → …），切换后给一句短提示
export function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(themeMode) + 1) % THEME_ORDER.length];
  applyTheme(next, true);
  toast("外观：" + THEME_META[next].label, { ms: 1600 });
}

export async function loadSettings() {
  try {
    const o = await chrome.storage.local.get([K.port, K.token]);
    $("#cfgPort").value = o[K.port] || 19127;
    $("#cfgToken").value = o[K.token] || "";
  } catch (e) { /* ignore */ }
  $("#cfgExtId").textContent = chrome.runtime.id;
  $("#cfgOrigin").textContent = "chrome-extension://" + chrome.runtime.id;
  refreshCfgStatus();
}

export async function refreshCfgStatus() {
  const el = $("#cfgStatus");
  if (!el) return;
  try {
    const s = await op("sys.bridge.status");
    el.textContent = s.connected ? "当前：已连接 " + s.url : "当前：未连接（" + (s.lastError || "等待中枢") + "）";
    renderHubPanel(s);
  } catch (e) { el.textContent = "当前：无法读取桥状态"; }
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + " 秒";
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (!h) return m + " 分 " + (s % 60) + " 秒";
  return h + " 时 " + (m % 60) + " 分";
}

// 「中枢」面板：那个后台 Node 进程（宿主拉起的 MCP 服务，兼任浏览器↔AI 的中转）
// 跑没跑、进程号、内存/CPU 占用、运行多久；随时可以一键把它关掉。
export function renderHubPanel(s) {
  const mode = $("#hubMode"), info = $("#hubAddr"), up = $("#hubUptime"), btn = $("#btnHubStop"), note = $("#hubNote");
  if (!mode) return;
  if (!s || !s.connected) {
    mode.textContent = "未运行";
    info.textContent = "—";
    up.textContent = "—";
    btn.disabled = true;
    note.textContent = "后台 Node 进程当前没在跑，AI 工具也不可用。要用就在宿主命令框敲 /mcp reload。";
    return;
  }
  const h = s.hub || {};
  mode.textContent = "运行中";
  info.textContent = "PID " + (h.pid ?? "—") +
    "　内存 " + (h.rssMb != null ? h.rssMb + " MB" : "—") +
    "　CPU " + (h.cpuPct != null ? h.cpuPct + "%" : "—");
  up.textContent = (h.startedAt ? fmtDuration(Date.now() - h.startedAt) : "—") + (h.port ? "（端口 " + h.port + "）" : "");
  btn.disabled = false;
  note.textContent = "关掉它 = 结束这个后台 Node 进程；AI 工具随即断开，直到你在宿主里敲 /mcp reload。";
}

export async function stopHub() {
  const btn = $("#btnHubStop"), note = $("#hubNote");
  if (btn) btn.disabled = true;
  if (note) note.textContent = "正在关闭中枢…";
  let r = null;
  try { r = await op("sys.hub.shutdown"); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (r && r.ok) toast("中枢已关闭；AI 工具已断开，要用请在宿主敲 /mcp reload", { ms: 3200 });
  else toast("关闭失败：" + ((r && r.error) || "未知原因"), { error: true });
  pollBridge();
}

export async function pollBridge() {
  try {
    const s = await op("sys.bridge.status");
    $("#bri").className = "dot " + (s.connected ? "on" : "off");
    $("#britext").textContent = s.connected ? "已连接" : (s.lastError ? "未连接" : "等待中枢");
    $("#bridgebox").title = s.connected ? "桥已连接 " + s.url : "桥未连接：" + (s.lastError || "");
    refreshCfgStatus();
  } catch (e) { /* ignore */ }
}
