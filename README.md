# dsh-cost-dashboard

English | [中文](README.zh.md)

A cost-dashboard plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): aggregates model input / output / cache token usage across **all local sessions**, prices it with a built-in table (including DeepSeek peak/off-peak time-of-day pricing), and renders a dashboard under **Settings -> Cost Dashboard**.

## What you get

- **Two entry points**: Settings -> Cost Dashboard (the settings nav icons are hardcoded by the dsh settings shell, so plugins cannot customize them), plus a **sidebar footer icon button** (data-grid style) that opens the same dashboard in an anchored panel
- **Currency switch**: displays in **USD by default** with a one-click CNY toggle; converts between CNY- and USD-listed prices at the configurable `fx.cnyPerUsd` rate (default 6.79)
- **Summary cards**: total cost, today's cost, input (cache-miss) / cache-read / cache-write / output tokens, session count
- **Daily trend chart**: tokens (four stacked buckets) and cost (**single unified-currency** series), last 30 days
- **By-model table**: tokens, cost, share per model
- **By-session table**: sorted by cost, **one row per session-model pair** (a session that used several models appears on several rows, each with its own model, tokens and cost), with title, project directory, subagent badge
- **Pricing editor**: edit the pricing JSON (including the FX rate) in-page; saves to `~/.dsh/cost-dashboard.json`, effective immediately
- **Auto refresh**: polls every 15s while open; the host re-reads only changed log files (mtime + size validated)

## Install

```sh
dsh plugin --profile web add <spec>
```

`<spec>` may be a local path, an npm name, or a GitHub repo:

```sh
dsh plugin --profile web add /path/to/dsh-cost-dashboard
dsh plugin --profile web add github:mike-lee0120/dsh-cost-dashboard
dsh plugin --profile web add dsh-cost-dashboard  # once published to npm
```

`dsh plugin add` runs pnpm in the profile directory and **automatically** appends any `dsh.bundle`-declaring package to `dsh.profile.bundles`. Restart `dsh web` and refresh the page, then open **Settings -> Cost Dashboard**.

Remove with `dsh plugin --profile web remove dsh-cost-dashboard`.

Requires dsh `0.1.0-rc.7`+ and Node >= 22.15 (the `node:zlib` zstd API the host itself relies on for session logs).

## Data source and accounting

- Read-only scan of `$DSH_HOME/sessions/*/*/session.jsonl.zstd` (or plaintext `.jsonl`); nothing is written, no projection touched.
- Accounting mirrors the official `@deepseek-ai/dsh-token-meter` `tokenUsage` projection:
  - `assistant/chunk {type:'usage'}` is an early sample that survives a later request failure;
  - `assistant/message` usage is the final sample for the same `(turn, step)` and **replaces** it instead of double counting;
  - four disjoint buckets: uncached input (DeepSeek `prompt_tokens` with cache hits subtracted), cache read, cache write, output.
- Model attribution: `assistant/message` carries `message.source.provider/model`; a bare usage chunk (failed request) is attributed to the latest `request/header` model.
- Mid-session model switches are split correctly.
- Run `node scripts/verify-totals.mjs` to reconcile against the official `session_projcache.json` (verified session-by-session in development; an actively-writing session may drift by a live-write race, which is expected).

## Pricing

Built-in pricing for 21 mainstream models (per 1M tokens, checked 2026-08-18; "hit" = cache-read rate, "write" = cache-write rate, defaults to the cache-miss input rate when unset):

**CNY-listed models**

| Model | Input (miss) | Input (hit) | Output | Notes |
|---|---|---|---|---|
| deepseek-v4-pro | 4.5 | 0.15 | 13.5 | peak doubles: 9 / 0.30 / 27 (09-12, 14-18) |
| deepseek-v4-flash | 1.5 | 0.05 | 4.5 | peak doubles: 3 / 0.10 / 9.0 |
| kimi-k3 | 20 | 2 | 100 | Moonshot China list price |
| qwen3.8-max | 12 | 1.5 | 36 | Alibaba Bailian China price |
| doubao-seed-2.1-pro | 6 | - | 30 | Volcengine Ark |
| hy3 | 1 | 0.25 | 4 | Tencent Hunyuan |
| minimax-m3 | 3.15 | 0.63 | 12.6 | ≤512K input, half-price list rate |

**USD-listed models**

| Model | Input (miss) | Input (hit) | Cache write | Output | Notes |
|---|---|---|---|---|---|
| gpt-5.6-sol | 5 | 0.5 | - | 30 | |
| gpt-5.6-terra | 2 | 0.2 | - | 12 | |
| gpt-5.6-luna | 0.20 | 0.02 | - | 1.20 | |
| gpt-5.5 | 5 | 0.5 | - | 30 | |
| gpt-5.4 | 2.5 | 0.25 | - | 15 | |
| gpt-5.1 | 1.25 | 0.125 | - | 10 | |
| claude-opus-5 | 5 | 0.5 | 6.25 | 25 | |
| claude-sonnet-5 | 2 | 0.2 | 2.5 | 10 | temporary rate through 2026-08-31, then $3/$15 |
| claude-fable-5 | 10 | 1 | 12.5 | 50 | |
| gemini-3.6-flash | 1.5 | - | - | 7.5 | |
| gemini-3.5-flash-lite | 0.3 | - | - | 2.5 | |
| grok-4.6 | 2 | - | - | 6 | |
| grok-4.6-fast | 4 | 1 | - | 12 | |
| glm-5.3 | 1.40 | - | - | 4.40 | Z.ai list price; override for the volcengine route |

- DeepSeek V4 peak/off-peak pricing effective 2026-08-17 (off-peak is half of peak; peak hours 09:00-12:00 and 14:00-18:00). Every usage record is timestamped, so the dashboard prices each sample by the host-local clock hour.
- Unpriced models count tokens only.

### Overrides

The in-dashboard **Pricing config** editor saves `~/.dsh/cost-dashboard.json` (per-model whole-entry overrides plus the FX rate):

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

Fields: `fx.cnyPerUsd` (USD->CNY, default 6.79, used for cross-currency display); per model `currency` (CNY|USD), `input` (cache-miss), `inputHit` (defaults to input), `cacheWrite` (defaults to input), `output`; optional `peak` and `peakHours` (host-local hours; peak hours use peak rates, unset peak fields fall back to flat). The dashboard displays USD by default and converts CNY-listed prices at the FX rate; switching to CNY converts USD-listed prices the other way.

## Development

Plain `.mjs`, zero build step (host uses only Node builtins; the client is a hand-written module-loader bundle). Restart `dsh web` and refresh the page after any change.

## Security

- GET routes expose the same surface as other plugins' own routes (local data, no credentials).
- The pricing write (POST) accepts same-origin requests only (Origin==Host).
- Nothing is uploaded; the scan is read-only.

## Known limitations

- Costs are list-price estimates; no plans, discounts, or vouchers; peak hours use the host-local clock.
- Deleting session logs removes their history (statistics are entirely log-derived).
- Very large log corpora slow the cold scan; incremental caching keeps everyday refreshes fast.
