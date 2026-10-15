/**
 * lib/rss.js 的单元测试（`node --test test/`）。
 *
 * 主 fixture `fixtures/feed.rss` 是从 https://status.deepseek.com/feed.rss 抓的真实响应
 * （重抓方法见 test/README.md）。真实 feed 的内容会随时间变化，所以对它的断言保持宽松
 * （条数下限、字段形状、id 格式），而**分支行为**（进行中 / 已终结）用内联的小 feed 精确断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventsFromRss, parseRssFeed, stripTags, unescapeXml } from "../lib/rss.js";

const here = dirname(fileURLToPath(import.meta.url));
const feedXml = readFileSync(join(here, "fixtures", "feed.rss"), "utf8");

const item = ({ title, link, status, affected, pubDate, guid }) => `<item>
      <title>${title}</title>
      <link>${link}</link>
      <description>&lt;p&gt;&lt;strong&gt;Status:&lt;/strong&gt; ${status}&lt;/p&gt;&lt;p&gt;正文内容&lt;/p&gt;&lt;p&gt;&lt;strong&gt;Affected components:&lt;/strong&gt; ${affected}&lt;/p&gt;</description>
      <guid>${guid}</guid>
      <pubDate>${pubDate}</pubDate>
    </item>`;

const wrapFeed = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>DeepSeek</title>
    <link>https://status.deepseek.com</link>
    <pubDate>Thu, 15 Oct 2026 13:04:04 +0800</pubDate>
    <lastBuildDate>Thu, 15 Oct 2026 13:04:04 +0800</lastBuildDate>
    ${items.join("\n")}
  </channel></rss>`;

// ── XML 工具 ───────────────────────────────────────────────────────────────
test("unescapeXml 解命名实体与字符引用", () => {
  assert.equal(unescapeXml("a &lt; b &amp; c &gt; d"), "a < b & c > d");
  assert.equal(unescapeXml("&quot;q&quot; &apos;a&apos;"), '"q" \'a\'');
  assert.equal(unescapeXml("x&#xA;y"), "x\ny");
  assert.equal(unescapeXml("&#x4e2d;&#25991;"), "中文");
  assert.equal(unescapeXml("&unknown;"), "&unknown;");
  assert.equal(unescapeXml(""), "");
});

test("stripTags 把段落与换行还原成文本", () => {
  assert.equal(stripTags("<p>一</p><p>二</p>"), "一\n二");
  assert.equal(stripTags("a<br>b<br/>c"), "a\nb\nc");
  assert.equal(stripTags("  <b>粗</b>  体  "), "粗 体");
  assert.equal(stripTags("&lt;未转义&gt;"), "<未转义>");
});

// ── 真实 feed ──────────────────────────────────────────────────────────────
test("真实 feed 能解析出事件（条数下限 + 字段形状）", () => {
  const feed = parseRssFeed(feedXml);
  assert.ok(feed.events.length >= 20, `事件太少：${feed.events.length}`);
  assert.ok(Number.isFinite(feed.updatedAt) && feed.updatedAt > 1600000000000, "缺 channel 时间（毫秒）");
  for (const event of feed.events) {
    assert.match(event.id, /^\d+$/, `事件 id 应为数字串：${event.id}`);
    assert.ok(event.title.length > 0, "事件缺 title");
    assert.ok(event.link.startsWith("https://status.deepseek.com/"), `link 异常：${event.link}`);
    assert.ok(event.status.length > 0, "事件缺 status");
    assert.ok(Array.isArray(event.affected), "affected 应为数组");
  }
});

test("真实 feed 的 description 已剥离 Status / Affected components 两段", () => {
  const feed = parseRssFeed(feedXml);
  for (const event of feed.events) {
    assert.ok(!/Status:/i.test(event.description), `正文残留 Status: ${event.description.slice(0, 80)}`);
    assert.ok(!/Affected components:/i.test(event.description), "正文残留 Affected components:");
  }
});

test("真实 feed 至少有一条已解决事件，且终态事件带 closedAt 不带 startedAt", () => {
  const feed = parseRssFeed(feedXml);
  const resolved = feed.events.filter((e) => e.status === "resolved");
  assert.ok(resolved.length > 0, "没有任何 resolved 事件");
  for (const event of resolved) {
    assert.ok(Number.isFinite(event.closedAt), "resolved 事件应有 closedAt（秒）");
    assert.equal(event.startedAt, null);
    assert.ok(event.closedAt > 1600000000, "closedAt 应是秒级时间戳");
  }
});

test("真实 feed 的受影响组件名被拆成列表（非空、无逗号残留）", () => {
  const feed = parseRssFeed(feedXml);
  const withAffected = feed.events.filter((e) => e.affected.length > 0);
  assert.ok(withAffected.length > 0, "没有任何带受影响组件的事件");
  for (const event of withAffected) {
    for (const affected of event.affected) {
      assert.ok(affected.name.length > 0);
      assert.ok(!affected.name.includes(","), `组件名残留逗号：${affected.name}`);
    }
  }
});

test("eventsFromRss 把真实 feed 的已解决事件归入 recentResolved（最多 5 条，按时间倒序）", () => {
  const feed = parseRssFeed(feedXml);
  const { active, recentResolved } = eventsFromRss(feed.events);
  assert.ok(recentResolved.length > 0 && recentResolved.length <= 5);
  assert.equal(active.length, 0, "当前真实 feed 全是已终结事件");
  const times = recentResolved.map((e) => e.closedAt);
  const sorted = [...times].sort((a, b) => b - a);
  assert.deepEqual(times, sorted, "应按时间倒序");
  for (const event of recentResolved) assert.ok(!("at" in event), "内部 at 字段不应外泄");
});

// ── 分支行为（内联 feed） ──────────────────────────────────────────────────
test("进行中的事件归入 active 且带 startedAt", () => {
  const xml = wrapFeed([
    item({
      title: "性能下降", link: "https://status.deepseek.com/incidents/111", status: "investigating",
      affected: "对话服务(Chatservice), 搜索服务(Search Service)",
      pubDate: "Wed, 15 Oct 2026 10:00:00 +0800", guid: "urn:flashduty:change:111",
    }),
    item({
      title: "老事件", link: "https://status.deepseek.com/incidents/222", status: "resolved",
      affected: "对话服务(Chatservice)", pubDate: "Tue, 14 Oct 2026 10:00:00 +0800",
      guid: "urn:flashduty:change:222",
    }),
  ]);
  const feed = parseRssFeed(xml);
  assert.equal(feed.events.length, 2);
  const { active, recentResolved } = eventsFromRss(feed.events);
  assert.equal(active.length, 1);
  assert.equal(active[0].status, "investigating");
  assert.equal(active[0].id, "111");
  assert.ok(Number.isFinite(active[0].startedAt), "进行中事件应有 startedAt");
  assert.equal(active[0].closedAt, null);
  assert.equal(active[0].affected.length, 2);
  assert.equal(recentResolved.length, 1);
  assert.equal(recentResolved[0].id, "222");
});

test("id 优先取 guid，guid 缺失时退回 link；pubDate 解不出时时间为 null", () => {
  const xml = wrapFeed([
    item({
      title: "无 guid", link: "https://status.deepseek.com/incidents/333", status: "resolved",
      affected: "", pubDate: "not a date", guid: "",
    }),
  ]);
  const feed = parseRssFeed(xml);
  assert.equal(feed.events[0].id, "333");
  assert.equal(feed.events[0].closedAt, null);
  assert.equal(feed.events[0].affected.length, 0);
});

test("空 feed / 无 item / 无有效条目都抛错（调用方据此保留旧快照）", () => {
  assert.throws(() => parseRssFeed(""), /empty feed/);
  assert.throws(() => parseRssFeed("   "), /empty feed/);
  assert.throws(() => parseRssFeed("<rss><channel></channel></rss>"), /no <item>/);
  assert.throws(
    () => parseRssFeed(wrapFeed([item({ title: "", link: "", status: "resolved", affected: "", pubDate: "x", guid: "" })])),
    /no events/,
  );
  assert.throws(() => parseRssFeed(null), /empty feed/);
});
