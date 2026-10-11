// 外观引导：在 <head> 里同步加载，先于样式表与首帧绘制执行。
// 存在的唯一理由是「开机不能闪一下」—— 如果等 manager.js（defer 模块）再套主题，
// 用户会先看到一帧系统配色的界面再跳成自己选的配色。
// 未设置 / 设为 auto 时不写 data-theme，交给 CSS 的 prefers-color-scheme 媒体查询，
// 这样「跟随系统」是真正的跟随：系统换了，页面不用重载就跟着换。
//
// 这里是普通脚本（不是模块，不能 import），键名就地写死；
// 权威定义在 src/keys.js 的 K.theme，两端必须一致。
try {
  var t = localStorage.getItem("bookmarkpocket.theme");
  if (t === "light" || t === "dark") {
    document.documentElement.setAttribute("data-theme", t);
  }
} catch (e) {
  /* 无痕模式等场景下 localStorage 不可用：保持跟随系统即可 */
}
