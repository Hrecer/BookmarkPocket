# BookmarkPocket（书签口袋）

浏览器书签管理器两件套：**管理器扩展**（人用界面 + Agent 通道，同一条操作管线）+ **AI 接入**（MCP 服务 + 本地中枢）。
所有操作走浏览器官方 `chrome.bookmarks` API，浏览器自己落盘——没有影子库、没有 JSON 往返、没有"备份回灌"。
一切操作完全在书签机制内完成：**不创建任何额外文件夹**，删除就是直接删除。

## 目录

- `extension/` — 管理器扩展（MV3）
  - `src/ops.js` — 统一操作层：UI 与 Agent 走同一注册表、同一串行队列、同一份日志、同一套安全闸
  - `src/bridge.js` — WS 桥客户端（连本机中枢，自动重连，30s 闹钟兜底保活）
  - `src/keys.js` — 存储键的唯一定义（改名时的旧键迁移已跑完并移除，现在只认新前缀）
  - `ui/manager.js` — 管理页入口：只做「跑起接线 + 暴露测试接口」两件事（17 行）
  - `ui/src/` — 页面逻辑按职责拆成的 16 个模块（原本是单个 1833 行的上帝文件）：
    - `state.js` 跨模块共享状态 · `dom.js` 元素引用与常量 · `virtual.js` 虚拟滚动窗口引擎
    - `data.js` 索引/排序 · `tree.js` 侧栏树 · `list.js` 主列表与选择 · `details.js` 详情栏
    - `nav.js` 导航与刷新 · `edit.js` 行内改名与新建 · `crud.js` 删除与排序
    - `search.js` 搜索页 · `transfer.js` 剪贴板/拖拽/右键菜单 · `shortcuts.js` 快捷键与分栏拖拽
    - `shell.js` 外观/设置/桥状态 · `chan.js` ops 通道与提示 · `boot.js` 接线（`wire()`）· `api.js` 测试接口
  - `ui/theme-boot.js` — 外观引导：`<head>` 里同步执行，首帧前就定好深浅色（不然会先亮后暗）
  - `ui/options.html` + `ui/options.js` — 设置入口（重定向到管理器页内的设置视图，同页切换）
- `mcp/` — AI 接入（Node）
  - `src/server.js` — 对 Agent 暴露 MCP（stdio）；对本机扩展暴露 WS 中枢（127.0.0.1 + token + Origin 白名单）
  - `src/tools.js` — 10 个工具定义（薄转发到扩展 ops）

## 安全设计

1. 唯一数据源 = 浏览器实时书签；写操作全部由浏览器落盘（无 checksum/损坏/同步冲突问题）。
2. 删除 = 直接删除（与 Edge/Chrome 原生一致：书签从树里立刻消失，不产生回收站或任何额外文件夹）。
3. 安全网是**不可见**的：每个写操作的前像存在扩展自己的存储里（不进入你的书签），「撤销上一步」可回放恢复。
   （注：删除的回放=重建条目，浏览器会分配新 id；标题/URL/所在位置与原样一致。）
4. 桥只绑 `127.0.0.1`，令牌 + Origin 白名单（扩展 ID 已由 manifest key 固定：`abcdefghijklmnopabcdefghijklmnop`）。
5. 权限最小化：只申请 `bookmarks / alarms / storage / favicon`（`favicon` 用于读取本地缓存的站点图标，不发外部请求）。

## 快速开始

