# dsh-cost-dashboard · DSH 费用看板

[English](README.md) | 中文

装在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）里的费用看板插件：汇总本机**全部会话**的模型输入 / 输出 / 缓存命中 token 用量，按价格表（含 DeepSeek 峰谷分时计价）计算费用，在 **设置 → 费用看板** 中以看板形式展示。

## 你会得到

- **两个入口**：设置 → 费用看板（设置导航图标由 dsh 设置外壳按内置 id 硬编码，无法由插件自定义）；侧边栏底部另有**看板图标按钮**（数据网格样式），点击在面板中打开同一看板
- **币种切换**：默认按 **USD** 显示，可一键切换 CNY；按可配置汇率（`fx.cnyPerUsd`，默认 6.79）把人民币标价与美元标价换算到同一币种
- **汇总卡片**：总费用、今日费用、输入（未命中缓存）/ 缓存命中 / 缓存写入 / 输出 tokens、会话数
- **每日趋势图**：ECharts 平滑折线图（带渐变面积与悬浮 tooltip）；费用模式为单序列（统一币种），Tokens 模式拆为"输入/缓存写入/输出"与"缓存命中"两张图（各自刻度）；时间范围可选 **近一周 / 近一月 / 近三月**（默认近一周）
- **按模型汇总表**：各模型的 token 用量、费用、占比
- **按会话汇总表**：按费用排序，**每个会话按模型拆行**（一个会话用了多个模型就多行，各自显示模型、tokens 与费用），含标题、项目目录、子代理标记
- **价格配置**：页面上直接编辑价格表 JSON（含汇率），保存到 `~/.dsh/cost-dashboard.json`，立即生效
- **自动刷新**：看板打开期间每 15 秒拉取一次；宿主侧只增量重扫有变化的日志文件（mtime + size 校验）

## 安装

```sh
dsh plugin --profile web add <spec>
```

`<spec>` 支持本地路径 / npm 包名 / GitHub 仓库，例如：

```sh
# 本地路径开发安装
dsh plugin --profile web add /path/to/dsh-cost-dashboard
# GitHub
dsh plugin --profile web add github:mike-lee0120/dsh-cost-dashboard
# npm（发布后可用）
dsh plugin --profile web add dsh-cost-dashboard
```

`dsh plugin add` 会在 profile 目录（`~/.dsh/profiles/web`）执行 pnpm 安装，并**自动**把声明了 `dsh.bundle` 的包追加进 `dsh.profile.bundles`（无需手改 profile 配置）。安装后重启 `dsh web` 并**刷新页面**，打开 **设置 → 费用看板**。

卸载：`dsh plugin --profile web remove dsh-cost-dashboard`（自动移出 bundles）。

要求：dsh `0.1.0-rc.7`+，Node ≥ 22.15（`node:zlib` 的 zstd API，宿主本身依赖它写会话日志）。

## 数据来源与记账规则

- 只读扫描 `$DSH_HOME/sessions/*/*/session.jsonl.zstd`（或明文 `.jsonl`），不写入、不改投影。
- 记账语义与官方 `@deepseek-ai/dsh-token-meter` 的 `tokenUsage` 投影一致：
  - `assistant/chunk {type:'usage'}` 是请求的早期样本（请求后续失败也计数）；
  - `assistant/message` 的 `usage` 是同 `(turn, step)` 的最终样本，**替换**前者而非重复计数；
  - 四个不相交桶：输入（未命中缓存，DeepSeek `prompt_tokens` 已扣除缓存命中）、缓存命中、缓存写入、输出。
- 模型归属：`assistant/message` 自带 `message.source.provider/model`；仅有 usage chunk（失败请求）时归属最近一条 `request/header` 的模型。
- 会话中途切换模型也能正确拆分到各模型。
- 可运行 `node scripts/verify-totals.mjs` 与官方 `session_projcache.json` 逐会话对账（开发环境实测逐会话一致；正在写入的活跃会话可能因实时时间差出现微小偏差，属正常）。

## 价格表

内置 21 个主流模型（单位：每百万 tokens，核对于 2026-08-18；「命中」= 缓存命中价，「写入」= 缓存写入价，缺省按未命中输入价计）：

**人民币标价（CNY）**

