/**
 * DeepSeek 官方服务状态 — flight 负载解析器。
 *
 * status.deepseek.com 是 Flashcat/FlashDuty 托管的 Next.js（App Router）状态页，
 * 没有公开 JSON API（`/api/*` 全 404；`/index.json`、`/summary.json`、`/status.json`
 * 是返回 HTML 的 catch-all，按 JSON 解析必错）。状态数据内嵌在 flight 负载里，
 * 可由两个来源获得：
 *
 *   1. RSC   — `GET /?_rsc=<随机值>` 带请求头 `RSC: 1` → `text/x-component`，
 *              body 本身就是裸 flight 文本（字段未转义）
 *   2. HTML  — 首页里 `self.__next_f.push([1,"..."])` 的片段，
 *              需要解一层 JS 字符串字面量转义
 *
 * 两者归一化后是同一种文本，共用下面的字段提取器。
 *
 * 关于状态的来源（实测结论，勿凭直觉改）：
 *   - `page.components[]` **不带 status 字段**，只有 component_id / name /
 *     description / section_id / available_since_seconds / order_id。
 *   - 组件状态完全由 `active_changes[]`（服务端的全量「进行中事件」列表）推导：
 *       * `"active_changes":[]`  —— 明确「当前无事件」→ 所有组件 operational
 *       * 有事件               —— 受影响组件取其 affected status，其余仍 operational
 *       * 字段缺失 / 负载截断   —— 一切未知 → unknown（绝不假设为正常）
 *
 * 本模块对任何缺失字段都返回 null，绝不臆测出「正常」；结构不符时抛错，
 * 由调用方保留上一次成功的快照。
 */

/** 状态优先级：数值越大越严重。用于把事件影响叠加到组件与总体状态上。 */
export const STATUS_RANK = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  full_outage: 4,
};

/** 已达终态的事件状态（用于「最近事件」列表）。 */
export const TERMINAL_STATUS = new Set(["resolved", "completed", "cancelled"]);

/** 已知的组件/总体状态集合。 */
export const STATUSES = ["operational", "maintenance", "degraded", "partial_outage", "full_outage"];

/** 解一层 JS 字符串字面量转义（`\"` `\\` `\n` `\uXXXX`）。 */
export function unescapeJsString(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, c) => {
    if (c[0] === "u") return String.fromCharCode(parseInt(c.slice(1), 16));
    switch (c) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      default: return c;
    }
  });
}

/**
 * 从首页 HTML 提取并解码全部 flight 片段，拼成裸 flight 文本。
 * @param {string} html 首页 HTML
 * @returns {string} 裸 flight 文本（无片段时为空串）
 */
export function flightTextFromHtml(html) {
  if (typeof html !== "string" || html === "") return "";
  const parts = [];
  // 片段形如：self.__next_f.push([1,"1e:[...]\n"])</script>
  const re = /self\.__next_f\.push\(\[1,(.*?)\]\)<\/script>/gs;
  for (const match of html.matchAll(re)) {
    let raw = match[1].trim();
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    parts.push(unescapeJsString(raw));
  }
  return parts.join("\n");
}

/**
 * 从 openIdx 处的 `{` / `[` 起，找到配对闭合符，返回原始切片。
 * 正确处理字符串内的转义，避免把字符串里的括号算进深度。
 */
