// Service Worker：装配 操作层 + 桥；UI（runtime 消息）与 Agent（WebSocket）走同一个 execute。

import { execute, defineOps, invalidateTree } from "./src/ops.js";
import * as bridge from "./src/bridge.js";
import { K } from "./src/keys.js";

defineOps({
  "sys.bridge.status": { fn: async () => bridge.getState() },
  "sys.bridge.reconnect": { fn: async () => { await bridge.reconnect(); return bridge.getState(); } },
  "sys.bridge.pair": { fn: async () => bridge.pair() },
});

function boot() {
  chrome.alarms.create(K.keepalive, { periodInMinutes: 0.5, delayInMinutes: 0.1 });
  bridge.ensure().catch(() => {});
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
boot();

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === K.keepalive) bridge.ensure().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.channel !== "op" || typeof msg.op !== "string") return false;
  execute(msg.op, msg.args).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
  );
  return true;
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/manager.html") });
});

function onBmEvent(name, args) {
  invalidateTree();
  bridge.sendEvent(name, args);
  // 推送给已打开的管理页：外部改动（Edge 自身操作 / 同步）也能实时反映，避免页面显示旧快照
  chrome.runtime.sendMessage({ channel: "bkm", event: name, args }).catch(() => {});
}

chrome.bookmarks.onCreated.addListener((id, node) => onBmEvent("onCreated", { id, node }));
chrome.bookmarks.onRemoved.addListener((id, info) => onBmEvent("onRemoved", { id, info }));
chrome.bookmarks.onChanged.addListener((id, info) => onBmEvent("onChanged", { id, info }));
chrome.bookmarks.onMoved.addListener((id, info) => onBmEvent("onMoved", { id, info }));
