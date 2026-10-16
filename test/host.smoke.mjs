/**
 * 宿主半部离线冒烟测试：不启动 DSH，直接用假 ctx 调用 apply()，
 * 验证「注册路由 → 真实抓取 status.deepseek.com → handler 返回 JSON」整条链路。
 *
 * 抓的是真实网络，所以耗时几秒；失败也照样输出，方便看出是哪一段断了。
 * 运行：见 test/README.md
 */
import { apply, GLASS_PROBE_PATH, ROUTE_PATH } from "../lib/index.js";

const routes = [];
const logs = [];

const fakeCtx = {
  effect(fn) {
    return fn();
  },
  inject(services, callback) {
    callback({
      webServer: {
        register(options) {
          routes.push(options);
          return () => {};
        },
      },
    });
  },
  logger: {
    info: (message) => logs.push(`[info] ${message}`),
    warn: (message) => logs.push(`[warn] ${message}`),
  },
};

let checks = 0;
let failures = 0;
function check(name, condition, extra) {
  checks++;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${name}${extra === undefined ? "" : ` :: ${extra}`}`);
  if (!condition) failures++;
}

apply(fakeCtx, { sourceUrl: "https://status.deepseek.com/", pollIntervalMs: 60000, timeoutMs: 15000 });

console.log("宿主日志：");
for (const line of logs) console.log(`  ${line}`);

check("注册了两条路由（数据 + 背景采样诊断）", routes.length === 2, String(routes.length));
const route = routes.find((r) => r.path === ROUTE_PATH);
check(`路由路径是 ${ROUTE_PATH}`, route !== undefined);
check("路由 kind 是 exact", route?.kind === "exact", String(route?.kind));
check(`诊断路由 ${GLASS_PROBE_PATH} 已注册`, routes.some((r) => r.path === GLASS_PROBE_PATH));

/** 模拟一次 HTTP 请求，捕获 handler 写出的状态码与 body。 */
async function invoke(handler) {
  const captured = { status: 0, headers: null, body: "" };
  const res = {
    writeHead(status, headers) { captured.status = status; captured.headers = headers; },
    end(body) { captured.body = body; },
  };
  await handler({ url: ROUTE_PATH, method: "GET" }, res);
  return captured;
}

// 第一次抓取是异步的，给它时间；期间 handler 应返回「未知」而不是编造正常。
const first = await invoke(route.handler);
const firstData = JSON.parse(first.body);
check("首次请求：HTTP 200", first.status === 200, String(first.status));
check("首次请求：content-type 是 JSON", String(first.headers?.["content-type"]).includes("application/json"));
check("首次请求：未拿到数据时 overall 为 unknown", firstData.overall === "unknown", firstData.overall);
check("首次请求：组件为空而不是假数据", Array.isArray(firstData.components) && firstData.components.length === 0);

console.log("\n等待首次真实抓取完成（最多 25s）…");
for (let i = 0; i < 50; i++) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const probe = JSON.parse((await invoke(route.handler)).body);
  if (probe.fetchedAt !== null) break;
}

const after = JSON.parse((await invoke(route.handler)).body);
console.log("\n路由返回：");
console.log(JSON.stringify({
  overall: after.overall,
  via: after.via,
  components: after.components.length,
  uptime: after.uptime.length,
  active: after.active.length,
  recentResolved: after.recentResolved.length,
  fetchedAt: after.fetchedAt,
  error: after.error,
  failures: after.failures,
}, null, 2));
for (const component of after.components) {
  const uptime = after.uptime.find((u) => u.id === component.id);
  console.log(`    [${component.status}] ${component.name}${uptime ? `  uptime=${uptime.uptime}%` : ""}`);
}

check("真实抓取成功（fetchedAt 有值）", after.fetchedAt !== null, String(after.error));
check("overall 是已知状态", ["operational", "maintenance", "degraded", "partial_outage", "full_outage"].includes(after.overall), after.overall);
check("抓到了组件", after.components.length > 0, String(after.components.length));
check("抓到了 uptime", after.uptime.length > 0, String(after.uptime.length));
check("抓取成功后 error 为 null", after.error === null, String(after.error));
check("走的是 RSC 主源", after.via === "rsc", String(after.via));

// ── 降级路径：抓不到时必须保留上一次成功的快照，且绝不显示「正常」 ──────────
// 这里用 `{ get() }` 包装模拟 dsh-settings 的 volatile 热更新（改配置不重启插件）。
console.log("\n降级路径：先正常抓一轮，再把地址换成不可达端口…");
const liveRoutes = [];
const liveCtx = {
  effect(fn) { return fn(); },
  inject(services, callback) {
    callback({ webServer: { register(options) { liveRoutes.push(options); return () => {}; } } });
  },
  logger: { info: () => {}, warn: () => {} },
};
let liveValues = { sourceUrl: "https://status.deepseek.com/", pollIntervalMs: 15000, timeoutMs: 15000 };
apply(liveCtx, { get: () => liveValues });

let good = null;
for (let i = 0; i < 30; i++) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const probe = JSON.parse((await invoke(liveRoutes[0].handler)).body);
  if (probe.fetchedAt !== null) { good = probe; break; }
}
check("第一轮抓取成功", good !== null);
check("成功时 overall 取自真实数据", good !== null && good.overall !== "unknown", String(good?.overall));

liveValues = { sourceUrl: "http://127.0.0.1:9/", pollIntervalMs: 15000, timeoutMs: 3000 };
let failed = null;
for (let i = 0; i < 60; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const probe = JSON.parse((await invoke(liveRoutes[0].handler)).body);
  if (probe.failures > 0) { failed = probe; break; }
}
check("第二轮抓取失败被记录", failed !== null && failed.failures > 0, String(failed?.failures));
check("失败后保留上一次成功快照（fetchedAt 不变）", failed !== null && failed.fetchedAt === good?.fetchedAt, `${failed?.fetchedAt} vs ${good?.fetchedAt}`);
check("失败后 overall 仍是上次的真实状态", failed !== null && failed.overall === good?.overall, `${failed?.overall} vs ${good?.overall}`);
check("失败后组件列表仍在（界面不被清空）", failed !== null && failed.components.length === good?.components.length);
check("失败后带出错误信息", failed !== null && typeof failed.error === "string" && failed.error.length > 0, String(failed?.error));

// 全新实例 + 不可达地址：从未成功过 → 只能是 unknown，不能编造「正常」
const deadRoutes = [];
apply({
  effect(fn) { return fn(); },
  inject(services, callback) {
    callback({ webServer: { register(options) { deadRoutes.push(options); return () => {}; } } });
  },
  logger: { info: () => {}, warn: () => {} },
}, { sourceUrl: "http://127.0.0.1:9/", pollIntervalMs: 15000, timeoutMs: 3000 });
await new Promise((resolve) => setTimeout(resolve, 4000));
const never = JSON.parse((await invoke(deadRoutes[0].handler)).body);
check("从未成功过 → overall 为 unknown", never.overall === "unknown", never.overall);
check("从未成功过 → 组件为空、fetchedAt 为 null", never.components.length === 0 && never.fetchedAt === null);
check("从未成功过 → 带出错误信息", typeof never.error === "string" && never.error.length > 0, String(never.error));

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
