// Service Worker：装配 操作层 + 桥；UI（runtime 消息）与 Agent（WebSocket）走同一个 execute。

import { execute, defineOps, invalidateTree, isSelfWrite, isBulkActive, isBulkQuiet, setProgressHook, setBulkEndHook } from "./src/ops.js";
import * as bridge from "./src/bridge.js";
import * as rules from "./src/rules.js";
import { K } from "./src/keys.js";

defineOps({
  "sys.bridge.status": { fn: async () => bridge.getState() },
  "sys.bridge.reconnect": { fn: async () => { await bridge.reconnect(); return bridge.getState(); } },
  "sys.bridge.pair": { fn: async () => bridge.pair() },
  "sys.hub.shutdown": { fn: async () => bridge.shutdownHub() },
  "rules.get": { fn: async () => rules.read() },
  "rules.set": { fn: async ({ config } = {}) => rules.write(config) },
  "rules.apply": { mutating: true, fn: async (args, opts) => rules.applyRules(args, opts) },
});

// 批量操作进行时，外部（用户/浏览器）的新建、移动先记下来，等批量结束再归位；
// 否则它们的 autoRoute/settleMove 会排在批量写入后面，把串行队列越堆越长。
const deferred = [];
const DEFER_CAP = 2000;
function deferEvent(e) { if (deferred.length < DEFER_CAP) deferred.push(e); }

setBulkEndHook(() => {
  const list = deferred.splice(0);
  for (const e of list) {
    if (e.name === "onCreated") rules.autoRoute(e.id, e.node).catch(() => {});
    else if (e.name === "onMoved") rules.settleMove(e.id, e.info && e.info.parentId).catch(() => {});
  }
});

setProgressHook((p) => {
  chrome.runtime.sendMessage({ channel: "bulk", ...p }).catch(() => {});
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
  // 批量写入期间不把每条自己的 onMoved/onCreated 都推给中枢/管理页：
  // 几千个事件本身就会把日志和页面拖慢。批量进度走 channel:"bulk"。
  const parentId = (args.info && args.info.parentId) || (args.node && args.node.parentId);
  if (isBulkQuiet() && isSelfWrite(args.id, parentId) && (name === "onMoved" || name === "onCreated")) return;
  bridge.sendEvent(name, args);
  // 推送给已打开的管理页：外部改动（Edge 自身操作 / 同步）也能实时反映，避免页面显示旧快照
  chrome.runtime.sendMessage({ channel: "bkm", event: name, args }).catch(() => {});
}

chrome.bookmarks.onCreated.addListener((id, node) => {
  onBmEvent("onCreated", { id, node });
  // 内部新建靠 markSelf 的 id 认领（create 返回后同步记账，事件随后才到）；
  // 不再用「execute 期间」全局标志，避免长批量把用户这期间的新收藏也吞掉。
  if (isSelfWrite(id, node && node.parentId)) return;
  if (isBulkActive()) { deferEvent({ name: "onCreated", id, node }); return; }
  rules.autoRoute(id, node).catch(() => {});
});
chrome.bookmarks.onRemoved.addListener((id, info) => onBmEvent("onRemoved", { id, info }));
chrome.bookmarks.onChanged.addListener((id, info) => onBmEvent("onChanged", { id, info }));
chrome.bookmarks.onMoved.addListener((id, info) => {
  onBmEvent("onMoved", { id, info });
  // 浏览器自己挪的（收藏弹窗里改文件夹后确认、原生收藏管理器里拖动）：这种只发 onMoved，
  // 不管的话书签会一直躺在错的地方，看起来就像兜底没生效。
  if (isSelfWrite(id, info && info.parentId)) return;
  if (isBulkActive()) { deferEvent({ name: "onMoved", id, info }); return; }
  rules.settleMove(id, info && info.parentId).catch(() => {});
});
