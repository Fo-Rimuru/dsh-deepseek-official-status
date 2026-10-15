/**
 * DeepSeek 官方服务状态 — 宿主半部。
 *
 * 职责：按配置轮询 status.deepseek.com，把解析好的快照通过一条**同源**精确路由
 * 暴露给浏览器半部（浏览器因此不需要跨域请求外部站点）。轮询与解析都在宿主，
 * 浏览器只读 `/deepseek-official-status/current`。
 *
 * 数据源策略（实测，详见 parser.js / rss.js 顶部注释）：
 *   1. 首选 RSC：`GET /?_rsc=<随机>` + `RSC: 1` → `text/x-component`，body 就是裸
 *      flight 文本，字段未转义，最省事也最稳。
 *   2. 回退首页 HTML：解一层 JS 字符串转义后得到同一份负载。
 *   3. 兜底 /feed.rss：前两条都失败时（状态页结构变了、换了系统、被墙……）用
 *      Flashcat 的 RSS 保住**事件列表**。RSS 没有组件列表和 uptime，所以这一路的
 *      快照是 `overall: "unknown"`（灰）+ `degraded: true`，客户端据此显示降级提示。
 *   三条都失败时**保留上一次成功的快照**，只更新错误信息与失败计数 ——
 *   客户端据此显示「更新于 X 分钟前」和抓取失败提示，绝不假装成「正常」。
 *
 * 配置：`Config` 用 `.volatile()` 声明，dsh-settings 会把它投影成设置页表单；
 * volatile 提交会在原地替换快照（不重启插件），所以每次抓取都重新读一遍配置。
 */
import z from "@deepseek-ai/schemastery";
import { parseStatusHtml, parseStatusRsc } from "./parser.js";
import { eventsFromRss, parseRssFeed } from "./rss.js";

export const name = "dsh-deepseek-official-status";

/** 浏览器半部只读这一个同源端点。 */
export const ROUTE_PATH = "/deepseek-official-status/current";

/** 状态页地址（也是「打开状态页」链接的目标）。 */
export const DEFAULT_SOURCE = "https://status.deepseek.com/";

/** RSS 兜底源相对状态页地址解析（默认 https://status.deepseek.com/feed.rss）。 */
export const FEED_PATH = "feed.rss";

const DEFAULTS = { pollIntervalMs: 60000, timeoutMs: 15000 };
const MIN_POLL_MS = 15000;
const MAX_POLL_MS = 3600000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 120000;

/** 没有任何成功快照时返回的占位：一切未知 —— 观感是灰色，不是绿色。 */
const EMPTY_SNAPSHOT = Object.freeze({
  overall: "unknown",
  activeKnown: false,
  page: null,
  components: [],
  active: [],
  recentResolved: [],
  uptime: [],
  updatedAt: null,
  fetchedAt: null,
  degraded: false,
});

const configSchema = z.object({
  sourceUrl: z.string().default(DEFAULT_SOURCE).description("状态页地址（默认 https://status.deepseek.com/）"),
  pollIntervalMs: z.number().min(MIN_POLL_MS).max(MAX_POLL_MS).default(DEFAULTS.pollIntervalMs)
    .description("宿主轮询间隔（毫秒，15000–3600000）"),
  timeoutMs: z.number().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULTS.timeoutMs)
    .description("单次抓取超时（毫秒，5000–120000）"),
});

/**
 * `.volatile()` 是设置页可见的前提：dsh-settings 只把带有 volatile 标记的字段
 * 投影成表单（`volatileForm()`），没有标记的 entry 会被整条跳过。
 * 老版本 schemastery 没有该方法时退化成普通 schema（仍可通过 profile 配置）。
 */
export const Config = typeof configSchema.volatile === "function" ? configSchema.volatile() : configSchema;

const messageOf = (error) => String(error?.message ?? error);

/**
 * 解开 loader 给 `.volatile()` 字段套的 `{ get() }` 包装。
 * volatile 提交是原地替换快照，所以每次读都要重新解包才能拿到新值；
 * 普通值（未包装 / 测试替身）原样返回。
 */
function readVolatile(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === "object" && typeof value.get === "function") return value.get();
  return value;
}

