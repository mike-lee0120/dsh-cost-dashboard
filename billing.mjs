/**
 * Provider billing integration (C layer) for dsh-cost-dashboard.
 *
 * C1 - balance monitoring (DeepSeek, OpenRouter) and C2 - read-only actual
 * spend (OpenAI daily cost, Anthropic daily cost report). Every provider is
 * optional: it activates only when a credential is configured, and a failure
 * degrades to the last-good snapshot plus a visible error instead of breaking
 * the dashboard.
 *
 * Credentials live in ~/.dsh/cost-dashboard-credentials.json (mode 0600).
 * Domestic cloud vendors (Volcengine/Alibaba/Tencent) are intentionally NOT
 * integrated here - their prices come from the config file instead.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const BILLING_TTL_MS = 60 * 60 * 1000;
const LOOKBACK_DAYS = 30;
const REQUEST_TIMEOUT_MS = 20000;

const PROVIDERS = {
	deepseek: { label: 'DeepSeek', kind: 'balance' },
	openrouter: { label: 'OpenRouter', kind: 'balance' },
	openai: { label: 'OpenAI', kind: 'cost' },
	anthropic: { label: 'Anthropic', kind: 'cost' },
};

function credPath(home) {
	return join(home, 'cost-dashboard-credentials.json');
}

function billingPath(home) {
	return join(home, 'storages', 'cost-dashboard-billing.json');
}

/** Read configured credentials; missing/malformed file yields empty providers. */
export function loadCredentials(home) {
	try {
		const text = readFileSync(credPath(home), 'utf8');
		const doc = JSON.parse(text);
		if (doc === null || typeof doc !== 'object' || typeof doc.providers !== 'object' || doc.providers === null) {
			return { providers: {} };
		}
		return doc;
	} catch {
		return { providers: {} };
	}
}

/** Atomically persist credentials with 0600 permissions. */
export function saveCredentials(home, providers) {
	const path = credPath(home);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, JSON.stringify({ providers }, null, '\t'), 'utf8');
	chmodSync(temp, 0o600);
	try {
		renameSync(temp, path);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* best effort */ }
		throw error;
	}
}

