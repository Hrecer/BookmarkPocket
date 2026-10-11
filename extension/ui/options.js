// 设置入口转发：设置已并入管理器页内的「设置」视图，这里只做跳转。
// 必须放在独立文件里 —— MV3 扩展页的 CSP（script-src 'self'）会拦掉内联脚本，
// 写在 HTML 里的那种 <script>…</script> 根本不会执行。
location.replace(chrome.runtime.getURL("ui/manager.html") + "#settings");
