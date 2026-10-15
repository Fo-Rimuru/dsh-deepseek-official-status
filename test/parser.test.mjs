/**
 * parser 离线回归测试。
 *
 * fixture 是真实的 status.deepseek.com 响应（RSC body 与首页 HTML 各一份，两次
 * 请求相隔若干分钟），两条路径必须解析出同一份业务数据。运行方式见 test/README.md。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseStatusHtml,
  parseStatusRsc,
  flightTextFromHtml,
  parseFlightText,
  STATUSES,
} from "../lib/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "fixtures", name), "utf8");

let checks = 0;
let failures = 0;
function check(name, condition, extra) {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra === undefined ? "" : ` :: ${extra}`}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}
/** 断言 fn 抛错（用于「绝不返回假的正常」这类要求）。 */
function throws(name, fn) {
  try {
    fn();
    check(name, false, "expected a throw, got a value");
  } catch {
    check(name, true);
  }
}

section("flight 文本提取");
const html = fixture("home.html");
const rscText = fixture("rsc.txt");
const htmlText = flightTextFromHtml(html);
check("HTML 里提取到 flight 片段", htmlText.length > 1000, `len=${htmlText.length}`);
check("HTML flight 文本含 page 对象", htmlText.includes('"page":'));
check("HTML flight 文本已解除转义", !htmlText.includes('\\"page\\":'));
check("RSC body 本身就是裸 flight 文本", rscText.includes('"page":'));

section("RSC 路径");
const rsc = parseStatusRsc(rscText);
check("overall 是已知状态", STATUSES.includes(rsc.overall), rsc.overall);
check("解析出组件", rsc.components.length > 0, `${rsc.components.length} 个`);
check("组件都有名字", rsc.components.every((c) => c.name !== ""));
check("组件状态都是已知状态", rsc.components.every((c) => STATUSES.includes(c.status)), JSON.stringify(rsc.components.map((c) => c.status)));
check("解析出 uptime", rsc.uptime.length > 0, `${rsc.uptime.length} 条`);
check("uptime 值在 0..100", rsc.uptime.every((u) => u.uptime !== null && u.uptime >= 0 && u.uptime <= 100));
check("updatedAt 是合理时间戳", Number.isFinite(rsc.updatedAt) && rsc.updatedAt > 1.6e12, String(rsc.updatedAt));
check("active_changes 明确为空数组", rsc.activeKnown === true);
check("无进行中事件", rsc.active.length === 0);

section("状态推导：无事件 = 全部正常");
check(
  "所有组件为 operational（组件表自身不带 status）",
  rsc.components.every((c) => c.status === "operational"),
  JSON.stringify(rsc.components.map((c) => [c.name, c.status])),
);
check("overall 为 operational", rsc.overall === "operational", rsc.overall);

section("最近事件");
check("解析出最近已解决事件", rsc.recentResolved.length > 0, `${rsc.recentResolved.length} 条`);
check("事件都有标题", rsc.recentResolved.every((c) => c.title !== ""));
check("事件都有起始时间", rsc.recentResolved.every((c) => Number.isFinite(c.startedAt)));
check("已解决事件都有结束时间", rsc.recentResolved.every((c) => Number.isFinite(c.closedAt)));
check("事件类型合法", rsc.recentResolved.every((c) => c.type === "incident" || c.type === "maintenance"));
check("事件带受影响组件", rsc.recentResolved.some((c) => c.affected.length > 0));
check("事件带状态更新记录", rsc.recentResolved.some((c) => c.updates.length > 0));
check(
  "状态更新的时间已解析（at_seconds）",
  rsc.recentResolved.every((c) => c.updates.every((u) => Number.isFinite(u.at))),
  JSON.stringify(rsc.recentResolved.find((c) => c.updates.some((u) => !Number.isFinite(u.at)))?.updates),
);
check("事件有描述", rsc.recentResolved.some((c) => c.description !== ""));
check("按结束时间倒序", rsc.recentResolved.every((c, i, arr) => i === 0 || (arr[i - 1].closedAt ?? 0) >= (c.closedAt ?? 0)));

section("HTML 路径与 RSC 路径一致");
const fromHtml = parseStatusHtml(html);
check("overall 一致", fromHtml.overall === rsc.overall, `${fromHtml.overall} vs ${rsc.overall}`);
check("组件数量一致", fromHtml.components.length === rsc.components.length, `${fromHtml.components.length} vs ${rsc.components.length}`);
check(
  "组件名与顺序一致",
  JSON.stringify(fromHtml.components.map((c) => c.name)) === JSON.stringify(rsc.components.map((c) => c.name)),
);
check("组件状态一致", JSON.stringify(fromHtml.components.map((c) => c.status)) === JSON.stringify(rsc.components.map((c) => c.status)));
check("uptime 一致", JSON.stringify(fromHtml.uptime) === JSON.stringify(rsc.uptime));
check(
  "HTML 路径 updatedAt 合法（两次请求时刻不同，允许不等）",
  fromHtml.updatedAt === null || fromHtml.updatedAt > 1.6e12,
  String(fromHtml.updatedAt),
);

section("容错：绝不臆造「正常」");
throws("空字符串抛错", () => parseFlightText(""));
throws("无 page 对象抛错", () => parseFlightText("1:null\n2:[1,2,3]"));
throws("page 被截断抛错", () => parseFlightText(rscText.slice(0, rscText.indexOf('"page":') + 200)));
const noActive = parseFlightText(rscText.replace('"active_changes":[]', '"active_changes":null'));
check("active_changes 缺失 → overall 为 unknown", noActive.overall === "unknown", noActive.overall);
check("active_changes 缺失 → 组件状态为 unknown", noActive.components.every((c) => c.status === "unknown"));
check("active_changes 缺失 → activeKnown 为 false", noActive.activeKnown === false);
throws("HTML 无 flight 片段抛错", () => parseStatusHtml("<html><body>nope</body></html>"));

section("摘要输出（人工核对用）");
console.log(`  overall=${rsc.overall}  components=${rsc.components.length}  uptime=${rsc.uptime.length}  recent=${rsc.recentResolved.length}`);
console.log(`  updatedAt(rsc)=${rsc.updatedAt}  updatedAt(html)=${fromHtml.updatedAt}`);
console.log(`  updatedAt(rsc)=${new Date(rsc.updatedAt).toISOString()}`);
for (const c of rsc.components) {
  const u = rsc.uptime.find((x) => x.id === c.id);
  console.log(`    [${c.status}] ${c.name}${u ? `  uptime=${u.uptime}%` : ""}`);
}
for (const c of rsc.recentResolved.slice(0, 2)) {
  console.log(`    最近: [${c.status}] ${c.title}  ${new Date(c.startedAt * 1000).toISOString()} → ${new Date(c.closedAt * 1000).toISOString()}`);
  console.log(`           ${c.description.replace(/\n/g, " ").slice(0, 90)}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
