// 桥客户端冒烟测试：真开一个中枢进程，验证 reconnect() 等握手、失败带原因、重连不污染。
// 跑法：node extension/test/bridge.smoke.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 19333;
const TOKEN = "bridge-smoke-" + Date.now();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  " + extra : "")); }
};

globalThis.chrome = {
  runtime: {
    id: "test-ext",
    getManifest: () => ({ version: "0.0.0-test" }),
  },
  storage: {
    local: {
      async get() { return { "bookmarkpocket.port": PORT, "bookmarkpocket.token": TOKEN }; },
    },
  },
};

const bridge = await import("../src/bridge.js");

// 1) 无中枢：应快速失败且带原因（不等满超时）
{
  const t0 = Date.now();
  const r = await bridge.reconnect();
  ok("无中枢：快速失败并带原因", r.connected === false && !!r.lastError, JSON.stringify(r));
  ok("无中枢：失败在超时前返回", Date.now() - t0 < 2900, (Date.now() - t0) + "ms");
  // 阈值必须高于 bridge.js 里 waitConnected(2500) 的握手上限 —— 失败时正是等满这个上限
  // 才返回 2.5s 左右，原来写 < 2400 是永远不可能成立的断言。
}

// 2) 起真中枢：reconnect 必须等握手完成才返回
const server = spawn(process.execPath, [path.join(HERE, "..", "..", "mcp", "src", "server.js")], {
  env: { ...process.env, BOOKMARKPOCKET_PORT: String(PORT), BOOKMARKPOCKET_TOKEN: TOKEN },
  stdio: ["ignore", "ignore", "pipe"],
});
server.stderr.on("data", () => {});
await new Promise((r) => setTimeout(r, 900));
{
  const t0 = Date.now();
  const r = await bridge.reconnect();
  ok("中枢在跑：reconnect 等到握手完成", r.connected === true && r.url === `ws://127.0.0.1:${PORT}/`, JSON.stringify(r));
  ok("握手等待时长合理", Date.now() - t0 < 2400, (Date.now() - t0) + "ms");
}

// 3) 已连接状态下再重连：旧 socket 的 close 不得污染新状态
{
  const r3 = await bridge.reconnect();
  await new Promise((r) => setTimeout(r, 400));
  const s = bridge.getState();
  ok("连线上重连：返回与新状态均为已连接", r3.connected === true && s.connected === true, JSON.stringify(s));
}

// 4) 中枢被杀：状态应转未连接且带原因
{
  server.kill();
  await new Promise((r) => setTimeout(r, 600));
  const s = bridge.getState();
  ok("中枢下线：状态转未连接", s.connected === false, JSON.stringify(s));
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