function matchDelimited(text, openIdx) {
  const open = text[openIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
}

/** 取出 `key` 之后紧跟的 JSON 值并解析；key 不存在或截断时返回 null。 */
function extractValue(text, key) {
  const idx = text.indexOf(key);
  if (idx < 0) return null;
  let p = idx + key.length;
  while (p < text.length && /\s/.test(text[p])) p++;
  const ch = text[p];
  if (ch === "{" || ch === "[") {
    const region = matchDelimited(text, p);
    if (region === null) return null;
    try { return JSON.parse(region); } catch { return null; }
  }
  if (ch === '"') {
    const out = [];
    let escaped = false;
    for (let i = p + 1; i < text.length; i++) {
      const c = text[i];
      if (escaped) { out.push("\\" + c); escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') {
        try { return JSON.parse('"' + out.join("") + '"'); } catch { return out.join(""); }
      }
      out.push(c);
    }
    return null;
  }
  const scalar = /^(-?\d+(?:\.\d+)?|true|false|null)/.exec(text.slice(p));
  if (scalar === null) return null;
  if (scalar[1] === "null") return null;
  if (scalar[1] === "true") return true;
  if (scalar[1] === "false") return false;
  return Number(scalar[1]);
}

/** 首个有限数字，否则 null。 */
function numOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/** 单个组件归一化。page.components 里没有 status 字段，由 active_changes 推导。 */
function normalizeComponent(raw) {
  return {
    id: String(raw?.component_id ?? ""),
    name: String(raw?.name ?? raw?.component_id ?? ""),
    description: String(raw?.description ?? ""),
    sectionId: String(raw?.section_id ?? ""),
    orderId: numOrNull(raw?.order_id),
    availableSince: numOrNull(raw?.available_since_seconds),
    status: "unknown",
  };
}

/** 单个事件（incident / maintenance）归一化。 */
function normalizeChange(raw) {
  const updates = Array.isArray(raw?.updates) ? raw.updates : [];
  return {
    id: String(raw?.change_id ?? ""),
    type: raw?.type === "maintenance" ? "maintenance" : "incident",
    title: String(raw?.title ?? ""),
    description: String(raw?.description ?? ""),
    status: String(raw?.status ?? "unknown"),
    startedAt: numOrNull(raw?.start_at_seconds),
    closedAt: numOrNull(raw?.close_at_seconds),
    affected: Array.isArray(raw?.affected_components)
      ? raw.affected_components.map((a) => ({
          id: String(a?.component_id ?? ""),
          name: String(a?.name ?? ""),
          status: String(a?.status ?? "unknown"),
        }))
      : [],
    updates: updates.map((u) => ({
      status: String(u?.status ?? "unknown"),
      description: String(u?.description ?? ""),
      // 实测字段是 at_seconds；created_at_seconds 只是兼容旧结构的兜底。
      at: numOrNull(u?.at_seconds) ?? numOrNull(u?.created_at_seconds),
    })),
  };
}

/**
 * 解析裸 flight 文本为快照。
 * @param {string} text 裸 flight 文本
 * @returns {object} 快照；`page` 缺失时抛错（说明来源结构已变，调用方应保留上次快照）
 */
export function parseFlightText(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("empty flight text");
  }
  const page = extractValue(text, '"page":');
  if (page === null || typeof page !== "object") {
    throw new Error("page object not found in flight payload");
  }

  // active_changes 缺失(null) 与「明确为空数组」含义完全不同：
  // 只有后者才等于「当前无事件 → 全部正常」。
  const activeChanges = extractValue(text, '"active_changes":');
  const activeKnown = Array.isArray(activeChanges);

  const changesRaw = extractValue(text, '"changes":');
  const uptimesRaw = extractValue(text, '"component_uptimes":');
  const updatedAt = extractValue(text, '"initialDataUpdatedAt":');

  const components = (Array.isArray(page.components) ? page.components : []).map(normalizeComponent);
  const byId = new Map(components.map((c) => [c.id, c]));

  const active = activeKnown ? activeChanges.map(normalizeChange) : [];

  if (activeKnown) {
    // active_changes 是全量进行中事件列表 → 未出现的组件就是正常。
    for (const component of components) component.status = "operational";
    for (const change of active) {
      const ongoing = !TERMINAL_STATUS.has(change.status);
      for (const affected of change.affected) {
        const component = byId.get(affected.id);
        if (component === undefined) continue;
        let next = STATUSES.includes(affected.status) ? affected.status : "degraded";
        // 进行中的维护事件按维护色显示，除非事件自身报了更严重的影响。
        if (change.type === "maintenance" && ongoing && STATUS_RANK[next] < STATUS_RANK.maintenance) {
          next = "maintenance";
        }
        if (STATUS_RANK[next] > STATUS_RANK[component.status]) component.status = next;
      }
    }
  }

  // 总体状态 = 组件里的最高严重度。事件未指明影响组件时至少降级，
  // 宁可是 degraded 也不显示成「一切正常」。
  let overall = "unknown";
  if (activeKnown) {
    overall = components.length === 0 ? "unknown" : "operational";
    for (const component of components) {
      if (STATUS_RANK[component.status] > STATUS_RANK[overall]) overall = component.status;
    }
    for (const change of active) {
      if (change.affected.length > 0) continue;
      const floor = change.type === "maintenance" ? "maintenance" : "degraded";
      if (STATUS_RANK[floor] > STATUS_RANK[overall]) overall = floor;
    }
  }

  const allChanges = Array.isArray(changesRaw) ? changesRaw.map(normalizeChange) : [];
  const recentResolved = allChanges
    .filter((c) => TERMINAL_STATUS.has(c.status))
    .sort((a, b) => (b.closedAt ?? b.startedAt ?? 0) - (a.closedAt ?? a.startedAt ?? 0))
    .slice(0, 5);

  const uptime = (Array.isArray(uptimesRaw) ? uptimesRaw : []).map((u) => ({
    id: String(u?.component_id ?? ""),
    sectionId: String(u?.section_id ?? ""),
    uptime: numOrNull(u?.uptime),
    availableSince: numOrNull(u?.available_since_seconds),
  }));

  return {
    overall,
    activeKnown,
    page: {
      id: page.page_id ?? null,
      name: String(page.name ?? ""),
      urlName: String(page.url_name ?? ""),
    },
    components,
    active,
    recentResolved,
    uptime,
    updatedAt: numOrNull(updatedAt),
  };
}

/** 首页 HTML → 快照。 */
export function parseStatusHtml(html) {
  const text = flightTextFromHtml(html);
  if (text === "") throw new Error("no flight payload found in HTML");
  return parseFlightText(text);
}

/** RSC body（text/x-component）→ 快照。 */
export function parseStatusRsc(body) {
  return parseFlightText(body);
}
