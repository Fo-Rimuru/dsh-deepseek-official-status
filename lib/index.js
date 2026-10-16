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
import { createRequire } from "node:module";
import z from "@deepseek-ai/schemastery";
import { parseStatusHtml, parseStatusRsc } from "./parser.js";
import { eventsFromRss, parseRssFeed } from "./rss.js";

export const name = "dsh-deepseek-official-status";

/** 浏览器半部只读这一个同源端点。 */
export const ROUTE_PATH = "/deepseek-official-status/current";

/**
 * 阶段 3 原型的诊断端点：探测宿主侧能否做「背景采样」。
 * 真折射需要 `webContents.capturePage(rect)` 抓面板背后的画面，这里先把可行性问清楚。
 */
export const GLASS_PROBE_PATH = "/deepseek-official-status/glass-probe";

/** ESM 模块里没有 `require` —— 探测 Electron 时得借道 createRequire。 */
const nodeRequire = createRequire(import.meta.url);

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

/** 面板观感默认值 —— 客户端 CSS 里的 `--dsos-*` 变量全部由这些值驱动。 */
export const GLASS_DEFAULTS = {
  alpha: 44,      // 玻璃底色不透明度（%）—— 太透会发白，保留一点"体"
  blur: 7,        // 背景模糊半径（px）—— 作者反馈仍偏高
  saturate: 180,  // 背景饱和度（%）—— 提饱和才有玻璃的"色"，降饱和只会发白
  highlight: 40,  // 边缘高光强度（%）—— 玻璃靠边缘亮线立住
  radius: 18,     // 面板圆角（px）
  refraction: 18, // 折射感强度（%）：驱动边缘环带的宽度与额外模糊量
};

const GLASS_RANGES = {
  alpha: [5, 100],
  blur: [0, 48],
  saturate: [100, 260],
  highlight: [0, 100],
  radius: [4, 28],
  refraction: [0, 100],
};

