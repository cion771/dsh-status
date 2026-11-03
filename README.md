# DeepSeek API Status

在 DeepSeek Harness 会话标题栏右上角（`conversation.session.header.utilities`）常驻一个胶囊，显示 **status.deepseek.com** 上 DeepSeek API 的实时服务状态。

## 安装

```bash
# 1) 克隆到任意目录
git clone https://github.com/cion771/dsh-deepseek-status.git
```

然后在 Harness 里把该目录作为 bundle 安装（`plugin_manager` 的 `install_bundle`，target 填包目录的绝对路径）。安装后行 id 为 `deepseek-status`，插件列表里显示为 “DeepSeek API 状态”。

## 状态文案

| 胶囊文字 | 对应状态页 |
| --- | --- |
| DeepSeek API 正常 | All Systems Operational / operational |
| DeepSeek API 性能下降 | Degraded Performance / degraded |
| DeepSeek API 维护中 | Under Maintenance / maintenance |
| DeepSeek API 部分中断 | Partial Outage / partial_outage |
| DeepSeek API 中断 | Full Outage / full_outage |
| DeepSeek API 未知 | 两个源都取不到 |

悬停（或键盘 Tab 聚焦）弹出详情卡：整体状态徽标、**受影响的服务**（按严重度排序，带颜色圆点与状态词）、其余正常服务的数量与清单、进行中的事件（标题 + 阶段 + 永久链接）、刷新时间与数据来源。数据刷新失败时卡片底部会提示旧数据；鼠标移开即收起。

## 灯色是连续的，不是四档

指示灯与边框的颜色由**受损比例**决定，而不是看板 headline 的四档：

| 受损比例 | 颜色 |
| --- | --- |
| 0（全部正常） | 纯绿 `--dsw-alias-state-success-primary`，边框同色 |
| 每个服务出问题 | 绿色按比例混入琥珀 `--dsw-alias-state-warn-primary`，逐格变橙 |
| 0.5（半壁受损） | 纯琥珀 |
| 再往上 | 琥珀按比例混入红 `--dsw-alias-state-error-primary` |
| 1（全部中断） | 纯红 |

权重：`full_outage` / `partial_outage` 记 1，`degraded` / `maintenance` 记 0.5，`operational` 记 0，未知状态按 1 计（不当作健康）。所以「全部只是性能下降」= 0.5 = 琥珀，只有真的全挂才到红。

实现：`healthOf()` 算出比例，`healthColor()` 生成一条 `color-mix(...)` 并写进 `--dsd-health`；胶囊边框、圆点、卡片徽标、卡片描边共享这一个变量。取不到数据时 `--dsd-health` 为中性灰，不冒充绿色。

## 交互

卡片常驻 DOM，由 CSS `:hover` / `:focus-within` 显隐 —— 没有 React 状态参与，鼠标移开即消失，也不会因为一次重渲染卡在打开状态；键盘 Tab 聚焦胶囊同样能展开。

## 两个数据源，各管一半

状态页提供两个公开入口，**单独任何一个都不够**：

| 源 | 给什么 | 不给什么 | 频率 |
| --- | --- | --- | --- |
| `https://status.deepseek.com/feed.atom`（RSS `feed.rss` 同内容） | 每次变更的生命周期状态（investigating / identified / monitoring / resolved / scheduled …）、受影响组件名单、永久链接、更新时间 | 每个组件**当前**状态、可用率、看板 headline | 60 s |
| `https://status.deepseek.com/`（Next.js 页面） | 每个组件的当前状态、看板 headline | 稳定 API（`/api/*` 全 404）、轻量载荷 | 120 s |

于是 `index.js` 的合并规则是：

1. **组件状态与 headline** 以**看板**为准——只有它发布 per-component 的 `degraded` / `partial_outage`（数据内嵌在 SSR HTML 的 RSC flight payload 里，`self.__next_f.push([1,"…"])`，用平衡括号取值）；
2. **事件清单**以 **Atom 订阅**为准——它是事件生命周期的权威，`Status:` 字段直接给出 investigating / monitoring / resolved，还有 `Affected components:` 与 `/incidents/<id>` 链接；
3. **看板挂了**（解析失败 / 超时）时用订阅推导 headline：`investigating|identified → 部分中断`、`monitoring → 性能下降`、维护类 → 维护中、无未结事件 → 正常；此时服务列表为空但胶囊仍可用；
4. **订阅挂了**时用看板的 `active_changes` 兜底事件清单；
5. **两个都挂了**才报 `unknown`，并保留 10 分钟内的旧数据（标记 `stale`）。

HTTP 只出两个请求：看板 120 s 一次（≈220 KB），订阅 60 s 一次（≈19 KB）。Client 不访问外网，只轮询本地路由 `GET /api/dsh-deepseek-status/summary`（60 s）。

## 文件

- `index.js` — 抓取、RSC 解析（`rscPayload` / `readJsonValue`）、Atom 解析（`parseFeed` / `openIncidents`）、合并（`summarize` / `combine` / `headlineFromIncidents`）、路由注册。
- `client.js` — 插槽注册、中英词典、样式、轮询与渲染。
- `cordis.patch.yml` — 插入 `deepseek-status` 行。
- `locale/*.json` — 插件列表里的标题与描述。
- `icon.svg` — 图标（心电波形 + 状态点）。
- `test/` — 离线回归：真实抓取的 `status.html` 与 `feed.atom` 作为夹具，无需网络。

## 调整

- `index.js`：`PAGE_TTL_MS` / `FEED_TTL_MS` / `SNAPSHOT_TTL_MS` / `STALE_MS`（节奏与容错）、`PAGE` / `FEED`（换源）。
- `client.js`：`ORDER`（右上角前后位置，越大越靠右）、`POLL_MS`、`HEALTH_PIVOT` / `HEALTH_WEIGHT`（灯色梯度）、`LABEL_KEY`（状态→文案）、`CSS`（胶囊尺寸配色）。

## 测试

```bash
node test/host.test.mjs    # 解析与合并：RSC 看板、Atom 订阅、四种兜底分支
node test/client.test.mjs  # 渲染契约：颜色梯度、卡片结构、文案、兜底
npm test                   # 两者一起（140 条断言，无依赖、无网络）
```

## License

MIT — 见 [LICENSE](./LICENSE)。
