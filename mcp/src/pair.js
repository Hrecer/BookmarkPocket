// 一键配对端：只绑 127.0.0.1 的一个小 HTTP 服务，把「中枢端口 + 令牌」交给浏览器扩展。
// 扩展是沙箱、读不到磁盘上的 config.json，这一步就是为了免掉「打开设置 → 找文件 → 复制粘贴」。
// 端口固定为中枢端口 + 1（默认 19128）。

import http from "node:http";

const html = (cfg) => `<!doctype html>
<meta charset="utf-8">
<title>BookmarkPocket 配对</title>
<style>
  body{font:15px/1.8 system-ui,"Microsoft YaHei",sans-serif;max-width:640px;margin:56px auto;padding:0 20px;background:#14161a;color:#e8eaee}
  code{background:#0f1116;padding:2px 7px;border-radius:5px}
  .dim{color:#8b93a1}
</style>
<h2>BookmarkPocket 配对信息</h2>
<p class="dim">下面两样东西填进扩展的「设置 → 桥（连接 Agent 中枢）」。<br>
正常情况下不用手抄：在管理器页点「一键配对」即可。</p>
<p>中枢端口 <code>${cfg.port}</code></p>
<p>访问令牌 <code>${cfg.token}</code></p>
<p class="dim">扩展也可直接从 <code>/pair.json</code> 机器读取同一份内容。</p>
`;

export function startPairServer(cfg, log) {
  const body = () => JSON.stringify({ server: "bookmarkpocket-mcp", port: cfg.port, token: cfg.token });
  const srv = http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0];
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    if (path === "/pair.json") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      res.end(body());
      return;
    }
    if (path === "/" || path === "/pair") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html(cfg));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  srv.on("error", (e) => log(`配对端未启动（${e.message}），扩展可改用手填端口与令牌`));
  srv.listen(cfg.pairPort, "127.0.0.1", () => {
    log(`配对端已就绪：http://127.0.0.1:${cfg.pairPort}/pair.json （供扩展「一键配对」读取）`);
  });
  return srv;
}
