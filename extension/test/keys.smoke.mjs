// 存储键 + 外观引导冒烟测试。
// 跑法：node extension/test/keys.smoke.mjs
//
// 覆盖两件事：
//   ① 存储键只有一处定义（src/keys.js），全项目不得出现裸字面量或旧前缀残留
//   ② ui/theme-boot.js 的首帧行为：三档取值、空存储、localStorage 不可用
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 用相对说明符动态导入：Windows 上裸绝对路径（G:\…）不是合法的 ESM URL
const { K } = await import("../src/keys.js");

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("PASS  " + label); }
  else { fail++; console.log("FAIL  " + label + (extra ? "  → " + extra : "")); }
};

console.log("— 键名定义 —");
{
  const want = ["port", "token", "keepalive", "oplog", "theme", "view"];
  ok(Object.keys(K).sort().join(",") === want.sort().join(","), "K 就是这 6 个键：" + Object.keys(K).join(", "));
  const vals = Object.values(K);
  ok(vals.every((v) => v.startsWith("bookmarkpocket.")), "全部使用 bookmarkpocket. 前缀");
  ok(new Set(vals).size === vals.length, "键名互不重复");
  ok(K.oplog === "bookmarkpocket.oplog.v1", "撤销日志键带版本号（opus 升级时可平滑换代）");
}

console.log("\n— 改名遗留已清干净（业务代码不得再提旧前缀） —");
{
  const root = path.join(HERE, "..");
  const files = [
    path.join(root, "background.js"),
    ...fs.readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".js")).map((f) => path.join(root, "src", f)),
    ...fs.readdirSync(path.join(root, "ui")).filter((f) => f.endsWith(".js")).map((f) => path.join(root, "ui", f)),
    ...fs.readdirSync(path.join(root, "ui", "src")).filter((f) => f.endsWith(".js")).map((f) => path.join(root, "ui", "src", f)),
  ];
  const bad = [];
  // 只看代码：剥掉块注释与行注释（注释里可以出现历史说明，不算残留代码）
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/^[ \t]*\*[^\n]*$/gm, "");
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, "utf8"));
    if (/bookpocket\.|legacyOf|LEGACY_PREFIX|migrateLegacyKeys/.test(src)) bad.push(path.relative(root, f));
  }
  ok(bad.length === 0, "代码里没有任何迁移逻辑 / 旧键名（扫了 " + files.length + " 个文件，注释不计）", bad.join(", "));
}

console.log("\n— ui/theme-boot.js 首帧行为 —");
{
  const boot = fs.readFileSync(path.join(HERE, "..", "ui", "theme-boot.js"), "utf8");

  const makeLs = (init) => {
    const d = { ...init };
    return {
      _d: d,
      getItem: (k) => (k in d ? d[k] : null),
      setItem: (k, v) => { d[k] = String(v); },
      removeItem: (k) => { delete d[k]; },
    };
  };
  const fakeDoc = { documentElement: { _a: null, setAttribute(k, v) { this._a = v; } } };
  const run = (init) => {
    const ls = makeLs(init);
    fakeDoc.documentElement._a = null;
    new Function("localStorage", "document", boot)(ls, fakeDoc);
    return { ls, theme: fakeDoc.documentElement._a };
  };

  ok(boot.includes('"' + K.theme + '"'), "theme-boot 里写死的键名与 K.theme 一致：" + K.theme);

  ok(run({ "bookmarkpocket.theme": "dark" }).theme === "dark", "深色：首帧就套上 data-theme");
  ok(run({ "bookmarkpocket.theme": "light" }).theme === "light", "浅色：首帧就套上 data-theme");
  ok(run({ "bookmarkpocket.theme": "auto" }).theme === null, "auto：不写 data-theme（交给媒体查询）");
  ok(run({ "bookmarkpocket.theme": "乱写的值" }).theme === null, "非法值：当作未设置，不写属性");

  const empty = run({});
  ok(empty.theme === null && Object.keys(empty.ls._d).length === 0, "空存储：不写属性，也不写任何键（纯读，无副作用）");

  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  let threw = false;
  fakeDoc.documentElement._a = null;
  try { new Function("localStorage", "document", boot)(broken, fakeDoc); } catch (e) { threw = true; }
  ok(!threw && fakeDoc.documentElement._a === null, "localStorage 不可用（无痕模式）时不抛错，保持跟随系统");
}

console.log("\n— 存储键的读取路径都走 K —");
{
  const root = path.join(HERE, "..");
  const named = ["src/bridge.js", "src/ops.js"];
  const bare = [];
  for (const rel of named) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    if (/"bookmarkpocket\./.test(src)) bare.push(rel);
  }
  ok(bare.length === 0, "桥与操作层不写裸键名，一律用 K.xxx", bare.join(", "));
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