const configSchema = z.object({
  sourceUrl: z.string().default(DEFAULT_SOURCE).description("状态页地址"),
  pollIntervalMs: z.number().min(MIN_POLL_MS).max(MAX_POLL_MS).default(DEFAULTS.pollIntervalMs)
    .description("轮询间隔（毫秒，15000–3600000）"),
  timeoutMs: z.number().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULTS.timeoutMs)
    .description("抓取超时（毫秒，5000–120000）"),
  glassAlpha: z.number().min(5).max(100).default(GLASS_DEFAULTS.alpha)
    .description("玻璃不透明度（%，5–100）"),
  glassBlur: z.number().min(0).max(48).default(GLASS_DEFAULTS.blur)
    .description("背景模糊（px，0–48）"),
  glassSaturate: z.number().min(100).max(260).default(GLASS_DEFAULTS.saturate)
    .description("背景饱和度（%，100–260）"),
  glassHighlight: z.number().min(0).max(100).default(GLASS_DEFAULTS.highlight)
    .description("边缘高光（%，0–100）"),
  glassRadius: z.number().min(4).max(28).default(GLASS_DEFAULTS.radius)
    .description("面板圆角（px，4–28）"),
  glassRefraction: z.number().min(0).max(100).default(GLASS_DEFAULTS.refraction)
    .description("折射感强度（%，0–100）—— 边缘环带的宽度与额外模糊量"),
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
/**
 * 阶段 3 原型：探测宿主侧能否做「背景采样」。
 *
 * 真折射需要 `webContents.capturePage(rect)` 抓到面板背后的画面，再交给客户端用
 * WebGL 做位移采样 —— 前提是宿主插件（跑在 cordis 容器里）能拿到 Electron 的
 * webContents。这个函数把结论一次性全量报出来，避免反复试错。
 *
 * @returns {Promise<object>} 探测报告（JSON 友好）
 */
async function probeGlassBackend() {
  const report = {
    // 先看进程身份 —— 它决定了能不能 require 到 electron：
    // Electron 会给 process.type 赋值（browser / renderer / utility），
    // utilityProcess 里还会额外有 process.parentPort。
    processType: typeof process.type === "string" ? process.type : null,
    electronInProcessVersions: process.versions.electron ?? null,
    nodeVersion: process.versions.node ?? null,
    execPath: process.execPath,
    hasParentPort: process.parentPort !== undefined && process.parentPort !== null,
    resourcesPath: process.resourcesPath ?? null,
    canRequireElectron: false,
    errors: [],
  };
  let electron = null;
  try {
    electron = nodeRequire("electron");
    report.canRequireElectron = true;
  } catch (error) {
    report.errors.push(`require('electron') 失败：${messageOf(error)}`);
    return report;
  }

  report.electronVersion = typeof electron.app?.getVersion === "function" ? electron.app.getVersion() : null;
  report.hasBrowserWindow = typeof electron.BrowserWindow === "function";
  report.hasGetAllWebContents = typeof electron.webContents?.getAllWebContents === "function";

  let target = null;
  try {
    const wins = electron.BrowserWindow?.getAllWindows?.() ?? [];
    report.windowCount = wins.length;
    report.windows = wins.map((w) => ({
      id: w.id,
      bounds: w.getBounds(),
      visible: w.isVisible(),
      url: w.webContents?.getURL?.() ?? null,
      type: w.webContents?.getType?.() ?? null,
    }));
    const visible = wins.find((w) => w.isVisible() && (w.webContents?.getURL?.() ?? "").startsWith("http"));
    target = visible?.webContents ?? wins[0]?.webContents ?? null;
  } catch (error) {
    report.errors.push(`枚举窗口失败：${messageOf(error)}`);
  }

  if (target === null && typeof electron.webContents?.getAllWebContents === "function") {
    try {
      const all = electron.webContents.getAllWebContents();
      report.webContentsCount = all.length;
      report.allTypes = all.map((wc) => wc.getType());
      target = all.find((wc) => wc.getType() === "window") ?? all[0] ?? null;
    } catch (error) {
      report.errors.push(`getAllWebContents 失败：${messageOf(error)}`);
    }
  }

  if (target === null) {
    report.errors.push("没有可用的 webContents");
    return report;
  }

  try {
    report.targetKind = target.getType?.() ?? null;
    report.targetSize = target.getSize?.() ?? null;
    report.targetZoom = target.getZoomFactor?.() ?? null;
    // 拿一小块做冒烟测试：成功与否 + 耗时 + 产出大小。
    const rect = { x: 20, y: 20, width: 240, height: 140 };
    const started = Date.now();
    const image = await target.capturePage(rect);
    const ms = Date.now() - started;
    const png = typeof image?.toPNG === "function" ? image.toPNG() : null;
    report.captured = {
      ms,
      empty: typeof image?.isEmpty === "function" ? image.isEmpty() : null,
      size: typeof image?.getSize === "function" ? image.getSize() : null,
      pngBytes: png === null ? null : png.length,
    };
  } catch (error) {
    report.errors.push(`capturePage 失败：${messageOf(error)}`);
  }
  return report;
}

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
      glass: {
        alpha: clampNumber(raw.glassAlpha, GLASS_DEFAULTS.alpha, ...GLASS_RANGES.alpha),
        blur: clampNumber(raw.glassBlur, GLASS_DEFAULTS.blur, ...GLASS_RANGES.blur),
        saturate: clampNumber(raw.glassSaturate, GLASS_DEFAULTS.saturate, ...GLASS_RANGES.saturate),
        highlight: clampNumber(raw.glassHighlight, GLASS_DEFAULTS.highlight, ...GLASS_RANGES.highlight),
        radius: clampNumber(raw.glassRadius, GLASS_DEFAULTS.radius, ...GLASS_RANGES.radius),
        refraction: clampNumber(raw.glassRefraction, GLASS_DEFAULTS.refraction, ...GLASS_RANGES.refraction),
      },
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
        // 观感参数每轮现读：volatile 改完不用重启，下一次请求就带上新值。
        const payload = snapshot === null
          ? { ...EMPTY_SNAPSHOT, glass: resolveConfig().glass, error: lastError ?? "no data yet", failures }
          : { ...snapshot, glass: resolveConfig().glass, error: lastError, failures };
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

    /* 阶段 3 原型：背景采样诊断端点。
     * 真折射要用 webContents.capturePage 抓面板背后的画面，所以先把「宿主插件能不能
     * 拿到 Electron 的 webContents」这件事问清楚 —— 拿得到才有这条路。 */
    webCtx.webServer.register({
      kind: "exact",
      path: GLASS_PROBE_PATH,
      handler: (_req, res) => {
        void probeGlassBackend()
          .then((report) => {
            const body = JSON.stringify(report, null, 2);
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "content-length": Buffer.byteLength(body),
              "cache-control": "no-store",
            });
            res.end(body);
          })
          .catch((error) => {
            const body = JSON.stringify({ error: messageOf(error) });
            res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
            res.end(body);
          });
      },
    });
    ctx.logger?.info?.(`${name}: 已注册诊断路由 ${GLASS_PROBE_PATH}`);
  });

  const cfg = resolveConfig();
  ctx.logger?.info?.(`${name}: 每 ${cfg.pollIntervalMs}ms 轮询 ${cfg.sourceUrl}（超时 ${cfg.timeoutMs}ms）`);
}

export { EMPTY_SNAPSHOT };
