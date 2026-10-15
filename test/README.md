# 测试

本机 node 不在 PATH 里，用 DSH 自带的 node：

```powershell
$node = 'node'   # 若 node 不在 PATH 里，换成 DSH 自带 node 的完整路径

# 1. 解析层单元测试（离线，读 fixtures，秒级）
& $node --test test\parser.test.mjs test\rss.test.mjs

# 2. 宿主半部冒烟测试（真连 status.deepseek.com，验证路由返回 JSON，约 5–25s）
& $node test\host.smoke.mjs

# 3. RSS 兜底冒烟测试（桩 fetch：构造「只有 feed.rss 通」的降级场景，秒级）
& $node test\rss-fallback.smoke.mjs
```

`.test.mjs` 走 node 内置测试运行器，`.smoke.mjs` 是自写断言的脚本（`check()` 计数 +
退出码）；两者都以**退出码 0** 表示全绿。

## fixtures

`test/fixtures/` 是**真实响应**，不是手工构造的样本：

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `rsc.txt` | `GET /?_rsc=<随机>` + `RSC: 1` | `text/x-component`，字段未转义的裸 flight 文本 |
| `home.html` | `GET /` | 首页 HTML，flight 负载在 `self.__next_f.push([1,"…"])` 里 |
| `feed.rss` | `GET /feed.rss` | `application/rss+xml`，事件流（兜底源，实测 36 条 `<item>`） |

前两条路径必须解析出**同一份业务数据**（组件名/顺序、状态、uptime 全等）；只有
`initialDataUpdatedAt` 允许不同 —— 那是服务端渲染时刻，两份 fixture 相隔 75 秒抓取。

重新抓 fixture（状态页改版时）：

```powershell
$r = Invoke-WebRequest 'https://status.deepseek.com/' -UseBasicParsing
Set-Content test\fixtures\home.html -Value $r.Content -NoNewline
$r2 = Invoke-WebRequest 'https://status.deepseek.com/?_rsc=abc123' -UseBasicParsing -Headers @{ 'RSC' = '1' }
Set-Content test\fixtures\rsc.txt -Value $r2.Content -NoNewline
$r3 = Invoke-WebRequest 'https://status.deepseek.com/feed.rss' -UseBasicParsing
[System.IO.File]::WriteAllText("$PWD\test\fixtures\feed.rss", $r3.Content, (New-Object System.Text.UTF8Encoding($false)))
```

## 覆盖点

`parser.test.mjs`

- flight 文本提取（HTML 片段拼接 + 转义解除）
- 状态推导：`active_changes: []` → 全部组件 `operational`
- 最近事件：标题、起止时间、状态更新（`updates[].at_seconds`）、倒序
- 两条数据路径结果一致
- **容错**：空输入 / 无 `page` 对象 / `page` 被截断 / HTML 无片段 → 一律抛错或返回
  `unknown`，**不返回假的「正常」**

`rss.test.mjs`

- XML 实体（命名实体、`&#xA;`、`&#x4e2d;`）与白名单剥标签
- 真实 feed：条数下限、id 为数字串、link 前缀、`description` 已剥离
  `Status:` / `Affected components:` 两段
- 分支：`investigating` → `active` 且带 `startedAt`；`resolved` → `recentResolved`
  且带 `closedAt`（秒）、不带 `startedAt`
- id 取 `guid` 优先、退回 `link`；`pubDate` 解不出时时间为 `null`
- **容错**：空 feed / 无 `<item>` / 无有效条目 → 抛错

`host.smoke.mjs`

- 用假 ctx 调 `apply()`，捕获注册的路由
- 首次请求（尚未抓到数据）必须返回 `overall: "unknown"` 且组件为空
- 真实抓取完成后：走 RSC 主源、拿到组件与 uptime、`error` 为 `null`
- 降级：先抓成功 → 把 `sourceUrl` 换成不可达端口（用 `{ get() }` 包装模拟 volatile
  热更新）→ 必须保留上次快照（`fetchedAt` 不变、组件不清空）并带出错误
- 全新实例 + 不可达地址 → 只能是 `unknown`，不能编造「正常」

`rss-fallback.smoke.mjs`

- 桩 fetch 构造「RSC 500 + HTML 无 flight + feed 正常」：`via: "rss"`、
  `degraded: true`、`overall` 仍为 `unknown`、组件与 uptime 为空、事件仍有内容且带 link
- 三条路径全挂 → 抛出的聚合错误里 `rsc:` / `html:` / `rss:` 三段都有
- 路由层：快照标 `degraded`、`error` 带出降级原因、`failures` 归零（降级不算抓取失败）
