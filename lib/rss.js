/**
 * DeepSeek 官方服务状态 — RSS 兜底源解析。
 *
 * `status.deepseek.com/feed.rss` 是 Flashcat(FlashDuty) 提供的**真 RSS**
 * （`application/rss+xml`，实测 22 KB / 36 条），每个事件一条 `<item>`：
 *
 *   <item>
 *     <title>DeepSeek 网页/API 部分中断（DeepSeek Web/API Partially Unavailable）</title>
 *     <link>https://status.deepseek.com/incidents/7116348214287</link>
 *     <description>&lt;p&gt;&lt;strong&gt;Status:&lt;/strong&gt; resolved&lt;/p&gt;…&lt;/description&gt;
 *     <guid>urn:flashduty:change:7116348214287</guid>
 *     <pubDate>Thu, 15 Oct 2026 08:11:35 +0800</pubDate>
 *   </item>
 *
 * 它只能提供**事件**（标题 / 链接 / 状态 / 时间 / 受影响组件名），
 * **没有组件列表，也没有 uptime** —— 所以它只是 flight 负载（RSC / HTML）
 * 双双失败时的兜底：组件状态仍然标 unknown（灰），绝不因为拿到事件就宣称「正常」。
 *
 * 两个实测要点：
 *   - `guid` 形如 `urn:flashduty:change:<id>`，与状态页 `/incidents/<id>`
 *     以及 flight 里的 `change_id` 是**同一个 id 空间**。
 *   - `description` 是 XML 实体转义后的 HTML 片段，解开一层实体后才能按
 *     `<strong>Status:</strong>` / `<strong>Affected components:</strong>` 提取。
 */
import { TERMINAL_STATUS } from "./parser.js";

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

/** 解 XML 实体：命名实体 + 十进制/十六进制字符引用（`&#xA;` 这种换行也常见）。 */
export function unescapeXml(value) {
  return String(value ?? "").replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = XML_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

/**
 * 去标签取纯文本：块级标签与 `<br>` 还原成换行，行内标签丢弃，压缩多余空白。
 *
 * 用**白名单**而不是"删掉一切尖括号内容"是有原因的：description 里的 HTML 本身是
 * XML 实体转义的（`&lt;p&gt;`），必须先解实体才能看到标签 —— 于是「正文里被转义过的
 * `<`」与「真标签」在解码后长得一模一样。白名单能保住前者不误删。
 */
const BLOCK_TAG = /<\/?(?:p|div|h[1-6]|ul|ol|li|blockquote|table|thead|tbody|tr|td|th)(?:\s[^>]*)?>/gi;
const INLINE_TAG = /<\/?(?:strong|b|em|i|u|s|a|code|pre|span|hr|img)(?:\s[^>]*)?>/gi;

export function stripTags(value) {
  return unescapeXml(value)
    .replace(BLOCK_TAG, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(INLINE_TAG, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 取出某个标签的原始内容（支持 `<![CDATA[…]]>`）。 */
function tagText(block, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (match === null) return "";
  const raw = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  return cdata === null ? raw : cdata[1];
}

/** RFC822（`Thu, 15 Oct 2026 08:11:35 +0800`）→ 毫秒；解不出返回 null。 */
function parseDate(value) {
  const ms = Date.parse(String(value ?? "").trim());
  return Number.isFinite(ms) ? ms : null;
}

/** 从 guid / link 里取 change_id；取不到返回 null。 */
function changeIdOf(value) {
  const match = /(?:change:|incidents\/|maintenances\/)(\d+)/i.exec(String(value ?? ""));
  return match === null ? null : match[1];
}

/** 事件状态归一：小写去空白；RSS 用的词与 flight 一致（如 `resolved`）。 */
function normalizeStatus(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  return text === "" ? "unknown" : text;
}

/** 去掉 Status / Affected components 两段后的正文。 */
function bodyOf(html) {
  return stripTags(
    html
      .replace(/<p>\s*<strong>\s*Status:?\s*<\/strong>[\s\S]*?<\/p>/i, "")
      .replace(/<p>\s*<strong>\s*Affected components:?\s*<\/strong>[\s\S]*?<\/p>/i, ""),
  );
}

/** 单条 `<item>` → 事件（字段语义与 parser.js 的 normalizeChange 对齐）。 */
function normalizeItem(block) {
  const guid = unescapeXml(tagText(block, "guid")).trim();
  const link = unescapeXml(tagText(block, "link")).trim();
  const html = unescapeXml(tagText(block, "description"));
  const status = normalizeStatus(/<strong>\s*Status:?\s*<\/strong>\s*([^<\n]+)/i.exec(html)?.[1] ?? "");
  const affectedRaw = /<strong>\s*Affected components:?\s*<\/strong>\s*([^<\n]*)/i.exec(html)?.[1] ?? "";
  const at = parseDate(unescapeXml(tagText(block, "pubDate")));
  const done = TERMINAL_STATUS.has(status);
  const seconds = at === null ? null : Math.round(at / 1000);

  return {
    id: changeIdOf(guid) ?? changeIdOf(link) ?? "",
    title: unescapeXml(tagText(block, "title")).trim(),
    link,
    status,
    description: bodyOf(html),
    affected: affectedRaw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((name) => ({ id: "", name, status: "unknown" })),
    // pubDate 对已终结的事件是「最后更新/解决时间」，对进行中的是「最近一次更新」。
    startedAt: done ? null : seconds,
    closedAt: done ? seconds : null,
    /** 排序用的绝对时间（毫秒），不对外暴露语义。 */
    at,
  };
}

/**
 * 解析 RSS。
 * @param {string} xml feed 原文
 * @returns {{ updatedAt: number|null, events: object[] }} `updatedAt` 为毫秒
 * @throws feed 为空或没有 `<item>` 时抛错（调用方据此保留上一次快照）
 */
export function parseRssFeed(xml) {
  if (typeof xml !== "string" || xml.trim() === "") throw new Error("empty feed");
  const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)];
  if (items.length === 0) throw new Error("feed has no <item>");
  const events = items.map(([, block]) => normalizeItem(block)).filter((e) => e.title !== "" || e.id !== "");
  if (events.length === 0) throw new Error("feed items produced no events");
  // channel 级时间：lastBuildDate 优先，退到 channel 的 pubDate（它在 item 之前）。
  const stamp = unescapeXml(tagText(xml, "lastBuildDate")) || unescapeXml(tagText(xml, "pubDate"));
  return { updatedAt: parseDate(stamp), events };
}

/**
 * 把 RSS 事件按「进行中 / 最近已终结」分组（最近 5 条，与 flight 侧一致）。
 * 注意：RSS 没有组件状态，这里不参与任何 overall 推导。
 */
export function eventsFromRss(events) {
  const list = Array.isArray(events) ? events : [];
  const byTime = (a, b) => (b.at ?? 0) - (a.at ?? 0);
  // `at` 只是内部排序用的毫秒时间，不进 API。
  const strip = ({ at, ...rest }) => rest;
  return {
    active: list.filter((e) => !TERMINAL_STATUS.has(e.status)).sort(byTime).map(strip),
    recentResolved: list.filter((e) => TERMINAL_STATUS.has(e.status)).sort(byTime).slice(0, 5).map(strip),
  };
}