async function httpJson(url, { headers = {}, params = {} } = {}, fetchImpl = fetch) {
	const target = new URL(url);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null) target.searchParams.set(key, value);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetchImpl(target, { headers, signal: controller.signal });
		const text = await response.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* non-JSON body */ }
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}${json?.error?.message ? `: ${json.error.message}` : `: ${text.slice(0, 120)}`}`);
		}
		return json;
	} finally {
		clearTimeout(timer);
	}
}

/** DeepSeek /user/balance - total available balance across currencies. */
async function deepseekBalance(cfg, fetchImpl) {
	const doc = await httpJson('https://api.deepseek.com/user/balance', {
		headers: { Authorization: `Bearer ${cfg.apiKey}` },
	}, fetchImpl);
	const infos = Array.isArray(doc?.balance_infos) ? doc.balance_infos : [];
	const amount = infos.reduce((sum, info) => sum + (Number(info.total_balance) || 0), 0);
	return { provider: 'deepseek', label: 'DeepSeek', currency: String(infos[0]?.currency ?? 'CNY').toUpperCase(), amount };
}

/** OpenRouter /api/v1/key - remaining credits (limit minus usage). */
async function openrouterUsage(cfg, fetchImpl) {
	const doc = await httpJson('https://openrouter.ai/api/v1/key', {
		headers: { Authorization: `Bearer ${cfg.apiKey}` },
	}, fetchImpl);
	const data = doc?.data ?? {};
	const limit = Number(data.limit) || 0;
	const usage = Number(data.usage) || 0;
	return {
		provider: 'openrouter',
		label: 'OpenRouter',
		currency: 'USD',
		amount: Math.max(0, limit - usage),
		limit,
		usage,
	};
}

/**
 * OpenAI /v1/organization/costs - daily total spend (one bucket per day).
 * NOTE: amount.value is treated as the currency's major unit (USD); verify
 * against a real admin key, since the exact unit is not machine-discoverable.
 */
async function openaiCosts(cfg, fetchImpl) {
	const startTime = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 24 * 3600;
	const doc = await httpJson('https://api.openai.com/v1/organization/costs', {
		headers: { Authorization: `Bearer ${cfg.adminKey}` },
		params: { start_time: startTime, bucket_width: '1d' },
	}, fetchImpl);
	const daily = [];
	for (const row of Array.isArray(doc?.data) ? doc.data : []) {
		const amount = Number(row?.amount?.value);
		const currency = String(row?.amount?.currency ?? 'USD').toUpperCase();
		const start = Number(row?.start_time ?? row?.timestamp);
		if (!Number.isFinite(amount) || !Number.isFinite(start)) continue;
		const date = new Date(start * 1000);
		daily.push({
			date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
			provider: 'openai',
			currency,
			cost: amount,
		});
	}
	return daily;
}

/**
 * Anthropic /v1/organizations/cost_report - daily cost grouped by model,
 * folded here into one daily total per provider.
 * NOTE: amount.value is treated as the currency's major unit; verify against
 * a real admin key.
 */
async function anthropicCosts(cfg, fetchImpl) {
	const startingAt = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();
	const doc = await httpJson('https://api.anthropic.com/v1/organizations/cost_report', {
		headers: { 'x-api-key': cfg.adminKey, 'anthropic-version': '2023-06-01' },
		params: { starting_at: startingAt, bucket_width: '1d', group_by: 'model' },
	}, fetchImpl);
	const daily = [];
	for (const bucket of Array.isArray(doc?.data) ? doc.data : []) {
		const start = Date.parse(bucket?.starting_at ?? '');
		if (!Number.isFinite(start)) continue;
		const date = new Date(start);
		const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
		let total = 0;
		let currency = 'USD';
		for (const result of Array.isArray(bucket?.results) ? bucket.results : []) {
			const amount = Number(result?.amount?.value);
			if (Number.isFinite(amount)) total += amount;
			if (typeof result?.amount?.currency === 'string') currency = result.amount.currency.toUpperCase();
		}
		if (total > 0) daily.push({ date: day, provider: 'anthropic', currency, cost: total });
	}
	return daily;
}

function readBillingCache(home) {
	try {
		const doc = JSON.parse(readFileSync(billingPath(home), 'utf8'));
		if (doc === null || typeof doc !== 'object') return null;
		return doc;
	} catch {
		return null;
	}
}

function writeBillingCache(home, payload) {
	const path = billingPath(home);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, JSON.stringify(payload), 'utf8');
	try {
		renameSync(temp, path);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* best effort */ }
		throw error;
	}
}

let inflight = null;

/**
 * Load balances and daily actual spend for every configured provider.
 * @param {string} home - dsh home directory.
 * @param {{ force?: boolean, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ balances: object[], daily: object[], meta: object }>}
 */
export async function loadBilling(home, { force = false, fetchImpl = fetch } = {}) {
	if (inflight !== null) return inflight;
	inflight = (async () => {
		const cached = readBillingCache(home);
		const fresh = cached !== null && typeof cached.asOf === 'number' && Date.now() - cached.asOf < BILLING_TTL_MS;
		if (cached !== null && fresh && !force) {
			return { balances: cached.balances ?? [], daily: cached.daily ?? [], meta: cached.meta ?? {} };
		}
		const { providers } = loadCredentials(home);
		const configured = Object.keys(providers).filter((id) => PROVIDERS[id] !== undefined);
		const balances = [];
		const daily = [];
		const errors = [];
		if (configured.length === 0) {
			return { balances, daily, meta: { asOf: Date.now(), configured: [], errors: [] } };
		}
		for (const id of configured) {
			const cfg = providers[id];
			try {
				if (id === 'deepseek') {
					const balance = await deepseekBalance(cfg, fetchImpl);
					balances.push({ ...balance, asOf: Date.now() });
				} else if (id === 'openrouter') {
					const usage = await openrouterUsage(cfg, fetchImpl);
					balances.push({ ...usage, asOf: Date.now() });
				} else if (id === 'openai') {
					daily.push(...(await openaiCosts(cfg, fetchImpl)));
				} else if (id === 'anthropic') {
					daily.push(...(await anthropicCosts(cfg, fetchImpl)));
				}
			} catch (error) {
				errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const payload = { asOf: Date.now(), balances, daily, meta: { asOf: Date.now(), configured, errors } };
		writeBillingCache(home, payload);
		return { balances, daily, meta: payload.meta };
	})().finally(() => {
		const reset = () => { inflight = null; };
		reset();
	});
	return inflight;
}

export { PROVIDERS };
