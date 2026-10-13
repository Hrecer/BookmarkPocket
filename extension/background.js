// Service Worker：装配 操作层 + 桥；UI（runtime 消息）与 Agent（WebSocket）走同一个 execute。

import { execute, defineOps, invalidateTree, isInternalWrite } from "./src/ops.js";
import * as bridge from "./src/bridge.js";
import * as rules from "./src/rules.js";
import { K } from "./src/keys.js";

defineOps({
  "sys.bridge.status": { fn: async () => bridge.getState() },
  "sys.bridge.reconnect": { fn: async () => { await bridge.reconnect(); return bridge.getState(); } },
  "sys.bridge.pair": { fn: async () => bridge.pair() },
  "rules.get": { fn: async () => rules.read() },
  "rules.set": { fn: async ({ config } = {}) => rules.write(config) },
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

chrome.bookmarks.onCreated.addListener((id, node) => {
  onBmEvent("onCreated", { id, node });
  // 收藏归位：弹窗里显示的文件夹改不了（那是宿主界面），但书签一落地就能按规则搬正。
  // 我们自己的写入（管理器新建 / Agent / 复制）在新节点上先于「我们刚写的」标记落地，
  // 所以这里用标志位挡一下；标志位已清零才到的晚事件，交给 autoRoute 里那层认领。
  if (isInternalWrite()) return;
  rules.autoRoute(id, node).catch(() => {});
});
chrome.bookmarks.onRemoved.addListener((id, info) => onBmEvent("onRemoved", { id, info }));
chrome.bookmarks.onChanged.addListener((id, info) => onBmEvent("onChanged", { id, info }));
chrome.bookmarks.onMoved.addListener((id, info) => {
  onBmEvent("onMoved", { id, info });
  // 浏览器自己挪的（收藏弹窗里改文件夹后确认、原生收藏管理器里拖动）：这种只发 onMoved，
  // 不管的话书签会一直躺在错的地方，看起来就像兜底没生效。
  rules.settleMove(id, info && info.parentId).catch(() => {});
});
