/**
 * Pricing table and per-sample cost calculation for dsh-cost-dashboard.
 *
 * All rates are per 1,000,000 tokens. An entry may carry a flat rate only,
 * or additionally a `peak` tier plus `peakHours` (host-local clock hours,
 * inclusive start, exclusive end) for time-of-day pricing such as
 * DeepSeek's peak/off-peak scheme effective 2026-08-17.
 *
 * Missing `inputHit` defaults to the (cache-miss) input rate; missing
 * `cacheWrite` defaults to the active tier's input rate. A peak tier only
 * overrides the rates it names and falls back to the flat rates otherwise.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join as joinPath } from 'node:path';

/** DeepSeek peak hours (Beijing time), 2026-08-17 pricing announcement. */
export const DEFAULT_PEAK_HOURS = [[9, 12], [14, 18]];

/**
 * Built-in model pricing, per 1M tokens.
 * Sources (checked 2026-08-18):
 * - DeepSeek V4 official peak/off-peak pricing, effective 2026-08-17
 *   (off-peak is half of peak; peak hours 09:00-12:00 and 14:00-18:00).
 * - GLM-5.3 Z.ai list price;火山方舟渠道价格可能不同，请自行覆盖。
 * - OpenAI GPT-5.6/5.5/5.4/5.1: benchlm.ai OpenAI API pricing (Aug 2026),
 *   cached-input rates at 10% of input.
 * - Anthropic Claude 5 series: benchlm.ai Anthropic API pricing (Aug 2026);
 *   cache read 10% of input, cache write 1.25x input. Sonnet 5 runs a
 *   temporary $2/$10 rate through 2026-08-31, then $3/$15.
 * - Google Gemini 3.6 Flash / 3.5 Flash-Lite: 量子位 via BAAI Hub (2026-07-24).
 * - xAI Grok 4.6: Cursor release note via kie.ai (2026-08-13), $2/$6 with a
 *   fast variant at 2x ($4/$12, cache read $1).
 * - Kimi K3: 界面新闻 (Moonshot 中国标价, ¥20/¥2/¥100).
 * - Qwen3.8-Max: ai-indeed.com 国内标价 (¥12/¥1.5/¥36).
 * - Tencent Hy3: 新京报 (2026-07-06, ¥1/¥0.25/¥4).
 * - Doubao Seed 2.1 Pro: 新浪科技 (¥6/¥30).
 * - MiniMax-M3: MiniMax 开放平台按量计费页 (≤512K 输入五折刊例价).
 */
