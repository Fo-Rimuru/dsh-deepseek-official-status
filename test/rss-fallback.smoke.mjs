/**
 * RSS 兜底路径冒烟测试：状态页负载（RSC / HTML）双双失败时，必须降级到
 * `/feed.rss` 保住事件列表 —— 同时**绝不**把 overall 说成正常（组件状态无从得知）。
 *
 * 用桩 fetch 精确构造「只有 feed 通」的场景（真实网络里造不出来）。
 * 运行：见 test/README.md
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, loadSnapshot, ROUTE_PATH } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const feedXml = readFileSync(join(here, "fixtures", "feed.rss"), "utf8");

let checks = 0;
let failures = 0;
function check(name, condition, extra) {
  checks++;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${name}${extra === undefined ? "" : ` :: ${extra}`}`);
  if (!condition) failures++;
}

const realFetch = globalThis.fetch;
/** 只有 feed.rss 通：RSC 返 500，HTML 返一个不含 flight 负载的页面。 */
function stubFetch({ feedOk = true } = {}) {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("feed.rss")) {
      return feedOk
        ? new Response(feedXml, { status: 200, headers: { "content-type": "application/rss+xml; charset=utf-8" } })
        : new Response("nope", { status: 503 });
    }
    if (href.includes("_rsc=")) return new Response("server error", { status: 500 });
    return new Response("<!doctype html><html><body>no flight payload here</body></html>", { status: 200 });
  };
}

/** 模拟一次 HTTP 请求，捕获 handler 写出的状态码与 body。 */
async function invoke(handler) {
  const captured = { status: 0, headers: null, body: "" };
  await handler({ url: ROUTE_PATH, method: "GET" }, {
    writeHead(status, headers) { captured.status = status; captured.headers = headers; },
    end(body) { captured.body = body; },
  });
  return captured;
}

// ── 1. loadSnapshot 层 ─────────────────────────────────────────────────────
console.log("loadSnapshot 降级路径（只有 feed.rss 通）：");
stubFetch();
const degraded = await loadSnapshot({ sourceUrl: "https://status.deepseek.com/", timeoutMs: 5000 });
globalThis.fetch = realFetch;

check("via 是 rss", degraded.via === "rss", String(degraded.via));
check("标记 degraded", degraded.degraded === true, String(degraded.degraded));
check("overall 仍为 unknown（绝不编造正常）", degraded.overall === "unknown", degraded.overall);
check("activeKnown 为 false", degraded.activeKnown === false);
check("没有组件", degraded.components.length === 0, String(degraded.components.length));
check("没有 uptime", degraded.uptime.length === 0, String(degraded.uptime.length));
check("仍拿到历史事件", degraded.recentResolved.length > 0, String(degraded.recentResolved.length));
check("降级原因写明 rsc 与 html 各自失败",
  /rsc:/.test(degraded.degradedReason ?? "") && /html:/.test(degraded.degradedReason ?? ""),
  String(degraded.degradedReason).slice(0, 120));
check("降级后事件可点（带 link）", degraded.recentResolved.every((e) => typeof e.link === "string" && e.link !== ""));
check("降级后事件带可读时间（closedAt 为秒）", degraded.recentResolved.every((e) => Number.isFinite(e.closedAt)));

// ── 2. 三条路全挂 → 抛错（调用方保留旧快照） ────────────────────────────────
console.log("\n三条路径全挂：");
stubFetch({ feedOk: false });
let thrown = null;
try {
  await loadSnapshot({ sourceUrl: "https://status.deepseek.com/", timeoutMs: 5000 });
} catch (error) {
  thrown = error;
}
globalThis.fetch = realFetch;
check("抛出聚合错误", thrown !== null, String(thrown?.message).slice(0, 140));
check("错误里三条路径都有记录",
  /rsc:/.test(thrown?.message ?? "") && /html:/.test(thrown?.message ?? "") && /rss:/.test(thrown?.message ?? ""));

// ── 3. 路由层（apply + handler）─────────────────────────────────────────────
console.log("\n路由层降级：");
const routes = [];
stubFetch();
apply({
  effect(fn) { return fn(); },
  inject(services, callback) {
    callback({ webServer: { register(options) { routes.push(options); return () => {}; } } });
  },
  logger: { info: () => {}, warn: () => {} },
}, { sourceUrl: "https://status.deepseek.com/", pollIntervalMs: 15000, timeoutMs: 3000 });

let probe = null;
let first = null;
for (let i = 0; i < 40; i++) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  probe = JSON.parse((await invoke(routes[0].handler)).body);
  if (first === null) first = probe;
  if (probe.fetchedAt !== null) break;
}
globalThis.fetch = realFetch;

check("降级前（尚未抓到任何数据）overall 为 unknown", first.overall === "unknown", String(first.overall));
check("路由仍返回 HTTP 200 与 JSON", probe.fetchedAt !== null, String(probe.error));
check("快照标出 degraded", probe.degraded === true, String(probe.degraded));
check("快照 overall 为 unknown", probe.overall === "unknown", String(probe.overall));
check("快照 via 为 rss", probe.via === "rss", String(probe.via));
check("error 字段带出降级原因", typeof probe.error === "string" && probe.error.includes("RSS"), String(probe.error).slice(0, 80));
check("组件为空但事件有内容",
  probe.components.length === 0 && probe.recentResolved.length > 0,
  `components=${probe.components.length} recent=${probe.recentResolved.length}`);
check("降级不算抓取失败（failures 归零）", probe.failures === 0, String(probe.failures));

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
