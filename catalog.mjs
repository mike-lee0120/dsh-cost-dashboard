/**
 * Auto-synced pricing catalog for dsh-cost-dashboard.
 *
 * Pulls the community-maintained LiteLLM price list
 * (model_prices_and_context_window.json) on a 24h TTL, maps it to the
 * plugin's per-1M-tokens pricing shape, and caches it on disk so a network
 * failure degrades to the last known-good snapshot instead of breaking the
 * dashboard.
 *
 * The catalog is the LOWEST priority in the pricing merge (user override >
 * builtin > catalog), so it only fills in models the builtin table and the
 * user's overrides do not already price.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const CATALOG_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;

function catalogPath(home) {
	return join(home, 'storages', 'cost-dashboard-catalog.json');
}

function num(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Strip a leading "provider/" prefix; unprefixed keys stay as-is. */
function normalizeName(rawName) {
	const slash = rawName.indexOf('/');
	return slash === -1 ? rawName : rawName.slice(slash + 1);
}

/** Map one LiteLLM row to the plugin's pricing entry; null when not a text model. */
function mapEntry(raw) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const input = num(raw.input_cost_per_token);
	const output = num(raw.output_cost_per_token);
	if (input === undefined || output === undefined) return null;
	const entry = { currency: 'USD', input: input * 1e6, output: output * 1e6 };
	const hit = num(raw.input_cost_per_token_cache_hit);
	if (hit !== undefined) entry.inputHit = hit * 1e6;
	const write = num(raw.cache_creation_input_token_cost);
	if (write !== undefined) entry.cacheWrite = write * 1e6;
	return entry;
}

function parseCatalog(text) {
	const doc = JSON.parse(text);
	const models = {};
	if (doc === null || typeof doc !== 'object') throw new Error('catalog root is not an object');
	for (const [rawName, raw] of Object.entries(doc)) {
		const entry = mapEntry(raw);
		if (entry === null) continue;
		const name = normalizeName(rawName);
		if (name === '' || models[name] !== undefined) continue;
		models[name] = entry;
	}
	return models;
}

function writeCatalog(home, payload) {
	const path = catalogPath(home);
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

function readCatalog(home) {
	try {
		const text = readFileSync(catalogPath(home), 'utf8');
		if (text.length > MAX_BYTES) return null;
		const doc = JSON.parse(text);
		if (doc === null || typeof doc !== 'object' || typeof doc.models !== 'object' || doc.models === null) return null;
		return doc;
	} catch {
		return null;
	}
}

let inflight = null;

/**
 * Load the catalog, honoring the TTL and a per-process in-flight dedupe.
 * @param {string} home - dsh home directory.
 * @param {{ force?: boolean }} opts - force ignores the TTL.
 * @returns {Promise<{ models: Record<string, object>, meta: object }>}
 */
export async function loadCatalog(home, { force = false } = {}) {
	if (inflight !== null) return inflight;
	inflight = (async () => {
		const cached = readCatalog(home);
		const fresh = cached !== null && typeof cached.fetchedAt === 'number'
			&& Date.now() - cached.fetchedAt < CATALOG_TTL_MS;
		if (cached !== null && fresh && !force) {
			return {
				models: cached.models,
				meta: {
					source: 'litellm',
					fetchedAt: cached.fetchedAt,
					modelCount: Object.keys(cached.models).length,
					stale: false,
					error: null,
				},
			};
		}
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
			const response = await fetch(CATALOG_URL, {
				signal: controller.signal,
				headers: { 'user-agent': 'dsh-cost-dashboard' },
			});
			clearTimeout(timer);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const text = await response.text();
			if (text.length > MAX_BYTES) throw new Error('catalog too large');
			const models = parseCatalog(text);
			const fetchedAt = Date.now();
			writeCatalog(home, { source: 'litellm', fetchedAt, models });
			return {
				models,
				meta: { source: 'litellm', fetchedAt, modelCount: Object.keys(models).length, stale: false, error: null },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (cached !== null) {
				return {
					models: cached.models,
					meta: {
						source: 'litellm',
						fetchedAt: cached.fetchedAt,
						modelCount: Object.keys(cached.models).length,
						stale: true,
						error: message,
					},
				};
			}
			return {
				models: {},
				meta: { source: 'litellm', fetchedAt: null, modelCount: 0, stale: false, error: message },
			};
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}
