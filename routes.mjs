/**
 * HTTP routes bridging the browser dashboard to the scan/pricing modules.
 *
 * GET  /cost-dashboard/stats    - aggregated usage + cost document
 * GET  /cost-dashboard/pricing  - builtin / override / effective pricing
 * POST /cost-dashboard/pricing  - save the user override document (same-origin)
 *
 * Route shape follows the dshmarket plugin's market routes; POST is guarded by
 * an Origin==Host check (helpers adapted from dshmarket, MIT).
 */
import { dshHome, scanAll, aggregate, zstdSupported } from './scan.mjs';
import {
	BUILTIN_PRICING,
	DEFAULT_FX,
	effectivePricing,
	normalizePricingDoc,
	saveOverride,
	loadOverride,
	overridePath,
} from './pricing.mjs';

const MAX_PRICING_BODY = 256 * 1024;

/** Write a JSON payload with no-store caching. */
function sendJson(response, status, payload) {
	response.writeHead(status, {
		'cache-control': 'no-store',
		'content-type': 'application/json; charset=utf-8',
	});
	response.end(JSON.stringify(payload));
}

/** True when the request's Origin matches its Host - required on POST routes. */
function sameOrigin(request) {
	const origin = request.headers.origin;
	const host = request.headers.host;
	if (origin === undefined || host === undefined) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

/** Read and parse a JSON request body, rejecting anything over maxBytes. */
async function readJsonBody(request, maxBytes) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > maxBytes) throw new Error('request body too large');
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Register the dashboard routes on the host webServer.
 * @param {{ webServer: { register: (route: object) => () => void } }} host - acquired webServer context.
 * @returns a disposer removing every route.
 */
export function mountRoutes(host) {
	const home = dshHome();
	const cache = new Map();
	let inflight = null;

	const ensureScan = () => {
		if (inflight === null) {
			inflight = (async () => {
				try {
					return await scanAll(home, cache);
				} finally {
					inflight = null;
				}
			})();
		}
		return inflight;
	};

	const disposers = [
		host.webServer.register({
			kind: 'exact',
			path: '/cost-dashboard/stats',
			handler: async (request, response) => {
				if (request.method !== 'GET') {
					response.writeHead(405, { allow: 'GET' });
					response.end();
					return;
				}
				if (!zstdSupported) {
					sendJson(response, 503, { error: 'node:zlib zstd API unavailable - dsh-cost-dashboard needs Node >= 22.15' });
					return;
				}
				try {
					const started = Date.now();
					const { records, errors, files } = await ensureScan();
					const pricing = effectivePricing(home);
					const stats = aggregate(records, pricing.models);
					sendJson(response, 200, {
						...stats,
						fx: pricing.fx,
						pricingErrors: pricing.overrideErrors,
						meta: { generatedAt: Date.now(), files, scanMs: Date.now() - started, errors: errors.slice(0, 20) },
					});
				} catch (error) {
					sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			},
		}),
		host.webServer.register({
			kind: 'exact',
			path: '/cost-dashboard/pricing',
			handler: async (request, response) => {
				if (request.method === 'GET') {
					const { doc, error } = loadOverride(home);
					const pricing = effectivePricing(home);
					sendJson(response, 200, {
						builtin: BUILTIN_PRICING,
						override: doc,
						overrideError: error,
						fx: pricing.fx,
						effective: { models: pricing.models },
					});
					return;
				}
				if (request.method !== 'POST') {
					response.writeHead(405, { allow: 'GET, POST' });
					response.end();
					return;
				}
				if (!sameOrigin(request)) {
					sendJson(response, 403, { error: 'untrusted origin' });
					return;
				}
				try {
					const body = await readJsonBody(request, MAX_PRICING_BODY);
					if (typeof body?.content !== 'string') {
						sendJson(response, 400, { error: 'body must be { "content": "<pricing json>" }' });
						return;
					}
					let parsed;
					try {
						parsed = JSON.parse(body.content);
					} catch (error) {
						sendJson(response, 400, { error: `invalid JSON: ${error.message}` });
						return;
					}
					const { models, fx, errors } = normalizePricingDoc(parsed);
					if (Object.keys(models).length === 0) {
						sendJson(response, 400, { error: errors.length > 0 ? errors.join('; ') : 'no valid model entries' });
						return;
					}
					saveOverride(home, { fx, models: parsed.models });
					const pricing = effectivePricing(home);
					sendJson(response, 200, {
						ok: true,
						saved: overridePath(home),
						warnings: errors,
						fx: pricing.fx,
						effective: { models: pricing.models },
					});
				} catch (error) {
					sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
				}
			},
		}),
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