export const BUILTIN_PRICING = {
	models: {
		'deepseek-v4-pro': {
			currency: 'CNY',
			input: 4.5,
			inputHit: 0.15,
			output: 13.5,
			peak: { input: 9, inputHit: 0.3, output: 27 },
			peakHours: DEFAULT_PEAK_HOURS,
		},
		'deepseek-v4-flash': {
			currency: 'CNY',
			input: 1.5,
			inputHit: 0.05,
			output: 4.5,
			peak: { input: 3, inputHit: 0.1, output: 9 },
			peakHours: DEFAULT_PEAK_HOURS,
		},
		'glm-5.3': {
			currency: 'USD',
			input: 1.4,
			output: 4.4,
		},
		'gpt-5.6-sol': {
			currency: 'USD',
			input: 5,
			inputHit: 0.5,
			output: 30,
		},
		'gpt-5.6-terra': {
			currency: 'USD',
			input: 2,
			inputHit: 0.2,
			output: 12,
		},
		'gpt-5.6-luna': {
			currency: 'USD',
			input: 0.2,
			inputHit: 0.02,
			output: 1.2,
		},
		'gpt-5.5': {
			currency: 'USD',
			input: 5,
			inputHit: 0.5,
			output: 30,
		},
		'gpt-5.4': {
			currency: 'USD',
			input: 2.5,
			inputHit: 0.25,
			output: 15,
		},
		'gpt-5.1': {
			currency: 'USD',
			input: 1.25,
			inputHit: 0.125,
			output: 10,
		},
		'claude-opus-5': {
			currency: 'USD',
			input: 5,
			inputHit: 0.5,
			cacheWrite: 6.25,
			output: 25,
		},
		'claude-sonnet-5': {
			currency: 'USD',
			input: 2,
			inputHit: 0.2,
			cacheWrite: 2.5,
			output: 10,
		},
		'claude-fable-5': {
			currency: 'USD',
			input: 10,
			inputHit: 1,
			cacheWrite: 12.5,
			output: 50,
		},
		'gemini-3.6-flash': {
			currency: 'USD',
			input: 1.5,
			output: 7.5,
		},
		'gemini-3.5-flash-lite': {
			currency: 'USD',
			input: 0.3,
			output: 2.5,
		},
		'grok-4.6': {
			currency: 'USD',
			input: 2,
			output: 6,
		},
		'grok-4.6-fast': {
			currency: 'USD',
			input: 4,
			inputHit: 1,
			output: 12,
		},
		'kimi-k3': {
			currency: 'CNY',
			input: 20,
			inputHit: 2,
			output: 100,
		},
		'qwen3.8-max': {
			currency: 'CNY',
			input: 12,
			inputHit: 1.5,
			output: 36,
		},
		'hy3': {
			currency: 'CNY',
			input: 1,
			inputHit: 0.25,
			output: 4,
		},
		'doubao-seed-2.1-pro': {
			currency: 'CNY',
			input: 6,
			output: 30,
		},
		'minimax-m3': {
			currency: 'CNY',
			input: 3.15,
			inputHit: 0.63,
			output: 12.6,
		},
	},
};

const CURRENCIES = new Set(['CNY', 'USD']);

/** Default USD/CNY conversion: 1 USD = 6.79 CNY (2026-08-18 PBOC mid rate 6.7905). */
export const DEFAULT_FX = { cnyPerUsd: 6.79 };

/** Validate and normalize one model pricing entry; returns null when invalid. */
export function normalizeEntry(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const out = {};
	const currency = value.currency ?? 'CNY';
	if (!CURRENCIES.has(currency)) return null;
	out.currency = currency;
	for (const key of ['input', 'inputHit', 'cacheWrite', 'output']) {
		const raw = value[key];
		if (raw === undefined || raw === null) continue;
		if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
		out[key] = raw;
	}
	if (out.input === undefined || out.output === undefined) return null;
	if (value.peak !== undefined) {
		if (value.peak === null || typeof value.peak !== 'object' || Array.isArray(value.peak)) return null;
		const peak = {};
		for (const key of ['input', 'inputHit', 'cacheWrite', 'output']) {
			const raw = value.peak[key];
			if (raw === undefined || raw === null) continue;
			if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
			peak[key] = raw;
		}
		if (Object.keys(peak).length > 0) out.peak = peak;
	}
	if (value.peakHours !== undefined) {
		if (!Array.isArray(value.peakHours) || value.peakHours.length === 0) return null;
		const hours = [];
		for (const pair of value.peakHours) {
			if (!Array.isArray(pair) || pair.length !== 2) return null;
			const [start, end] = pair;
			if (typeof start !== 'number' || typeof end !== 'number'
				|| !Number.isInteger(start) || !Number.isInteger(end)
				|| start < 0 || start > 24 || end < 0 || end > 24 || start >= end) return null;
			hours.push([start, end]);
		}
		out.peakHours = hours;
	}
	return out;
}

