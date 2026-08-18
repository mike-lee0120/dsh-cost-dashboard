# dsh-cost-dashboard

English | [中文](README.zh.md)

A cost-dashboard plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): aggregates model input / output / cache token usage across **all local sessions**, prices it with a built-in table (including DeepSeek peak/off-peak time-of-day pricing), and renders a dashboard under **Settings -> Cost Dashboard**. Comparable to cc-switch's usage statistics.

## What you get

- **Summary cards**: total cost (per currency), today's cost, input (cache-miss) / cache-read / cache-write / output tokens, session count
- **Daily trend chart**: tokens (four stacked buckets) and cost (one mini chart per currency), last 30 days
- **By-model table**: tokens, cost, share per model
- **By-session table**: top 100 sessions by cost, with title, project directory, models used, subagent badge
- **Pricing editor**: edit the pricing JSON in-page; saves to `~/.dsh/cost-dashboard.json`, effective immediately
- **Auto refresh**: polls every 15s while open; the host re-reads only changed log files (mtime + size validated)

## Install

```sh
dsh plugin --profile web add <spec>
```

`<spec>` may be a local path, an npm name, or a GitHub repo:

```sh
dsh plugin --profile web add /path/to/dsh-cost-dashboard
dsh plugin --profile web add github:<user>/dsh-cost-dashboard
dsh plugin --profile web add dsh-cost-dashboard
```

`dsh plugin add` runs pnpm in the profile directory and **automatically** appends any `dsh.bundle`-declaring package to `dsh.profile.bundles`. Restart `dsh web`, then open **Settings -> Cost Dashboard**.

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
- Run `node scripts/verify-totals.mjs` to reconcile against the official `session_projcache.json` (currently 26/26; an actively-writing session may drift by a live-write race, which is expected).

## Pricing

Built-in (per 1M tokens, checked 2026-08-18):

| Model | Currency | Input (miss) | Input (hit) | Output | Peak |
|---|---|---|---|---|---|
| deepseek-v4-pro | CNY | 4.5 | 0.15 | 13.5 | 9 / 0.30 / 27 (09-12, 14-18) |
| deepseek-v4-flash | CNY | 1.5 | 0.05 | 4.5 | 3 / 0.10 / 9.0 |
| glm-5.3 | USD | 1.40 | - | 4.40 | - |

- DeepSeek V4 peak/off-peak pricing effective 2026-08-17 (off-peak is half of peak; peak hours 09:00-12:00 and 14:00-18:00). Every usage record is timestamped, so the dashboard prices each sample by the host-local clock hour.
- glm-5.3 uses Z.ai list pricing; override it for the volcengine route.
- Unpriced models count tokens only.

### Overrides

The in-dashboard **Pricing config** editor saves `~/.dsh/cost-dashboard.json` (whole-entry per-model override):

```json
{
  "models": {
    "glm-5.3": { "currency": "USD", "input": 1.4, "inputHit": 0.14, "output": 4.4 },
    "my-local-model": { "currency": "CNY", "input": 2, "output": 6,
                        "peak": { "input": 4, "output": 12 }, "peakHours": [[9, 12], [14, 18]] }
  }
}
```

Fields: `currency` (CNY|USD), `input` (cache-miss), `inputHit` (defaults to input), `cacheWrite` (defaults to input), `output`; optional `peak` and `peakHours` (host-local hours; peak hours use peak rates, unset peak fields fall back to flat). Costs accumulate per currency; no FX conversion.

## Development

Plain `.mjs`, zero build step (host uses only Node builtins; the client is a hand-written module-loader bundle). Restart `dsh web` after any change.

## Security

- GET routes expose the same surface as other plugins' own routes (local data, no credentials).
- The pricing write (POST) accepts same-origin requests only (Origin==Host).
- Nothing is uploaded; the scan is read-only.

## Known limitations

- Costs are list-price estimates; no plans, discounts, or vouchers; peak hours use the host-local clock.
- Deleting session logs removes their history (statistics are entirely log-derived).
- Very large log corpora slow the cold scan; incremental caching keeps everyday refreshes fast.
