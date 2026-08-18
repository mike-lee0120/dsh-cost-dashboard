# dsh-cost-dashboard · DSH 费用看板

[English](README.md) | 中文

装在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）里的费用看板插件：汇总本机**全部会话**的模型输入 / 输出 / 缓存命中 token 用量，按价格表（含 DeepSeek 峰谷分时计价）计算费用，在 **设置 → 费用看板** 中以看板形式展示。

## 你会得到

- **汇总卡片**：总费用（多币种分别显示）、今日费用、输入（未命中缓存）/ 缓存命中 / 缓存写入 / 输出 tokens、会话数
- **每日趋势图**：Tokens（四桶堆叠柱）与费用（按币种分图）两种模式，近 30 天
- **按模型汇总表**：各模型的 token 用量、费用、占比
- **按会话汇总表**：按费用排序的前 100 个会话，含标题、项目目录、使用的模型、子代理标记
- **价格配置**：页面上直接编辑价格表 JSON，保存到 `~/.dsh/cost-dashboard.json`，立即生效
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
dsh plugin --profile web add github:<user>/dsh-cost-dashboard
# npm
dsh plugin --profile web add dsh-cost-dashboard
```

`dsh plugin add` 会在 profile 目录（`~/.dsh/profiles/web`）执行 pnpm 安装，并**自动**把声明了 `dsh.bundle` 的包追加进 `dsh.profile.bundles`（无需手改 profile 配置）。安装后重启 `dsh web`，打开 **设置 → 费用看板**。

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
- 可运行 `node scripts/verify-totals.mjs` 与官方 `session_projcache.json` 逐会话对账（当前 26/26 一致；正在写入的活跃会话可能因实时时间差出现微小偏差，属正常）。

## 价格表

内置（单位：每百万 tokens，核对于 2026-08-18）：

| 模型 | 币种 | 输入(未命中) | 输入(命中) | 输出 | 峰时 |
|---|---|---|---|---|---|
| deepseek-v4-pro | CNY | 4.5 | 0.15 | 13.5 | 9 / 0.30 / 27（9-12、14-18 点） |
| deepseek-v4-flash | CNY | 1.5 | 0.05 | 4.5 | 3 / 0.10 / 9.0 |
| glm-5.3 | USD | 1.40 | — | 4.40 | — |

- DeepSeek V4 系列自 2026-08-17 起执行峰谷定价（空闲为高峰一半，高峰时段 9:00-12:00、14:00-18:00）；每条用量记录带时间戳，看板按宿主本地时区精确分时段计价。
- glm-5.3 采用 Z.ai 标价，火山方舟渠道价格可能不同，请自行覆盖。
- 未配置价格的模型只统计 tokens、不计费用，页面会提示。

### 覆盖价格

看板底部 **价格配置** 编辑器直接保存 `~/.dsh/cost-dashboard.json`（按模型名整条覆盖内置价）：

```json
{
  "models": {
    "glm-5.3": { "currency": "USD", "input": 1.4, "inputHit": 0.14, "output": 4.4 },
    "my-local-model": { "currency": "CNY", "input": 2, "output": 6,
                        "peak": { "input": 4, "output": 12 }, "peakHours": [[9, 12], [14, 18]] }
  }
}
```

字段：`currency`（CNY|USD）、`input`（未命中输入价）、`inputHit`（缓存命中价，缺省=input）、`cacheWrite`（缓存写价，缺省=input）、`output`；可选 `peak` 与 `peakHours`（宿主本地时间，命中峰时用 peak 费率，peak 未写的字段回落平价）。多币种费用分别累计，不做汇率换算。

## 开发

纯 `.mjs` 零构建（host 侧仅 Node 内置模块，client 侧手写 module-loader bundle）。改动 host（`index.mjs`/`scan.mjs`/`pricing.mjs`/`routes.mjs`）或 client（`client.mjs`）后重启 `dsh web` 生效。

## 安全

- GET 数据路由与 dshmarket 等插件的自有路由同等暴露面（仅本机数据、无凭据）。
- 价格写入（POST）仅接受同源请求（Origin==Host 校验）。
- 不上报任何数据；扫描只读。

## 已知限制

- 费用为按标价的估算，不含套餐/折扣/代金券；峰谷按宿主本地时区判断。
- 会话日志删除后对应历史随之消失（统计完全基于本地日志）。
- 超大日志库（数千会话）冷启动扫描会变慢；增量缓存使日常刷新不受影响。
