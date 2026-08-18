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
 * - GLM-5.3 Z.ai list price ($1.40 in / $4.40 out);火山方舟渠道价格可能不同，请自行覆盖。
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
	},
};

const CURRENCIES = new Set(['CNY', 'USD']);

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

/** Validate a whole pricing document ({ models: { name: entry } }); returns { models, errors }. */
export function normalizePricingDoc(value) {
	const errors = [];
	const models = {};
	if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.models !== 'object' || value.models === null) {
		return { models, errors: ['document must be { "models": { "<model>": { ... } } }'] };
	}
	for (const [name, entry] of Object.entries(value.models)) {
		const normalized = normalizeEntry(entry);
		if (normalized === null) {
			errors.push(`models["${name}"]: invalid entry (needs currency CNY|USD, numeric input/output, optional inputHit/cacheWrite/peak/peakHours)`);
			continue;
		}
		models[name] = normalized;
	}
	return { models, errors };
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
 * Effective pricing: builtin defaults with per-model whole-entry override.
 * Returns { models, overrideErrors }.
 */
export function effectivePricing(home) {
	const { doc, error } = loadOverride(home);
	const models = { ...BUILTIN_PRICING.models };
	const overrideErrors = error ? [error] : [];
	if (doc !== null) {
		const { models: overrides, errors } = normalizePricingDoc(doc);
		overrideErrors.push(...errors);
		for (const [name, entry] of Object.entries(overrides)) models[name] = entry;
	}
	return { models, overrideErrors };
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