1. **加载扩展**：Edge 打开 `edge://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选 `extension/`。
   （扩展 ID 应显示为 `abcdefghijklmnopabcdefghijklmnop`，与 `mcp/config.example.json` 的 allowedOrigins 一致。）
2. **启动中枢**：`cd mcp && npm install && npm start`
   首次启动自动生成 `config.json`（含 token），日志里会提示路径。
3. **填令牌**：扩展图标右键 → 选项 → 端口 `19127` + 粘贴 `config.json` 里的 token → 保存并重连。
4. **注册 MCP**（Qoder 等宿主）：
   ```json
   { "mcpServers": { "bookmarkpocket": { "command": "node", "args": ["<path-to-this-repo>\\mcp\\src\\server.js"] } } }
   ```
5. 点扩展图标打开管理器；Agent 侧调用 `bridge_status` 应返回桥已连接。

## 状态

已实现：统一通道（UI/Agent 同一管线）、树/搜索/增/改/移/删（直接删除）、撤销回放、操作日志、10 个 MCP 工具、四个冒烟测试。
代码组织：管理页逻辑按职责拆在 `ui/src/` 下 16 个模块，入口只有 17 行；最大的文件是 340 行的 `boot.js`（纯接线，无逻辑）。模块间不共享 `let`，可变的跨模块状态统一挂在 `state.js` 的 `S` 对象上（ESM 的 import 绑定不可赋值，所以只能这样），其余一律走 `export` / `import`。
管理器 UI（面板位置与操作逻辑对齐 LinkPocket，视觉为自有方案）：顶栏品牌 + 胶囊导航 / ←→↑ 导航 + 可点面包屑 / 动作行（新建文件夹 · 新建书签 · 重命名 · 删除）/ 左树 210 + 中列表（名称 · 网址 · 添加时间，可排序）+ 右详情栏 286（可拖 230–400）/ 状态栏（共 N 项 + 已选中胶囊）。
交互：单击单选 / Ctrl 翻转 / Shift 区间 / 点空白或 Esc 取消 / 慢速再击=行内改名 / 双击或 Enter 打开 / F2 改名 / F5 刷新 / Ctrl+Shift+N 新建 / Ctrl+Z 撤销 / Backspace 后退；删除走确认弹窗，新建书签为覆盖层编辑器；全局搜索页（Ctrl+F）。
删除权限分层：**文件夹只有「浏览」页工具栏的删除按钮能动**（快捷键 Delete、右键菜单、详情栏、搜索页工具栏一律只放行书签）；选中里含文件夹时那些入口整体拒绝并提示去处，确认框会写明将连带删除多少书签。切视图与换文件夹都会清空选中，避免选中集跨视图残留。
外观：**默认跟随系统**的浅色 / 深色（`prefers-color-scheme`，系统换配色时无需重载即跟着变）。顶栏右上角图标一键三态循环（跟随系统 → 浅色 → 深色），设置页另有分段选择；选择存在 localStorage，首帧由 `ui/theme-boot.js` 同步套用，不会先亮后暗。
滚动条：加粗圆角胶囊（16px 可抓范围 / 8px 可见胶囊，hover 变宽到 10px、按住变 12px）。三处滚动区都关掉了浏览器滚动锚定并固定滚动条槽位，大幅拖动滑块时鼠标不会与滑块脱节；主列表只纵向滚动。侧栏行宽跟随内容，长文件夹名 / 深层缩进会撑出**底部横向滚动条**，滚过去就能看全名字（不再省略号截断）。
未实现（后续批次）：拖拽排序、内联改名、文件夹侧栏、失效链接检测、导入导出、CLI、快照对比。

## 测试

- `node extension/test/ops.smoke.mjs` — 操作层语义（mock chrome，含"书签树内不产生额外文件夹"回归）
- `node extension/test/bridge.smoke.mjs` — 桥客户端：无中枢/有中枢/令牌错误等 6 个场景
- `node extension/test/keys.smoke.mjs` — 存储键定义 + 外观引导首帧（含「全项目不得残留旧前缀 / 迁移代码」的守护扫描）
- `node extension/test/manager.smoke.mjs` — 管理页端到端：桩 DOM + 桩 chrome 把 `ui/manager.js` 及其全部模块真跑起来，39 项断言覆盖启动、树展开、选择/详情、导航、新建/删除/撤销、搜索、排序、外观、设置
- `cd mcp && npm test` — MCP stdio + WS 中枢全链路（假扩展）

## 许可

[MIT](LICENSE) © 2026 Hrecer
