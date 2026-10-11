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
  } catch (e) { el.textContent = "当前：无法读取桥状态"; }
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
