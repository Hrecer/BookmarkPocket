// ops 通道与提示（由 ui/manager.js 拆分而来）

import { $ } from "./dom.js";

export async function op(name, args) {
  const r = await chrome.runtime.sendMessage({ channel: "op", op: name, args: args || {} });
  if (!r) throw new Error("Service Worker 无响应，请重新打开本页");
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export function setStatus(msg) { $("#statusmsg").textContent = msg; }

export let toastTimer = 0;

export function toast(msg, opts = {}) {
  const el = $("#toast");
  $("#toastmsg").textContent = msg;
  const act = $("#toastaction");
  if (opts.action) {
    act.hidden = false; act.textContent = opts.action;
    act.onclick = () => { hideToast(); if (opts.onAction) opts.onAction(); };
  } else act.hidden = true;
  el.classList.toggle("err", !!opts.error);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, opts.ms || (opts.error ? 4200 : 6200));
}

export function hideToast() { $("#toast").classList.remove("show"); }
