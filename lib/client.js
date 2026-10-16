/**
 * DeepSeek 官方服务状态 — 浏览器半部。
 *
 * 挂在会话头部的 `conversation.session.header.actions` 槽位（会话标题右侧那一格）：
 * 平时只是一颗**信号灯**（纯圆点，颜色表状态，不带文字），鼠标移上去展开详情面板，
 * 移开即恢复成一颗点。面板里有总体状态、最后更新时间、各组件状态、进行中/最近事件、
 * 各组件 uptime%。
 *
 * 数据只从宿主半部的同源路由 `/deepseek-official-status/current` 读取
 * （宿主负责轮询 status.deepseek.com，浏览器因此不碰外部站点、无 CORS 问题）。
 *
 * 宿主在状态页负载解析失败时可能降级为 RSS 事件源：那时快照带 `degraded: true`、
 * `overall: "unknown"`（灰）、组件与 uptime 为空 —— 本面板据此显示降级提示，
 * 而不是把「拿到事件」当成「服务正常」。
 *
 * 手写 ModuleLoader bundle，无构建步骤。
 */
window.__ModuleLoader__.load({
  id: "dsh-deepseek-official-status",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    /** portal 渲染需要 react-dom；拿不到就退回绝对定位渲染（老宿主）。 */
    let reactDom = null;
    try {
      reactDom = require("react-dom");
    } catch {
      reactDom = null;
    }
    const h = react.createElement;

    const PLUGIN_ID = "dsh-deepseek-official-status";
    const NS = "deepseek-official-status";
    const ROUTE = "/deepseek-official-status/current";
    const STATUS_PAGE = "https://status.deepseek.com/";
    /** 客户端读宿主路由的间隔；宿主自己按配置轮询，这里只需够及时地反映它的结果。 */
    const CLIENT_POLL_MS = 20000;
    /** 鼠标离开后延迟收起，让指针能从灯移到面板上而不被打断。 */
    const HIDE_DELAY_MS = 180;

    // ── CSS ────────────────────────────────────────────────────────────────
    const CSS = `
.__dsos_root{position:relative;display:inline-flex;align-items:center}
.__dsos_btn{align-items:center;justify-content:center;width:28px;height:28px;padding:0;color:var(--dsw-alias-label-tertiary);cursor:default;background:0 0;border:0;border-radius:6px;display:inline-flex}
.__dsos_btn:hover{background:rgba(127,127,127,.16)}
.__dsos_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
.__dsos_dot{flex:none;border-radius:50%;display:inline-block;background:var(--dsos_c);box-shadow:0 0 0 3px var(--dsos_h)}
.__dsos_lamp{width:10px;height:10px}
.__dsos_mini{width:7px;height:7px;box-shadow:none}
.__dsos_ok{--dsos_c:var(--dsw-alias-state-success-primary,#22c55e);--dsos_h:rgba(34,197,94,.20)}
.__dsos_maint{--dsos_c:var(--dsw-alias-state-business-primary,#3b82f6);--dsos_h:rgba(59,130,246,.20)}
.__dsos_degraded{--dsos_c:#f59e0b;--dsos_h:rgba(245,158,11,.22)}
.__dsos_partial{--dsos_c:#f97316;--dsos_h:rgba(249,115,22,.22)}
.__dsos_outage{--dsos_c:var(--dsw-alias-state-error-primary,#ef4444);--dsos_h:rgba(239,68,68,.20)}
.__dsos_unknown{--dsos_c:var(--dsw-alias-label-tertiary,#9ca3af);--dsos_h:rgba(156,163,175,.20)}
.__dsos_panel{z-index:3000;box-sizing:border-box;width:340px;max-width:min(400px,100vw - 32px);max-height:min(480px,100vh - 160px);padding:0;border:1px solid rgba(255,255,255,.16);border-radius:var(--dsos-radius,18px);background:radial-gradient(220px 150px at var(--dsos-hx,50%) var(--dsos-hy,0%),rgba(255,255,255,calc(var(--dsos-refr,.26) * .20)),transparent 72%),linear-gradient(158deg,rgba(255,255,255,calc(var(--dsos-hl,.40) * .43)),rgba(255,255,255,calc(var(--dsos-hl,.40) * .1)) 42%,rgba(255,255,255,calc(var(--dsos-hl,.40) * .25))),rgba(19,22,29,var(--dsos-alpha,.44));-webkit-backdrop-filter:blur(var(--dsos-blur,11px)) saturate(var(--dsos-saturate,180%)) brightness(1.02);backdrop-filter:blur(var(--dsos-blur,11px)) saturate(var(--dsos-saturate,180%)) brightness(1.02);box-shadow:0 20px 48px rgba(0,0,0,.42),0 2px 8px rgba(0,0,0,.24),inset 0 1px 0 rgba(255,255,255,var(--dsos-hl,.40)),inset 0 -1px 0 rgba(255,255,255,.06),inset 0 0 0 1px rgba(255,255,255,.05),inset 4px 0 8px -6px rgba(255,96,96,.55),inset -4px 0 8px -6px rgba(96,156,255,.55),inset 0 4px 8px -6px rgba(255,216,140,.5),inset 0 -4px 8px -6px rgba(150,120,255,.5);display:flex;flex-direction:column;overflow:hidden;font-size:12px;line-height:18px;text-align:left;isolation:isolate}
/* 边缘渐进模糊 —— 模拟透镜：真玻璃的边缘是强弯折区、中心是平的，所以「环带 mask +
   更强的 backdrop-filter」比均匀模糊像得多（均匀模糊看着像毛玻璃，梯度模糊才像透镜）。
   环带宽度与模糊量都由 --dsos-refr 驱动（= glassRefraction 参数）。 */
.__dsos_panel::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:calc(var(--dsos-refr,.26) * 24px);-webkit-backdrop-filter:blur(calc(var(--dsos-refr,.26) * 30px)) saturate(150%);backdrop-filter:blur(calc(var(--dsos-refr,.26) * 30px)) saturate(150%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;z-index:-1}
/* 内容滚动放在内层：外壳不滚动，边缘环带（::before）才不会跟着内容跑偏。 */
.__dsos_body{display:flex;flex-direction:column;gap:10px;padding:14px;overflow:auto;min-height:0}
.__dsos_head{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.__dsos_link{margin-left:auto;color:var(--dsw-alias-brand-primary,#4d6bfe);text-decoration:none;font-size:11px;font-weight:400;white-space:nowrap}
.__dsos_link:hover{text-decoration:underline}
.__dsos_sub{color:var(--dsw-alias-label-tertiary);font-size:11px}
.__dsos_err{color:var(--dsw-alias-label-error,#ef4444);font-size:11px;word-break:break-word}
.__dsos_warn{color:#f59e0b;font-size:11px;line-height:16px;word-break:break-word}
.__dsos_sect{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase}
.__dsos_row{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary)}
.__dsos_name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.__dsos_val{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.__dsos_ev{display:flex;flex-direction:column;gap:2px}
.__dsos_evTop{display:flex;align-items:flex-start;gap:6px}
.__dsos_evTitle{flex:1;min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word}
.__dsos_evTitleLink{color:inherit;text-decoration:none}
.__dsos_evTitleLink:hover{text-decoration:underline}
.__dsos_evMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;padding-left:15px}
.__dsos_evBody{color:var(--dsw-alias-label-tertiary);font-size:11px;padding-left:15px;word-break:break-word}
/* 装了壁纸引擎（dsh-plugin-wallpaper-engine）时跟着它的液态玻璃走 —— 但**只替换底色**。
   ⚠️ 必须用 background-color，不能用 background 简写：简写会把 background-image 一起
   重置，镜面高光 radial-gradient 与玻璃渐变会连带消失。正式版里开着壁纸插件时出现
   「高光跟随不见了」就是这个原因（副本没跑壁纸插件，所以当时没暴露）。
   模糊 / 高光 / 渐变继续沿用上面的基础规则，只把色调交给壁纸引擎。 */
body[data-we-glass-page] .__dsos_panel,
body[data-we-glass-window] .__dsos_panel,
body[data-we-glass-chat] .__dsos_panel,
body[data-we-glass-floaters] .__dsos_panel{
  /* 只借壁纸引擎的**色调**（--we-surface-tint-rgb-dark），不透明度仍由 glassAlpha 决定。
     不能直接用它的 --we-chat-glass-fill：那个值自带 alpha（高可读性模式下还会变成
     接近纯白的 color-mix），一旦用它，用户调 glassAlpha 就完全没反应，而且面板会发白。 */
  background-color:rgba(var(--we-surface-tint-rgb-dark,19,22,29),var(--dsos-alpha,.44));
  border-color:rgba(255,255,255,var(--we-border-alpha,.16));
}
`;
    const cssTagId = `${PLUGIN_ID}/client.css`;
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${cssTagId}"]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = cssTagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── 词典 ───────────────────────────────────────────────────────────────
    const zh = {
      aria: "DeepSeek 官方服务状态",
      operational: "所有系统运行正常",
      maintenance: "维护中",
      degraded: "性能下降",
      partial_outage: "部分故障",
      full_outage: "严重故障",
      unknown: "状态未知",
      updated: "更新于 {time}",
      components: "组件状态",
      activeEvents: "进行中的事件",
      noActiveEvents: "当前无进行中的事件或维护",
      recentEvents: "最近事件",
      noRecentEvents: "暂无历史事件",
      uptime: "可用率",
      openPage: "打开状态页 ↗",
      fetchFailed: "无法获取服务状态",
      lastError: "最近一次刷新失败：{msg}",
      degradedSource: "⚠ 组件状态数据源不可用（状态页负载解析失败），当前仅能显示事件列表",
      noDataYet: "正在获取状态数据…",
      justNow: "刚刚",
      minutesAgo: "{n} 分钟前",
      hoursAgo: "{n} 小时前",
      daysAgo: "{n} 天前",
      unknownTime: "未知时间",
      eventStatus: {
        investigating: "调查中", identified: "已定位", monitoring: "监控中",
        resolved: "已解决", scheduled: "已计划", in_progress: "进行中",
        ongoing: "进行中", completed: "已完成", cancelled: "已取消",
      },
    };
    const en = {
      aria: "DeepSeek official service status",
      operational: "All systems operational",
      maintenance: "Under maintenance",
      degraded: "Degraded performance",
      partial_outage: "Partial outage",
      full_outage: "Full outage",
      unknown: "Status unavailable",
      updated: "Updated {time}",
      components: "Components",
      activeEvents: "Active events",
      noActiveEvents: "No active incidents or maintenance",
      recentEvents: "Recent events",
      noRecentEvents: "No recent events",
      uptime: "Uptime",
      openPage: "Open status page ↗",
      fetchFailed: "Unable to fetch service status",
      lastError: "Last refresh failed: {msg}",
      degradedSource: "⚠ Component status source unavailable (status page payload unreadable) — showing events only",
      noDataYet: "Fetching status…",
      justNow: "just now",
      minutesAgo: "{n} min ago",
      hoursAgo: "{n} h ago",
      daysAgo: "{n} d ago",
      unknownTime: "unknown time",
      eventStatus: {
        investigating: "Investigating", identified: "Identified", monitoring: "Monitoring",
        resolved: "Resolved", scheduled: "Scheduled", in_progress: "In progress",
        ongoing: "In progress", completed: "Completed", cancelled: "Cancelled",
      },
    };

    // ── 状态元数据：颜色语义见 README（绿正常/蓝维护/黄降级/橙部分/红严重/灰未知） ──
    const STATUS_META = {
      operational: { cls: "__dsos_ok", label: "operational" },
      maintenance: { cls: "__dsos_maint", label: "maintenance" },
      degraded: { cls: "__dsos_degraded", label: "degraded" },
      partial_outage: { cls: "__dsos_partial", label: "partial_outage" },
      full_outage: { cls: "__dsos_outage", label: "full_outage" },
      unknown: { cls: "__dsos_unknown", label: "unknown" },
    };
    const metaOf = (status) => STATUS_META[status] ?? STATUS_META.unknown;

    /** 事件状态 → 灯色（事件状态比组件状态多得多，这里归一到调色板）。 */
    function eventDotClass(status) {
      switch (status) {
        case "resolved":
        case "completed": return "__dsos_ok";
        case "cancelled": return "__dsos_unknown";
        case "monitoring": return "__dsos_degraded";
        case "scheduled":
        case "in_progress":
        case "ongoing": return "__dsos_maint";
        default: return "__dsos_partial";
      }
    }

    function Dot({ status, small }) {
      return h("span", { className: `__dsos_dot ${small ? "__dsos_mini" : "__dsos_lamp"} ${metaOf(status).cls}` });
    }

    /** 相对时间；只用于展示，不做本地化日期格式。 */
    function fmtAgo(ms, t) {
      if (!Number.isFinite(ms)) return t("unknownTime");
      const diff = Date.now() - ms;
      if (diff < 0) return t("justNow");
      if (diff < 60000) return t("justNow");
      const minutes = Math.floor(diff / 60000);
      if (minutes < 60) return t("minutesAgo").replace("{n}", String(minutes));
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t("hoursAgo").replace("{n}", String(hours));
      return t("daysAgo").replace("{n}", String(Math.floor(hours / 24)));
    }

    function eventStatusLabel(status, t) {
      return t("eventStatus")[status] ?? status;
    }

    /** 事件标题：RSS 兜底源带 link 时做成可点链接，flight 事件保持纯文本。 */
    function EventTitle({ event }) {
      if (typeof event.link === "string" && event.link !== "") {
        return h("a", {
          className: "__dsos_evTitle __dsos_evTitleLink",
          href: event.link,
          target: "_blank",
          rel: "noreferrer",
        }, event.title);
      }
      return h("span", { className: "__dsos_evTitle" }, event.title);
    }

    // ── 数据：轮询宿主的同源路由 ───────────────────────────────────────────
    function useStatus() {
      const [state, setState] = react.useState({ data: null, error: null });
      react.useEffect(() => {
        let alive = true;
        function tick() {
          fetch(ROUTE, { cache: "no-store" })
            .then((res) => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.json();
            })
            .then((data) => {
              if (!alive) return;
              // 宿主把「上一次快照 + 本次抓取错误」一起返回：两者要分开呈现。
              setState({ data, error: data.error ?? null });
            })
            .catch((error) => {
              if (!alive) return;
              // 拉不到就保留上一次的数据，只记错误 —— 不把画面清成「未知」。
              setState((prev) => ({ data: prev.data, error: String(error.message ?? error) }));
            });
        }
        tick();
        const timer = setInterval(tick, CLIENT_POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      return state;
    }

    // ── 面板定位（自适应）──────────────────────────────────────────────────
    /* 面板通过 portal 挂在 document.body 上，位置因此要自己算：
     *  - 水平：默认右对齐信号灯，撞到视口左右边缘就平移回来；
     *  - 垂直：默认向下展开，下方放不下且上方更宽裕时改为向上；
     *  - 高度：按剩余空间收窄，永远不出视口。
     * 这样既不会被父容器的 overflow 裁掉，也不会被左侧边栏之类的高层级元素盖住。 */
    const PANEL_W = 340;
    const PANEL_GAP = 8;
    const PANEL_MAX_H = 480;

    function panelPlacement(anchor) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(PANEL_W, Math.max(240, vw - PANEL_GAP * 2));
      if (anchor === null || typeof anchor.getBoundingClientRect !== "function") {
        return { left: PANEL_GAP, top: PANEL_GAP, width, maxHeight: PANEL_MAX_H };
      }
      const rect = anchor.getBoundingClientRect();
      // 与信号灯**左对齐**（面板向右展开）：信号灯在会话头部左侧，若改成右对齐，
      // 340px 宽的面板会往左摊、正好压住左侧边栏。之后再按视口夹紧，
      // 保证整块面板始终落在视口内（靠右时会被拉回来）。
      let left = Math.max(PANEL_GAP, rect.left);
      left = Math.min(left, Math.max(PANEL_GAP, vw - width - PANEL_GAP));
      const below = vh - rect.bottom - PANEL_GAP * 2;
      const above = rect.top - PANEL_GAP * 2;
      const goUp = below < 240 && above > below;
      const top = goUp
        ? Math.max(PANEL_GAP, rect.top - PANEL_GAP - Math.min(PANEL_MAX_H, above))
        : rect.bottom + PANEL_GAP;
      return { left, top, width, maxHeight: Math.max(160, Math.min(PANEL_MAX_H, goUp ? above : below)) };
    }

    // ── 详情面板 ───────────────────────────────────────────────────────────
    function Panel({ t, data, error, place }) {
      const overall = data?.overall ?? "unknown";
      const uptimeById = new Map((data?.uptime ?? []).map((u) => [u.id, u.uptime]));
      const updatedAt = data?.fetchedAt ?? data?.updatedAt ?? null;
      const components = data?.components ?? [];
      const active = data?.active ?? [];
      const recent = data?.recentResolved ?? [];
      const noData = data === null;
      // 宿主降级为 RSS 事件源：组件状态与 uptime 无从得知，必须明说。
      const degraded = data?.degraded === true;
      // 观感参数由宿主下发（`.volatile()` 配置，改完不用重启）→ 全部喂给 CSS 变量，
      // 于是「透明度 / 模糊 / 饱和度 / 高光 / 圆角」都能在插件页的卡片里直接调。
      const panelRef = react.useRef(null);
      // 镜面高光跟随指针：把指针在面板内的相对位置写进 CSS 变量，交给 background 里的
      // radial-gradient 消费 —— 静态高光看着像贴图，跟着动才像玻璃。
      react.useEffect(() => {
        const el = panelRef.current;
        if (el === null) return undefined;
        const onMove = (event) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          el.style.setProperty("--dsos-hx", `${(((event.clientX - rect.left) / rect.width) * 100).toFixed(2)}%`);
          el.style.setProperty("--dsos-hy", `${(((event.clientY - rect.top) / rect.height) * 100).toFixed(2)}%`);
        };
        window.addEventListener("pointermove", onMove, { passive: true });
        return () => window.removeEventListener("pointermove", onMove);
      }, []);

      const g = data?.glass ?? {};
      const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
      const panelVars = {
        "--dsos-alpha": String(num(g.alpha, 44) / 100),
        "--dsos-blur": `${num(g.blur, 11)}px`,
        "--dsos-saturate": `${num(g.saturate, 180)}%`,
        "--dsos-hl": String(num(g.highlight, 40) / 100),
        "--dsos-radius": `${num(g.radius, 18)}px`,
        "--dsos-refr": String(num(g.refraction, 26) / 100),
      };

      return h("div", {
        ref: panelRef,
        className: "__dsos_panel",
        style: {
          ...panelVars,
          ...(place === null || place === undefined ? {} : {
            position: "fixed",
            left: `${place.left}px`,
            top: `${place.top}px`,
            width: `${place.width}px`,
            maxHeight: `${place.maxHeight}px`,
          }),
        },
      },
        h("div", { className: "__dsos_body" },
        h("div", { className: "__dsos_head" },
          h(Dot, { status: overall }),
          h("span", null, t(metaOf(overall).label)),
          h("a", {
            className: "__dsos_link",
            href: STATUS_PAGE,
            target: "_blank",
            rel: "noreferrer",
          }, t("openPage")),
        ),
        h("div", { className: "__dsos_sub" }, noData ? t("noDataYet") : t("updated").replace("{time}", fmtAgo(updatedAt, t))),
        degraded ? h("div", { className: "__dsos_warn" }, t("degradedSource")) : null,
        // 降级时不再重复报错：降级提示已经说明了原因。
        error !== null && !noData && !degraded ? h("div", { className: "__dsos_err" }, t("lastError").replace("{msg}", error)) : null,

        components.length > 0 ? h("div", { className: "__dsos_sect" }, t("components")) : null,
        ...components.map((component) => {
          const uptime = uptimeById.get(component.id);
          return h("div", { className: "__dsos_row", key: component.id || component.name },
            h(Dot, { status: component.status, small: true }),
            h("span", { className: "__dsos_name" }, component.name),
            Number.isFinite(uptime) ? h("span", { className: "__dsos_val" }, `${uptime.toFixed(2)}%`) : null,
          );
        }),

        h("div", { className: "__dsos_sect" }, t("activeEvents")),
        ...(active.length === 0
          ? [h("div", { className: "__dsos_sub" }, t("noActiveEvents"))]
          : active.map((event, index) => h("div", { className: "__dsos_ev", key: `a${index}` },
              h("div", { className: "__dsos_evTop" },
                h("span", { className: `__dsos_dot __dsos_mini ${eventDotClass(event.status)}` }),
                h(EventTitle, { event }),
              ),
              h("div", { className: "__dsos_evMeta" },
                eventStatusLabel(event.status, t)
                + (Number.isFinite(event.startedAt) ? ` · ${fmtAgo(event.startedAt * 1000, t)}` : ""),
              ),
              event.description !== "" ? h("div", { className: "__dsos_evBody" }, event.description) : null,
            ))),

        h("div", { className: "__dsos_sect" }, t("recentEvents")),
        ...(recent.length === 0
          ? [h("div", { className: "__dsos_sub" }, t("noRecentEvents"))]
          : recent.map((event, index) => h("div", { className: "__dsos_ev", key: `r${index}` },
              h("div", { className: "__dsos_evTop" },
                h("span", { className: `__dsos_dot __dsos_mini ${eventDotClass(event.status)}` }),
                h(EventTitle, { event }),
              ),
              h("div", { className: "__dsos_evMeta" },
                eventStatusLabel(event.status, t)
                + (Number.isFinite(event.closedAt) ? ` · ${fmtAgo(event.closedAt * 1000, t)}` : ""),
              ),
            ))),
        ),
      );
    }

    // ── 信号灯 ─────────────────────────────────────────────────────────────
    function StatusLamp({ t }) {
      const { data, error } = useStatus();
      const [open, setOpen] = react.useState(false);
      const [place, setPlace] = react.useState(null);
      const hideTimer = react.useRef(null);
      const btnRef = react.useRef(null);
      const overall = data?.overall ?? "unknown";

      const cancelHide = () => {
        if (hideTimer.current !== null) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
      };
      // 先量好位置再打开：否则首帧 place 仍是 null，Panel 会以「无定位」状态落进文档流，
      // 表现为「第一次悬停时面板跑到整个窗口最下面，移开再回来才正常」。
      const show = () => {
        cancelHide();
        setPlace(panelPlacement(btnRef.current));
        setOpen(true);
      };
      const hideSoon = () => {
        cancelHide();
        hideTimer.current = setTimeout(() => { hideTimer.current = null; setOpen(false); }, HIDE_DELAY_MS);
      };
      react.useEffect(() => cancelHide, []);
      // 打开、滚动、缩放时都重算面板位置（portal 之后它不再跟随父元素）。
      react.useLayoutEffect(() => {
        if (!open) return undefined;
        const recompute = () => setPlace(panelPlacement(btnRef.current));
        recompute();
        window.addEventListener("scroll", recompute, true);
        window.addEventListener("resize", recompute);
        return () => {
          window.removeEventListener("scroll", recompute, true);
          window.removeEventListener("resize", recompute);
        };
      }, [open]);

      return h("div", {
        className: "__dsos_root",
        onMouseEnter: show,
        onMouseLeave: hideSoon,
      },
        h("button", {
          ref: btnRef,
          type: "button",
          className: "__dsos_btn",
          "aria-label": `${t("aria")}：${t(metaOf(overall).label)}`,
          "aria-expanded": open,
          onFocus: show,
          onBlur: hideSoon,
        }, h(Dot, { status: overall })),
        open
          ? (reactDom !== null && place !== null
              ? reactDom.createPortal(h(Panel, { t, data, error, place }), document.body)
              : h(Panel, { t, data, error, place: null }))
          : null,
      );
    }

    // ── 插件页（侧栏「插件」）上的配置卡片 ──────────────────────────────────
    /* DSH 的插件页**不会**把 Config 自动渲染成表单。官方 README 的原话是「自带配置的
     * 插件把配置渲染在本页而不是设置里」，通过 plugins.bundle.config（以组合包包名为键）
     * / plugins.row.config 这两个 slot —— 也就是说**表单 UI 得插件自备**。
     * 这里复用官方 primitives，写法照 @deepseek-ai/dsh-client-ui-settings-shell：
     * SettingsFormModel 管状态与提交，SettingsForm + SettingsValueField 负责渲染，
     * 草稿、校验、覆盖标记、保存按钮都交给它们。
     * 宿主没服务这个命名空间（插件未激活 / 老宿主没有 configForms）时不注册，页面自然空白。 */
    const CFG_NS = `${NS}.config`;
    const cfgZh = {
      title: "服务状态",
      description: "在会话头部显示 DeepSeek 官方服务状态（status.deepseek.com）。",
      sourceUrl: "状态页地址",
      sourceUrlHint: "默认 https://status.deepseek.com/，留空即用默认值。",
      pollIntervalMs: "宿主轮询间隔（毫秒）",
      pollIntervalMsHint: "多久抓一次状态页，允许 15000–3600000。",
      timeoutMs: "单次抓取超时（毫秒）",
      timeoutMsHint: "单次请求允许多久，允许 5000–120000。",
      glassAlpha: "面板：玻璃不透明度（%）",
      glassAlphaHint: "面板底色的不透明度，越大越实、越小越透，允许 5–100。",
      glassBlur: "面板：背景模糊（px）",
      glassBlurHint: "面板背后内容的模糊半径，越大越像毛玻璃，允许 0–48。",
      glassSaturate: "面板：背景饱和度（%）",
      glassSaturateHint: "提升透过面板看到的颜色浓度，允许 100–260。",
      glassHighlight: "面板：边缘高光（%）",
      glassHighlightHint: "玻璃边缘亮线与顶部高光的强度，允许 0–100。",
      glassRadius: "面板：圆角（px）",
      glassRadiusHint: "面板的圆角半径，允许 4–28。",
      overridden: "已覆盖",
      reset: "恢复默认",
      readOnly: "本部署的设置为只读。",
      unavailable: "该插件当前未加载，暂时无法配置。",
      save: "保存",
      saving: "保存中…",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      invalidNumber: "请填数字；留空表示使用默认值。",
    };
    const cfgEn = {
      title: "Service status",
      description: "DeepSeek official service status (status.deepseek.com) in the conversation header.",
      sourceUrl: "Status page URL",
      sourceUrlHint: "Defaults to https://status.deepseek.com/; leave blank for the default.",
      pollIntervalMs: "Host poll interval (ms)",
      pollIntervalMsHint: "How often the status page is fetched, 15000–3600000.",
      timeoutMs: "Fetch timeout (ms)",
      timeoutMsHint: "How long one request may take, 5000–120000.",
      glassAlpha: "Panel: glass opacity (%)",
      glassAlphaHint: "Opacity of the panel fill — higher is more solid, 5–100.",
      glassBlur: "Panel: background blur (px)",
      glassBlurHint: "Blur radius applied to what sits behind the panel, 0–48.",
      glassSaturate: "Panel: background saturation (%)",
      glassSaturateHint: "Boosts the colour seen through the panel, 100–260.",
      glassHighlight: "Panel: edge highlight (%)",
      glassHighlightHint: "Strength of the glass rim and top highlight, 0–100.",
      glassRadius: "Panel: corner radius (px)",
      glassRadiusHint: "Corner radius of the panel, 4–28.",
      overridden: "Overridden",
      reset: "Reset to default",
      readOnly: "This deployment stores settings read-only.",
      unavailable: "This plugin is not loaded, so it cannot be configured right now.",
      save: "Save",
      saving: "Saving…",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      invalidNumber: "Enter a number, or leave blank to use the default.",
    };

    /** 官方 primitives 懒加载：拿不到就不注册配置卡片，信号灯照常工作。 */
    let primitives = null;
    function uiPrimitives() {
      if (primitives === null) primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      return primitives;
    }

    /** 插件页的配置卡片：`summary` 视图给一句话，`page` 视图给表单。 */
    function ConfigCard(props) {
      const t = props.t;
      if (props.view === "summary") return t("description");
      const ui = uiPrimitives();
      const state = props.useStatusConfig((snapshot) => snapshot);
      const disabled = state.writable !== true;
      const valueField = (name, labelKey, hintKey, numeric) => h(ui.SettingsValueField, {
        id: `dsos-config-${name}`,
        key: name,
        label: t(labelKey),
        hint: t(hintKey),
        overriddenLabel: t("overridden"),
        resetLabel: t("reset"),
        invalidLabel: t("invalidNumber"),
        ...(numeric === true ? { numeric: true } : {}),
        disabled,
        ...state[name],
        onEdit: (text) => props.edit(name, text),
        onReset: () => props.resetField(name),
      });
      return h(ui.SettingsForm, {
        labels: {
          unavailable: t("unavailable"),
          readOnly: t("readOnly"),
          saveFailed: t("saveFailed"),
          save: t("save"),
          saving: t("saving"),
        },
        state,
        onSave: props.save,
        onDiscard: props.discard,
      },
        valueField("sourceUrl", "sourceUrl", "sourceUrlHint", false),
        valueField("pollIntervalMs", "pollIntervalMs", "pollIntervalMsHint", true),
        valueField("timeoutMs", "timeoutMs", "timeoutMsHint", true),
        valueField("glassAlpha", "glassAlpha", "glassAlphaHint", true),
        valueField("glassBlur", "glassBlur", "glassBlurHint", true),
        valueField("glassSaturate", "glassSaturate", "glassSaturateHint", true),
        valueField("glassHighlight", "glassHighlight", "glassHighlightHint", true),
        valueField("glassRadius", "glassRadius", "glassRadiusHint", true),
      );
    }

    /** 把宿主侧这份 Config 的表单状态接到插件页（字段名与 lib/index.js 的 schema 一致）。 */
    function mountConfigCard(ctx) {
      const forms = ctx.configForms;
      if (forms === undefined || forms === null) return;
      const t = ctx.locale.bind(CFG_NS);
      ctx.effect(() => ctx.locale.register(CFG_NS, { zh: cfgZh, en: cfgEn }), `${PLUGIN_ID}: config locale`);
      // ⚠️ whileServed 的回调**会被重入多次**（服务集合、语言、HMR 变化时都会再调一次），
      // 每次重入都注册一遍 keyed slot 会撞车，实测控制台报：
      //   keyed slot "plugins.bundle.config" already has an entry for key "<包名>" at priority 0
      // 所以每次重入前先把上一轮的 slot 注册与表单拆掉 —— 幂等。
      let teardown = null;
      const drop = () => {
        const run = teardown;
        teardown = null;
        if (run !== null) run();
      };
      ctx.effect(() => forms.whileServed([NS], (served) => {
        drop();
        if (!served.has(NS)) return;
        let scope = null;
        try {
          scope = forms.get(NS);
        } catch {
          scope = null;
        }
        if (scope === undefined || scope === null) return;
        const ui = uiPrimitives();
        const form = new ui.SettingsFormModel(scope, [
          ui.settingsTextField("sourceUrl"),
          ui.settingsNumberField("pollIntervalMs"),
          ui.settingsNumberField("timeoutMs"),
          ui.settingsNumberField("glassAlpha"),
          ui.settingsNumberField("glassBlur"),
          ui.settingsNumberField("glassSaturate"),
          ui.settingsNumberField("glassHighlight"),
          ui.settingsNumberField("glassRadius"),
          ui.settingsNumberField("glassRefraction"),
        ]);
        const store = form.bind(() => ({
          ...form.shell(),
          sourceUrl: form.field("sourceUrl"),
          pollIntervalMs: form.field("pollIntervalMs"),
          timeoutMs: form.field("timeoutMs"),
          glassAlpha: form.field("glassAlpha"),
          glassBlur: form.field("glassBlur"),
          glassSaturate: form.field("glassSaturate"),
          glassHighlight: form.field("glassHighlight"),
          glassRadius: form.field("glassRadius"),
          glassRefraction: form.field("glassRefraction"),
        }));
        const disposeSlot = ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
          name: "plugins.bundle.config",
          key: PLUGIN_ID,
          locale: CFG_NS,
          label: () => t("title"),
          inject: () => ({ hooks: { statusConfig: store }, ...form.actions() }),
        }, ConfigCard));
        teardown = () => {
          try {
            if (typeof disposeSlot === "function") disposeSlot();
          } catch { /* 拆卸期的错误忽略 */ }
          try {
            form.dispose();
          } catch { /* 同上 */ }
        };
      }), `${PLUGIN_ID}: config page`);
      ctx.effect(() => drop, `${PLUGIN_ID}: config teardown`);
    }

    // ── 插件入口 ───────────────────────────────────────────────────────────
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${PLUGIN_ID}: locale`);
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "deepseek-official-status",
        order: 20,
        locale: NS,
      }, StatusLamp));
      // 配置卡片走运行时 inject：宿主没有 configForms 时只是不出现卡片，
      // 而不是整个客户端半部不激活（静态 inject 是硬门禁）。
      if (typeof ctx.inject === "function") {
        try {
          ctx.inject(["configForms"], (cfgCtx) => {
            try {
              mountConfigCard(cfgCtx);
            } catch (error) {
              cfgCtx.logger?.warn?.(`${PLUGIN_ID}: 配置卡片注册失败：${String(error?.message ?? error)}`);
            }
          });
        } catch (error) {
          ctx.logger?.warn?.(`${PLUGIN_ID}: configForms 注入失败：${String(error?.message ?? error)}`);
        }
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});