/** Validate a whole pricing document ({ fx?: {cnyPerUsd}, models: { name: entry } }); returns { models, fx, errors }. */
export function normalizePricingDoc(value) {
	const errors = [];
	const models = {};
	if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.models !== 'object' || value.models === null) {
		return { models, fx: { ...DEFAULT_FX }, errors: ['document must be { "fx": { "cnyPerUsd": 6.79 }, "models": { "<model>": { ... } } }'] };
	}
	let fx = { ...DEFAULT_FX };
	if (value.fx !== undefined) {
		if (value.fx === null || typeof value.fx !== 'object' || Array.isArray(value.fx)
			|| typeof value.fx.cnyPerUsd !== 'number' || !Number.isFinite(value.fx.cnyPerUsd) || value.fx.cnyPerUsd <= 0) {
			errors.push('fx: invalid, needs { "cnyPerUsd": positive number } - using default');
		} else {
			fx = { cnyPerUsd: value.fx.cnyPerUsd };
		}
	}
	for (const [name, entry] of Object.entries(value.models)) {
		const normalized = normalizeEntry(entry);
		if (normalized === null) {
			errors.push(`models["${name}"]: invalid entry (needs currency CNY|USD, numeric input/output, optional inputHit/cacheWrite/peak/peakHours)`);
			continue;
		}
		models[name] = normalized;
	}
	return { models, fx, errors };
}

/** Path of the user override document. */
export function overridePath(home) {
	return joinPath(home, 'cost-dashboard.json');
}

/**
 * Read the user override document. Returns { doc, error } - a missing file is
 * not an error (doc null); a malformed file yields doc null plus an error.
 */
export function loadOverride(home) {
	const path = overridePath(home);
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if (error?.code === 'ENOENT') return { doc: null, error: null };
		return { doc: null, error: `${path}: ${error.message}` };
	}
	if (text.length > 1024 * 1024) return { doc: null, error: `${path}: override file too large` };
	try {
		return { doc: JSON.parse(text), error: null };
	} catch (error) {
		return { doc: null, error: `${path}: invalid JSON (${error.message})` };
	}
}

/** Atomically write the override document. */
export function saveOverride(home, value) {
	const path = overridePath(home);
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
	try {
		renameSync(temp, path);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* best effort */ }
		throw error;
	}
}

/**
 * Effective pricing: catalog (lowest) -> builtin -> per-model user override.
 * @param {string} home - dsh home directory.
 * @param {{ models?: Record<string, object> }} [catalog] - synced LiteLLM catalog.
 * @returns { models, fx, overrideErrors }
 */
export function effectivePricing(home, catalog = undefined) {
	const { doc, error } = loadOverride(home);
	// Lowest priority first: catalog, then builtin over it, then user override on top.
	const models = { ...(catalog?.models ?? {}), ...BUILTIN_PRICING.models };
	let fx = { ...DEFAULT_FX };
	const overrideErrors = error ? [error] : [];
	if (doc !== null) {
		const { models: overrides, fx: overrideFx, errors } = normalizePricingDoc(doc);
		overrideErrors.push(...errors);
		for (const [name, entry] of Object.entries(overrides)) models[name] = entry;
		fx = overrideFx;
	}
	return { models, fx, overrideErrors };
}

/**
 * Cost of one usage sample under one pricing entry.
 * sample: { t: epoch-ms, in, cr, cw, out } - token counts per bucket.
 * Returns { currency, amount } or null when the entry is unpriced.
 */
export function sampleCost(entry, sample) {
	if (entry === undefined) return null;
	let rates = {
		input: entry.input,
		inputHit: entry.inputHit ?? entry.input,
		cacheWrite: entry.cacheWrite ?? entry.input,
		output: entry.output,
	};
	if (entry.peak !== undefined) {
		const hours = entry.peakHours ?? DEFAULT_PEAK_HOURS;
		const hour = new Date(sample.t).getHours();
		const isPeak = hours.some(([start, end]) => hour >= start && hour < end);
		if (isPeak) {
			rates = {
				input: entry.peak.input ?? rates.input,
				inputHit: entry.peak.inputHit ?? entry.inputHit ?? entry.input,
				cacheWrite: entry.peak.cacheWrite ?? entry.cacheWrite ?? entry.input,
				output: entry.peak.output ?? rates.output,
			};
		}
	}
	const amount = (sample.in * rates.input
		+ sample.cr * rates.inputHit
		+ sample.cw * rates.cacheWrite
		+ sample.out * rates.output) / 1e6;
	return { currency: entry.currency, amount };
}