| 模型 | 输入(未命中) | 输入(命中) | 输出 | 备注 |
|---|---|---|---|---|
| deepseek-v4-pro | 4.5 | 0.15 | 13.5 | 峰时翻倍：9 / 0.30 / 27（9-12、14-18 点） |
| deepseek-v4-flash | 1.5 | 0.05 | 4.5 | 峰时翻倍：3 / 0.10 / 9.0 |
| kimi-k3 | 20 | 2 | 100 | 月之暗面国内标价 |
| qwen3.8-max | 12 | 1.5 | 36 | 阿里云百炼国内标价 |
| doubao-seed-2.1-pro | 6 | — | 30 | 火山方舟 |
| hy3 | 1 | 0.25 | 4 | 腾讯混元 |
| minimax-m3 | 3.15 | 0.63 | 12.6 | ≤512K 输入五折刊例价 |

**美元标价（USD）**

| 模型 | 输入(未命中) | 输入(命中) | 缓存写入 | 输出 | 备注 |
|---|---|---|---|---|---|
| gpt-5.6-sol | 5 | 0.5 | — | 30 | |
| gpt-5.6-terra | 2 | 0.2 | — | 12 | |
| gpt-5.6-luna | 0.20 | 0.02 | — | 1.20 | |
| gpt-5.5 | 5 | 0.5 | — | 30 | |
| gpt-5.4 | 2.5 | 0.25 | — | 15 | |
| gpt-5.1 | 1.25 | 0.125 | — | 10 | |
| claude-opus-5 | 5 | 0.5 | 6.25 | 25 | |
| claude-sonnet-5 | 2 | 0.2 | 2.5 | 10 | 2026-08-31 前临时价，之后 $3/$15 |
| claude-fable-5 | 10 | 1 | 12.5 | 50 | |
| gemini-3.6-flash | 1.5 | — | — | 7.5 | |
| gemini-3.5-flash-lite | 0.3 | — | — | 2.5 | |
| grok-4.6 | 2 | — | — | 6 | |
| grok-4.6-fast | 4 | 1 | — | 12 | |
| glm-5.3 | 1.40 | — | — | 4.40 | Z.ai 标价，火山方舟渠道请自行覆盖 |

- DeepSeek V4 系列自 2026-08-17 起执行峰谷定价（空闲为高峰一半，高峰时段 9:00-12:00、14:00-18:00）；每条用量记录带时间戳，看板按宿主本地时区精确分时段计价。
- 未配置价格的模型只统计 tokens、不计费用，页面会提示。

### 覆盖价格

看板底部 **价格配置** 编辑器直接保存 `~/.dsh/cost-dashboard.json`（按模型名整条覆盖内置价；汇率按 `fx` 覆盖）：

```json
{
  "fx": { "cnyPerUsd": 6.79 },
  "models": {
    "glm-5.3": { "currency": "USD", "input": 1.4, "inputHit": 0.14, "output": 4.4 },
    "my-local-model": { "currency": "CNY", "input": 2, "output": 6,
                        "peak": { "input": 4, "output": 12 }, "peakHours": [[9, 12], [14, 18]] }
  }
}
```

字段：`fx.cnyPerUsd`（美元兑人民币，默认 6.79，用于跨币种换算显示）；每个模型 `currency`（CNY|USD）、`input`（未命中输入价）、`inputHit`（缓存命中价，缺省=input）、`cacheWrite`（缓存写价，缺省=input）、`output`；可选 `peak` 与 `peakHours`（宿主本地时间，命中峰时用 peak 费率，peak 未写的字段回落平价）。看板默认以 USD 显示，CNY 标价按汇率折算；切换 CNY 时 USD 标价按汇率折算。

## 开发

纯 `.mjs` 零构建（host 侧仅 Node 内置模块，client 侧手写 module-loader bundle；图表用仓库内 vendor 的 ECharts 5，Apache-2.0，由 `/cost-dashboard/vendor/echarts` 本地提供，无 CDN 依赖）。改动 host（`index.mjs`/`scan.mjs`/`pricing.mjs`/`routes.mjs`）或 client（`client.mjs`）后重启 `dsh web` 并刷新页面生效。

## 安全

- GET 数据路由与 dshmarket 等插件的自有路由同等暴露面（仅本机数据、无凭据）。
- 价格写入（POST）仅接受同源请求（Origin==Host 校验）。
- 不上报任何数据；扫描只读。

## 已知限制

- 费用为按标价的估算，不含套餐/折扣/代金券；峰谷按宿主本地时区判断。
- 会话日志删除后对应历史随之消失（统计完全基于本地日志）。
- 超大日志库（数千会话）冷启动扫描会变慢；增量缓存使日常刷新不受影响。
