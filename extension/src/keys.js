// 存储键的唯一定义处（扩展侧：Service Worker 与页面都从这里取）。
// 需要读写扩展存储的地方一律引用这里，不要在别处散写字面量。
//
// 注：项目曾从 BookPocket 改名为 BookmarkPocket，键前缀随之改变。当时那段
// 「旧键搬值 + 删旧键」的迁移已经跑完并整体移除：
//   · chrome.storage.local 侧查证过，旧键从来就不存在，迁移一直是空操作；
//   · 扩展页的 localStorage 里若还留着改名前的 bookpocket.theme，那只是一条
//     没有任何代码去读的陈旧记录，不影响行为（重新选一次外观即可覆盖）。
// 现在全项目只认新前缀。

const PREFIX = "bookmarkpocket.";

export const K = {
  port: PREFIX + "port",
  token: PREFIX + "token",
  keepalive: PREFIX + "keepalive",
  oplog: PREFIX + "oplog.v1",
  theme: PREFIX + "theme",
  view: PREFIX + "view",   // 浏览页布局：list / card（localStorage，仅记住上次选择）
  rules: PREFIX + "rules.v1",   // 收藏归位规则：总开关 + 兜底 + 规则表
};