function clampNumber(value, fallback, min, max) {
  const n = Number(readVolatile(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** 带超时的取文本，非 2xx 直接抛。 */
async function grab(url, headers, timeoutMs) {
  const res = await fetch(url, {
    redirect: "follow",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 抓取并解析一份快照：RSC 优先，HTML 回退，RSS 兜底事件。
 * @returns 成功时带 `via`；RSS 兜底时额外带 `degraded: true` 与 `degradedReason`
 * @throws 三条路径都失败时抛出聚合错误（调用方保留旧快照）
 */
export async function loadSnapshot({ sourceUrl, timeoutMs }) {
  const problems = [];
  try {
    const rscUrl = new URL(sourceUrl);
    rscUrl.searchParams.set("_rsc", Math.random().toString(36).slice(2, 10));
    const text = await grab(rscUrl.toString(), { rsc: "1", accept: "text/x-component" }, timeoutMs);
    return { ...parseStatusRsc(text), via: "rsc" };
  } catch (error) {
    problems.push(`rsc: ${messageOf(error)}`);
  }
  try {
    const html = await grab(sourceUrl, { accept: "text/html,application/xhtml+xml" }, timeoutMs);
    return { ...parseStatusHtml(html), via: "html" };
  } catch (error) {
    problems.push(`html: ${messageOf(error)}`);
  }
  try {
    const feedUrl = new URL(FEED_PATH, sourceUrl).toString();
    const xml = await grab(feedUrl, { accept: "application/rss+xml, application/xml, text/xml" }, timeoutMs);
    const feed = parseRssFeed(xml);
    const { active, recentResolved } = eventsFromRss(feed.events);
    // 组件状态与 uptime 无从得知 → 一切未知（灰），只有事件是真的。
    return {
      overall: "unknown",
      activeKnown: false,
      page: null,
      components: [],
      active,
      recentResolved,
      uptime: [],
      updatedAt: feed.updatedAt,
      via: "rss",
      degraded: true,
      degradedReason: `状态页负载解析失败，已降级为 RSS 事件源（${problems.join("; ")}）`,
    };
  } catch (error) {
    problems.push(`rss: ${messageOf(error)}`);
  }
  throw new Error(problems.join("; "));
}

/**
 * @param {object} ctx Cordis 上下文
 * @param {object} [config] profile 行配置（`.volatile()` 字段可能被包装）
 */
export function apply(ctx, config) {
  let snapshot = null;
  let lastError = null;
  let failures = 0;
  let timer = null;
  let disposed = false;

  function resolveConfig() {
    const raw = readVolatile(config) ?? {};
    const sourceUrl = readVolatile(raw.sourceUrl);
    return {
      sourceUrl: typeof sourceUrl === "string" && sourceUrl.trim() !== "" ? sourceUrl.trim() : DEFAULT_SOURCE,
      pollIntervalMs: clampNumber(raw.pollIntervalMs, DEFAULTS.pollIntervalMs, MIN_POLL_MS, MAX_POLL_MS),
      timeoutMs: clampNumber(raw.timeoutMs, DEFAULTS.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    };
  }

  async function refresh() {
    const cfg = resolveConfig();
    try {
      const next = await loadSnapshot(cfg);
      const previousOverall = snapshot?.overall ?? null;
      const { degradedReason, ...rest } = next;
      snapshot = { ...rest, degraded: rest.degraded === true, fetchedAt: Date.now() };
      // 降级成功（RSS）不是「刷新失败」，但要把降级原因透出去，客户端才会提示。
      lastError = degradedReason ?? null;
      failures = 0;
      // 只在状态/来源变化时记录，免得每分钟刷日志。
      if (previousOverall !== next.overall || snapshot.degraded === true) {
        ctx.logger?.[next.degraded === true ? "warn" : "info"]?.(
          `${name}: 总体状态 ${previousOverall ?? "(首次)"} → ${next.overall}（源 ${next.via}，${next.components.length} 个组件）`,
        );
      }
    } catch (error) {
      // 失败不改动 snapshot：客户端继续显示上一次成功的快照 + 「更新于 X 分钟前」。
      lastError = messageOf(error);
      failures += 1;
      ctx.logger?.warn?.(`${name}: 抓取失败（连续第 ${failures} 次）：${lastError}`);
    }
  }

  /**
   * 递归 setTimeout 而非 setInterval：每个周期都重读配置，
   * 于是「轮询间隔」这个 volatile 字段改完立刻在下一轮生效。
   */
  function schedule() {
    if (disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh().then(schedule);
    }, resolveConfig().pollIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  ctx.effect(() => {
    disposed = false;
    void refresh();
    schedule();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
  }, `${name}: poller`);

  /* ⚠️ 路由**不要**包在 webCtx.effect 里：实测包了之后 register 确实执行、路由却始终
   * 404（对照 dsh-thinking-panel / dsh-bottom-info-bar，都是直接调 register）。
   * webServer 也只是 web profile 才有，所以用运行时 ctx.inject 做可选获取，
   * 而不是静态 `export const inject`（后者是硬门禁，缺服务会让插件静默不激活）。 */
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: (_req, res) => {
        const payload = snapshot === null
          ? { ...EMPTY_SNAPSHOT, error: lastError ?? "no data yet", failures }
          : { ...snapshot, error: lastError, failures };
        let body;
        try {
          body = JSON.stringify(payload);
        } catch (error) {
          body = JSON.stringify({ ...EMPTY_SNAPSHOT, error: `serialize failed: ${messageOf(error)}` });
        }
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
        });
        res.end(body);
      },
    });
    ctx.logger?.info?.(`${name}: 已注册同源路由 ${ROUTE_PATH}`);
  });

  const cfg = resolveConfig();
  ctx.logger?.info?.(`${name}: 每 ${cfg.pollIntervalMs}ms 轮询 ${cfg.sourceUrl}（超时 ${cfg.timeoutMs}ms）`);
}

export { EMPTY_SNAPSHOT };
