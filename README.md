# dsh-deepseek-official-status

DeepSeek Harness 插件：在会话头部显示 **DeepSeek 官方服务状态**（数据来自
[status.deepseek.com](https://status.deepseek.com/)）。

会话标题右侧是一颗**信号灯** —— 平时只有一个圆点，颜色代表当前状态；鼠标移上去
展开详情面板，移开即恢复成一颗点。

![会话头部的信号灯与展开后的面板](https://raw.githubusercontent.com/Fo-Rimuru/dsh-deepseek-official-status/main/docs/screenshots/panel.png)

## 面板里有什么

- **总体状态**（绿=全部正常 / 蓝=维护中 / 黄=性能下降 / 橙=部分故障 / 红=严重故障 / 灰=未知）
- **最后更新时间**（「更新于 X 分钟前」）
- **各组件状态** + 各组件的 **uptime%**
- **进行中的事件**（无则显示「当前无进行中的事件或维护」）
- **最近事件**（已解决的故障 / 维护）
- 链接：打开官方状态页

## 安装

```powershell
# 从 npm（发布后）
dsh plugin --profile desktop add dsh-deepseek-official-status

# 本地开发目录
dsh plugin --profile desktop add 'D:\path\to\dsh-deepseek-official-status'
```

装完**必须重启 DSH**（宿主侧和客户端侧都要重新加载）。插件生效的条件是它出现在
profile `package.json` 的 `dsh.profile.bundles` 数组里，`dsh plugin add` 会自动追加。

## 配置

在**侧栏「插件」→ dsh-deepseek-official-status[官方服务状态]** 的卡片里改：表单出现在插件
描述与「包含的组件」之间。所有字段都标了 `.volatile()`，**改完保存立即生效、不需要重启**
（宿主每轮都重读配置，改动最迟在下一轮轮询时体现）。

| 键 | 类型 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `sourceUrl` | string | `https://status.deepseek.com/` | — | 状态页地址 |
| `pollIntervalMs` | number | `60000` | 15000–3600000 | 宿主轮询间隔（毫秒） |
| `timeoutMs` | number | `15000` | 5000–120000 | 单次抓取超时（毫秒） |
| `glassAlpha` | number | `58` | 5–100 | 面板玻璃底色不透明度（%），越小越透 |
| `glassBlur` | number | `24` | 0–48 | 面板背后内容的模糊半径（px），玻璃感的关键 |
| `glassSaturate` | number | `190` | 100–260 | 透过面板看到的颜色饱和度（%） |
| `glassHighlight` | number | `30` | 0–100 | 玻璃边缘亮线与顶部高光强度（%） |
| `glassRadius` | number | `18` | 4–28 | 面板圆角（px） |

后五个只影响面板观感，改坏了随时可以逐个「恢复默认」。把 `glassBlur` 调成 0 就能直观
看到它的作用 —— 面板会退化成一块几乎透明的玻璃片，背后正文清晰穿透：
[`docs/screenshots/param-blur-off.png`](docs/screenshots/param-blur-off.png)。

> **为什么不在「设置」里**：DSH 的设计是「**自带配置的插件把配置渲染在插件页而不是设置里**」
> —— 插件必须自己注册 `plugins.bundle.config`（以包名为键）这个 slot 并提供表单 UI，
> 设置里只保留只读的插件列表。本插件的表单复用官方 `dsh-client-ui-primitives` 的
> `SettingsFormModel` / `SettingsForm` / `SettingsValueField`，所以草稿、校验、覆盖标记、
> 恢复默认这些行为与官方配置页一致。

也可以在 profile 的 `cordis.patch.yml` 里给这行加 `config:` 段作为首次运行的默认值
（命名空间 `deepseek-official-status`，即 `cordis.patch.yml` 里的 row id）。

## 数据来源（为什么这么实现）

status.deepseek.com 是 Flashcat/FlashDuty 托管的 Next.js 状态页，**没有公开 JSON API**：

- `/api/status`、`/api/summary.json`、`/api/components` 等一律 404；
  下载整站 19 个客户端 chunk 搜 `/api/` 路径 = 0 命中，说明数据 100% 来自 SSR/RSC。
- `/index.json`、`/summary.json`、`/status.json`、`/rss.xml` 会返回 **HTTP 200 但
  `content-type: text/html`**（Next.js catch-all 的 23KB SSR 页面）—— 按 JSON 解析必错。
- 真正的接口是 `/feed.rss`（那是 RSS 事件流）和 **RSC 负载**。

所以插件走三条路径，主源优先：

1. **主源 RSC**：`GET /?_rsc=<随机值>` + 请求头 `RSC: 1` → `text/x-component`，
   body 本身就是裸 flight 文本，字段**未转义**，直接按字段名提取。
2. **回退首页 HTML**：`self.__next_f.push([1,"..."])` 片段，需先解一层 JS 字符串
   字面量转义，之后与路径 1 是同一种文本。
3. **兜底 `/feed.rss`**：前两条都失败时（状态页改版、换了系统、被拦……），用 Flashcat
   的 RSS 至少保住**事件列表**。RSS 没有组件列表也没有 uptime，所以这一路的快照是
   `overall: "unknown"`（灰）加 `degraded: true`，面板会明说「组件状态数据源不可用」，
   事件标题则变成可点链接（RSS 自带 `<link>`）。

三条路径都失败时**保留上一次成功的快照**，只更新错误信息；界面继续显示旧数据 +
「更新于 X 分钟前」，并在面板里给出「最近一次刷新失败」提示。**任何情况下都不会
把未知显示成「正常」** —— 没有数据时是灰灯 +「状态未知」，降级时是灰灯 + 降级说明。

RSS 兜底时的真实样子（用「只有 `/feed.rss` 通」的本地桩实测：RSC 与 HTML 都返回 500）：

![RSS 兜底时的降级面板](https://raw.githubusercontent.com/Fo-Rimuru/dsh-deepseek-official-status/main/docs/screenshots/degraded.png)

状态语义（实测）：`page.components[]` **不带** `status` 字段，组件状态完全由
`active_changes[]`（服务端的全量进行中事件列表）推导 —— `"active_changes":[]`
意味着「当前无事件 → 全部正常」，而该字段缺失才等于未知。`component_uptimes[]`
只有一个 `uptime` 值（不存在 24h/7d/30d 多档）。

RSS 侧要点（实测）：`guid` 形如 `urn:flashduty:change:<id>`，与状态页
`/incidents/<id>` 以及 flight 里的 `change_id` 是**同一个 id 空间**；`description`
是 XML 实体转义后的 HTML —— 先解一层实体，再从 `<strong>Status:</strong>` /
`<strong>Affected components:</strong>` 提状态与受影响组件名，正文用**白名单**
剥标签（否则正文里被转义过的 `<` 会被当成标签一起删掉）。

## 开发

```powershell
# 解析层单元测试（离线，用 test/fixtures 里的真实响应）
node --test test/parser.test.mjs test/rss.test.mjs

# 宿主冒烟测试（真连 status.deepseek.com，验证路由返回 JSON）
node test/host.smoke.mjs

# RSS 兜底路径冒烟测试（桩 fetch：构造「只有 feed.rss 通」）
node test/rss-fallback.smoke.mjs
```

`node` 不在 PATH 里时，可以用 DSH 桌面版自带的运行时：

```powershell
& "$env:DSH_DESKTOP_NODE_EXECUTABLE" test/parser.test.mjs
```

**本地 `link:` 安装的注意事项**：插件 import 了 `@deepseek-ai/schemastery`，而
`link:` 安装时该包只存在于 profile 的 `node_modules` 里，工作区目录向上找不到它。
开发目录需要一个 `node_modules` 目录能解析到 `@deepseek-ai/*`（本机做法是指向
profile `node_modules` 的 junction）。从 npm 安装的插件不受影响。

## 许可

MIT
