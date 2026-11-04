# AI API Status

在 DeepSeek Harness 会话标题栏右上角（`conversation.session.header.utilities`）常驻一个胶囊，**跟着当前会话选的模型走**：模型是 DeepSeek 就显示 DeepSeek 的服务状态，换成 GPT 或 Claude 就切到对应的状态页。

## 跟随模型

胶囊读取会话的模型选择（`ctx.modelDirectories` → 每个会话一个目录，store 里发布 `{ provider, model }`），按两者匹配供应商：

| 选择里出现 | 显示 |
| --- | --- |
| `deepseek` | DeepSeek 状态页 |
| `gpt` / `openai` / `chatgpt` / `codex` / `o3` 这类 | GPT（status.openai.com） |
| `claude` / `anthropic` | Claude（status.anthropic.com） |
| 认不出来 | 三家聚合视图（不会瞎猜） |

匹配同时看 provider（适配器组，例如 `dsh-opencode-go`）和 model（例如 `opencode-go/gpt-6-luna`），因为很多网关的 provider id 只是中间层，真正的厂商信息在模型名里。

卡片只显示**当前模型那一家**，并且把它**全部组件逐个列出**（不折叠成计数）：先列有问题的，再列正常的，每行带圆点与状态词；模型认不出来时退回三家全列。行数多时卡片限高滚动（72vh / 620px），标题栏吸顶。

## 安装

```bash
git clone https://github.com/cion771/dsh-status.git
```

然后在 Harness 里把该目录作为 bundle 安装（`plugin_manager` 的 `install_bundle`，target 填包目录的绝对路径）。安装后行 id 为 `dsh-status`，插件列表里显示为 “AI API 状态”。

## 状态文案

胶囊品牌是当前供应商的名字，文字是它自己的 headline；认不出模型时品牌回到 `AI API`，文字取三家最坏的那个：

| 胶囊文字 | 含义 |
| --- | --- |
| 正常 | operational（Statuspage 的 `none`） |
| 性能下降 | degraded（`minor`） |
| 维护中 | 有进行中的维护窗口 |
| 部分中断 | partial outage（`major`） |
| 中断 | full outage（`critical`） |
| 未知 | 状态源取不到 |

悬停（或键盘 Tab 聚焦）弹出详情卡：整体状态徽标，然后**每个供应商一段**——名字、它自己的状态、它当前受影响的组件（按严重度排序）、其余组件的数量、进行中的事件（标题 + 阶段 + 永久链接）；页脚给出刷新时间与三个来源。鼠标移开即收起。

## 灯色是连续的，不是四档

指示灯与边框的颜色由**受损比例**决定：

| 受损比例 | 颜色 |
| --- | --- |
| 0（全部正常） | 纯绿 `--dsw-alias-state-success-primary`，边框同色 |
| 每个组件出问题 | 绿色按比例混入琥珀 `--dsw-alias-state-warn-primary`，逐格变橙 |
| 0.5（半壁受损） | 纯琥珀 |
| 再往上 | 琥珀按比例混入红 `--dsw-alias-state-error-primary` |
| 1（全部中断） | 纯红 |

权重：`full_outage` / `partial_outage` 记 1，`degraded` / `maintenance` 记 0.5，`operational` 记 0，未知状态按 1 计（不当作健康）。所以「全部只是性能下降」= 0.5 = 琥珀，只有真的全挂才到红。

多供应商时取**最坏的那一家**的比例：只要有一家的服务全挂，灯就是红的，不会因为另外两家健康而被稀释。

实现：`healthOf()` 算出比例，`healthColor()` 生成一条 `color-mix(...)` 并写进 `--dsd-health`；胶囊边框、圆点、卡片徽标、卡片描边共享这一个变量。取不到数据时 `--dsd-health` 为中性灰，不冒充绿色。

## 交互

卡片常驻 DOM，由 CSS `:hover` / `:focus-within` 显隐 —— 没有 React 状态参与，鼠标移开即消失，也不会因为一次重渲染卡在打开状态；键盘 Tab 聚焦胶囊同样能展开。

## 三家的数据形状不一样

| 供应商 | 上游 | 拿到什么 | 频率 |
| --- | --- | --- | --- |
| DeepSeek | `status.deepseek.com` 的 Next.js 看板 + `feed.atom` | 看板：每组件当前状态（RSC flight payload，`/api/*` 全 404）；订阅：事件生命周期与受影响组件 | 120 s / 60 s |
| GPT | `status.openai.com/api/v2/summary.json` | Statuspage 标准 JSON：`status.indicator`、25 个 component、incidents | 60 s |
| Claude | `status.anthropic.com/api/v2/summary.json` | 同上，6 个 component | 60 s |

`index.js` 的规则：

1. **Statuspage 两家**直接把 `indicator` 当 headline（`none/minor/major/critical` → 正常/性能下降/部分中断/中断），component 状态映射成同一套词汇（`degraded_performance → degraded`、`major_outage → full_outage`、`under_maintenance → maintenance`），`scheduled_maintenances` 并入事件清单；
2. **DeepSeek** 看板决定组件状态与 headline，Atom 订阅决定事件清单；
3. **看板挂了**用订阅推导 headline（`investigating|identified → 部分中断`、`monitoring → 性能下降`），**订阅挂了**用看板 `active_changes` 兜底；
4. 每个供应商**独立缓存、独立降级**：一家超时不会拖空另外两家，失败的会标 `stale` 并在卡片里写明原因；
5. 三家都不可读才报 `unknown`，并保留 10 分钟内的旧数据；某一家两个源都取不到时**直接判失败**（卡片显示「暂不可用」+ 原因），不会拿一个空列表冒充「刚刷新过」。

Client 不访问外网，只轮询本地路由 `GET /api/dsh-status/summary`（60 s）。

## 文件

- `index.js` — 供应商表、抓取与缓存、RSC 解析（`rscPayload` / `readJsonValue`）、Atom 解析（`parseFeed`）、Statuspage 归一化（`summarizeStatuspage`）、合并（`summarize` / `combine` / `aggregateHeadline`）、路由注册。
- `client.js` — 插槽注册、中英词典、样式、轮询、按供应商分块的卡片。
- `cordis.patch.yml` — 插入 `dsh-status` 行。
- `locale/*.json` — 插件列表里的标题与描述。
- `icon.svg` — 图标（心电波形 + 状态点）。
- `test/` — 离线回归夹具：`status.html`、`feed.atom`、`openai.summary.json`、`anthropic.summary.json`，无需网络。

## 调整

- `index.js`：`PROVIDERS`（增删供应商，Statuspage 的只要一行 URL）、`PAGE_TTL_MS` / `FEED_TTL_MS` / `STATUSPAGE_TTL_MS` / `SNAPSHOT_TTL_MS` / `STALE_MS`（节奏与容错）。
- `client.js`：`ORDER`（右上角前后位置，越大越靠右）、`POLL_MS`、`HEALTH_PIVOT` / `HEALTH_WEIGHT`（灯色梯度）、`LABEL_KEY`（状态→文案）、`CSS`（胶囊尺寸配色）。

## 测试

```bash
node test/host.test.mjs    # 解析与合并：RSC 看板、Atom 订阅、Statuspage 归一化、聚合 headline、四种兜底分支
node test/client.test.mjs  # 渲染契约：颜色梯度、三家分块卡片、文案、兜底
npm test                   # 两者一起（193 条断言，无依赖、无网络）
```

## License

MIT — 见 [LICENSE](./LICENSE)。
