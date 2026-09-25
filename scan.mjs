/**
 * Session-log scanning and usage accounting for dsh-cost-dashboard.
 *
 * Reads the current generation of every persisted session artifact under
 * $DSH_HOME/sessions (zstd concatenated-frame `.jsonl.zstd` or plaintext
 * `.jsonl`) and folds provider usage into per-model token samples, mirroring
 * the accounting semantics of @deepseek-ai/dsh-token-meter's `tokenUsage`
 * projection:
 *
 * - `assistant/chunk { type: 'usage' }` (v2 logs) provides an early sample
 *   that survives a later request failure;
 * - `assistant/message` with `data.usage`, or the final `usage` chunk of its
 *   `data.stream`, provides the settlement sample for the same (turn, step);
 * - `assistant/attempt` contributes the same way, so an attempt whose
 *   settlement never became a message is still billed;
 * - a repeated sample for the same (turn, step) REPLACES the earlier one
 *   instead of double-counting it, and `llm/retry-started` closes that
 *   replacement slot so the retried attempt adds to the total.
 *
 * Model attribution: an assistant message names its own provider/model in
 * `message.source`; a bare usage chunk (failed request, no message) is
 * attributed to the latest `request/header` config seen so far.
 *
 * The scan keeps an in-memory cache keyed by file path with (mtime, size)
 * validation, so repeated dashboard refreshes only re-read changed files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { sampleCost as sampleCostOf } from './pricing.mjs';

const zstdDecompressAsync = promisify(zlib.zstdDecompress);
/** Whether this Node build exposes the zlib zstd API dsh logs rely on. */
export const zstdSupported = typeof zlib.zstdDecompress === 'function' && typeof zlib.constants?.ZSTD_e_flush === 'number';

/** The dsh home directory (session logs, storages, settings). */
export function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/*
 * Frame-boundary scanner for the concatenated-zstd session container.
 * Adapted from @deepseek-ai/dsh-session-persistence-jsonl (MIT,
 * deepseek-harness), which owns the on-disk format: each durable batch is one
 * independently decodable frame, and a crash may leave a torn final frame.
 */
const ZSTD_MAGIC = 4247762216;

/**
 * Locate complete frames without decompressing their blocks. Invalid complete
 * structure rejects; EOF inside the final frame returns its start for repair.
 * @param {Buffer} buffer - complete bytes currently present in the artifact.
 * @returns {{ frames: {start:number,end:number}[], tornStart?: number }}
 */
export function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = blockHeader >>> 1 & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}

/**
 * Decompress one session artifact to its JSONL text. Complete frames decode
 * independently; a torn final frame recovers whatever plaintext was flushed.
 * @returns {Promise<string>}
 */
export async function decompressLog(buffer) {
	const { frames, tornStart } = scanZstdFrames(buffer);
	const parts = [];
	for (const frame of frames) {
		parts.push(await zstdDecompressAsync(buffer.subarray(frame.start, frame.end)));
	}
	if (tornStart !== undefined) {
		parts.push(await zstdDecompressAsync(buffer.subarray(tornStart), { finishFlush: zlib.constants.ZSTD_e_flush }));
	}
	return Buffer.concat(parts).toString('utf8');
}

/** Local-timezone YYYY-MM-DD of an epoch-ms timestamp. */
export function dayOf(time) {
	const date = new Date(time);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function bucketsOf(usage) {
	return {
		in: usage.inputTokens ?? 0,
		cr: usage.cacheReadTokens ?? 0,
		cw: usage.cacheWriteTokens ?? 0,
		out: usage.outputTokens ?? 0,
	};
}

function sameBuckets(left, right) {
	return left.in === right.in && left.cr === right.cr && left.cw === right.cw && left.out === right.out;
}

/**
 * The final raw `usage` chunk of one durable Assistant settlement stream, or
 * undefined when it carries none. Mirrors lastAssistantStreamChunk from
 * @deepseek-ai/dsh-llm, whose contract the token meter folds on.
 */
function lastStreamUsage(stream) {
	if (!Array.isArray(stream)) return undefined;
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const record = stream[index];
		if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage;
	}
	return undefined;
}

/**
 * The provider usage one durable Assistant settlement reports, following the
 * token meter exactly: `assistant/message` prefers its explicit `data.usage`
 * and otherwise falls back to its stream, while `assistant/attempt` only ever
 * reports through its stream.
 */
function settlementUsage(event) {
	if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage;
	if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
	return lastStreamUsage(event.data?.stream);
}

/**
 * Fold one session's JSONL text into header facts and per-model usage samples.
 * Only newline-terminated lines are considered, so a concurrently written
 * partial tail line is ignored.
 * @returns the parsed session record (id null when the header line is unreadable).
 */
export function parseSession(text) {
	const record = {
		id: null,
		createdAt: null,
		cwd: null,
		delegationDepth: 0,
		agentPreset: null,
		parentSession: null,
		origin: null,
		title: null,
		lastTime: 0,
		turns: 0,
		models: {},
	};
	let currentProvider = null;
	let currentModel = null;
	let last = null;
	const commit = () => {
		if (last === null) return;
		const key = `${last.provider ?? '?'}\u0000${last.model ?? '?'}`;
		let bucket = record.models[key];
		if (bucket === undefined) {
			bucket = record.models[key] = { provider: last.provider, model: last.model, samples: [] };
		}
		bucket.samples.push(last.sample);
		last = null;
	};
	const consider = (turn, step, usage, time, provider, model) => {
		const sample = { ...bucketsOf(usage), t: time };
		if (last !== null && last.turn === turn && last.step === step) {
			if (sameBuckets(last.sample, sample)) return;
			last = { turn, step, sample, provider, model };
			return;
		}
		commit();
		last = { turn, step, sample, provider, model };
	};
	let lines = text.split('\n');
	if (lines.length > 0 && !text.endsWith('\n')) lines.pop();
	for (const line of lines) {
		if (line === '') continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof event.time === 'number' && event.time > record.lastTime) record.lastTime = event.time;
		switch (event.type) {
			case 'session':
				record.id = event.id ?? record.id;
				record.createdAt = event.createdAt ?? record.createdAt;
				record.cwd = event.cwd ?? record.cwd;
				record.delegationDepth = event.delegationDepth ?? record.delegationDepth;
				record.agentPreset = event.agentPreset ?? record.agentPreset;
				// A subagent's log names the session that spawned it, which is how
				// its usage is later folded back into that session.
				record.parentSession = event.parentSession ?? record.parentSession;
				record.origin = event.origin ?? record.origin;
				break;
			case 'session/title':
				record.title = event.data?.title ?? record.title;
				break;
			case 'turn/start':
				record.turns += 1;
				break;
			case 'request/header': {
				const config = event.data?.header?.config;
				if (typeof config?.provider === 'string') currentProvider = config.provider;
				if (typeof config?.model === 'string') currentModel = config.model;
				break;
			}
			case 'assistant/chunk': {
				const chunk = event.data?.chunk;
				if (chunk?.type !== 'usage') break;
				consider(event.data.turn, event.data.step, chunk.usage, event.time ?? 0, currentProvider, currentModel);
				break;
			}
			case 'assistant/attempt':
			case 'assistant/message': {
				const usage = settlementUsage(event);
				if (usage === undefined) break;
				const source = event.data?.message?.source;
				consider(
					event.data.turn,
					event.data.step,
					usage,
					event.time ?? 0,
					typeof source?.provider === 'string' ? source.provider : currentProvider,
					typeof source?.model === 'string' ? source.model : currentModel,
				);
				break;
			}
			case 'llm/retry-started':
				// The meter closes the replacement slot, so the retried attempt adds
				// to the total instead of replacing the settled one.
				if (last !== null && last.turn === event.data?.turn && last.step === event.data?.step) commit();
				break;
			default:
				break;
		}
	}
	commit();
	return record;
}

/*
 * One session directory holds one immutable file per published format
 * generation: `session.jsonl.zstd` is released v0, later generations are
 * `session.vN.jsonl.zstd`, and each also exists uncompressed as `.jsonl`. The
 * persistence backend serves the numerically highest generation, and a write
 * open publishes a migrated successor beside its byte-identical source, so a
 * migrated directory lists several generations at once - the older ones are
 * frozen at the migration point. The scan must therefore select exactly the
 * generation the runtime reads, not merely the first name it recognises.
 */
const ARTIFACT_PATTERN = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

/** Parse an artifact filename into its generation, or null when it is not one. */
function artifactOf(name) {
	const match = ARTIFACT_PATTERN.exec(name);
	if (match === null) return null;
	return { version: match[1] === undefined ? 0 : Number(match[1]), compressed: match[2] !== undefined };
}

/** True when `candidate` should be read instead of `current`. */
function artifactBeats(candidate, current) {
	if (candidate.version !== current.version) return candidate.version > current.version;
	if (candidate.mtimeMs !== current.mtimeMs) return candidate.mtimeMs > current.mtimeMs;
	return candidate.compressed && !current.compressed;
}

/**
 * Select the highest canonical generation present in one session directory.
 * @returns {{path:string, mtimeMs:number, size:number, version:number, compressed:boolean}|null}
 */
function selectArtifact(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	let best = null;
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const artifact = artifactOf(entry.name);
		if (artifact === null) continue;
		const path = join(dir, entry.name);
		let stats;
		try {
			stats = statSync(path);
		} catch {
			continue; /* raced away - ignore */
		}
		if (!stats.isFile()) continue;
		const candidate = { path, mtimeMs: stats.mtimeMs, size: stats.size, ...artifact };
		if (best === null || artifactBeats(candidate, best)) best = candidate;
	}
	return best;
}

/**
 * Enumerate the selected session artifact of every session directory.
 * @returns {{path:string, mtimeMs:number, size:number, version:number, compressed:boolean}[]}
 */
export function listSessionFiles(home) {
	const root = join(home, 'sessions');
	const files = [];
	let projects;
	try {
		projects = readdirSync(root, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		let sessions;
		try {
			sessions = readdirSync(join(root, project.name), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const session of sessions) {
			if (!session.isDirectory()) continue;
			const artifact = selectArtifact(join(root, project.name, session.name));
			if (artifact !== null) files.push(artifact);
		}
	}
	return files;
}

/**
 * Refresh the scan cache against the filesystem and return the parsed records.
 * Only new or changed (mtime/size) files are re-read; deleted files drop out.
 * @param {Map<string,{mtimeMs:number,size:number,record:object}>} cache - caller-held cache.
 * @returns {Promise<{records:object[], errors:string[], files:number}>} `files` counts the
 *   selected artifacts - exactly one log per session directory, never a stale generation.
 */
export async function scanAll(home, cache) {
	const files = listSessionFiles(home);
	const livePaths = new Set(files.map((file) => file.path));
	for (const path of cache.keys()) {
		if (!livePaths.has(path)) cache.delete(path);
	}
	const errors = [];
	for (const file of files) {
		const cached = cache.get(file.path);
		if (cached !== undefined && cached.mtimeMs === file.mtimeMs && cached.size === file.size) continue;
		try {
			const buffer = readFileSync(file.path);
			const text = file.path.endsWith('.zstd') ? await decompressLog(buffer) : buffer.toString('utf8');
			cache.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, record: parseSession(text) });
		} catch (error) {
			cache.delete(file.path);
			errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { records: [...cache.values()].map((entry) => entry.record), errors, files: files.length };
}

/**
 * Aggregate parsed session records against a pricing table.
 * @param {object[]} records - parsed session records from scanAll.
 * @param {Record<string, object>} pricing - effective pricing models map.
 * @param {{ cnyPerUsd: number }} [fx] - conversion rate; when given, rows are
 *   ordered by their CNY-equivalent cost, which is the currency reported.
 * @returns the dashboard stats document. `bySession` holds one row per
 *   (root session, model) pair: a subagent log is folded into the session that
 *   spawned it, so the table lists real sessions rather than every delegate.
 *   Only whole sessions are capped, and `sessionTotal` counts them all.
 */
export const MAX_SESSION_GROUPS = 1000;

export function aggregate(records, pricing, fx = undefined) {
	const zeroBuckets = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
	const addBuckets = (into, sample) => {
		into.input += sample.in;
		into.cacheRead += sample.cr;
		into.cacheWrite += sample.cw;
		into.output += sample.out;
	};
	const addCost = (into, cost) => {
		if (cost === null) return;
		into[cost.currency] = (into[cost.currency] ?? 0) + cost.amount;
	};
	const totals = zeroBuckets();
	const totalCost = {};
	const dayMap = new Map();
	const modelMap = new Map();
	const unpriced = new Set();
	let subagents = 0;
	let activeSessions = 0;
	/*
	 * Every log is billed to the ROOT session that owns it. A subagent's log
	 * names its parent in the header, so a delegate's tokens and cost land on the
	 * session that spawned it - the session table then shows real sessions, not
	 * one row per subagent. A log whose parent is missing keeps its own key and
	 * is reported as an orphaned subagent instead of disappearing.
	 */
	const recordKey = new Map();
	const recordByKey = new Map();
	const recordBySessionId = new Map();
	records.forEach((record, index) => {
		const key = record.id ?? `anon-${index}`;
		recordKey.set(record, key);
		if (!recordByKey.has(key)) recordByKey.set(key, record);
		if (record.id !== null) recordBySessionId.set(record.id, record);
	});
	const rootKeyOf = (record) => {
		let key = recordKey.get(record);
		let parentId = record.parentSession;
		const seen = new Set([key]);
		while (parentId !== null && parentId !== undefined && !seen.has(parentId)) {
			seen.add(parentId);
			const parent = recordBySessionId.get(parentId);
			if (parent === undefined) break;
			key = recordKey.get(parent);
			parentId = parent.parentSession;
		}
		return key;
	};
	const groups = new Map();
	for (const record of records) {
		const rootKey = rootKeyOf(record);
		const rootRecord = recordByKey.get(rootKey) ?? record;
		let group = groups.get(rootKey);
		if (group === undefined) {
			group = {
				key: rootKey,
				id: rootRecord.id,
				title: rootRecord.title,
				project: rootRecord.cwd === null ? null : rootRecord.cwd.split('/').filter(Boolean).pop() ?? rootRecord.cwd,
				cwd: rootRecord.cwd,
				createdAt: rootRecord.createdAt,
				lastTime: rootRecord.lastTime,
				turns: 0,
				subagentCount: 0,
				// A root that is itself a subagent means its parent log is missing.
				orphanSubagent: rootRecord.delegationDepth > 0,
				models: new Map(),
			};
			groups.set(rootKey, group);
		}
		if (record !== rootRecord) group.subagentCount += 1;
		group.turns += record.turns;
		let hasSamples = false;
		for (const { provider, model, samples } of Object.values(record.models)) {
			if (samples.length === 0) continue;
			hasSamples = true;
			const modelKey = `${provider ?? '?'}\u0000${model ?? '?'}`;
			let modelRow = modelMap.get(modelKey);
			if (modelRow === undefined) {
				modelRow = { provider, model, buckets: zeroBuckets(), cost: {} };
				modelMap.set(modelKey, modelRow);
			}
			let row = group.models.get(modelKey);
			if (row === undefined) {
				row = { provider, model, buckets: zeroBuckets(), cost: {}, lastTime: 0 };
				group.models.set(modelKey, row);
			}
			const entry = pricing[model ?? ''];
			if (entry === undefined && model != null) unpriced.add(model);
			for (const sample of samples) {
				addBuckets(totals, sample);
				addBuckets(modelRow.buckets, sample);
				addBuckets(row.buckets, sample);
				if (sample.t > row.lastTime) row.lastTime = sample.t;
				if (sample.t > group.lastTime) group.lastTime = sample.t;
				const cost = entry === undefined ? null : sampleCostOf(entry, sample);
				addCost(totalCost, cost);
				addCost(modelRow.cost, cost);
				addCost(row.cost, cost);
				const day = dayOf(sample.t);
				let dayRow = dayMap.get(day);
				if (dayRow === undefined) {
					dayRow = { date: day, buckets: zeroBuckets(), cost: {} };
					dayMap.set(day, dayRow);
				}
				addBuckets(dayRow.buckets, sample);
				addCost(dayRow.cost, cost);
			}
		}
		if (record.delegationDepth > 0) subagents += 1;
		if (hasSamples) activeSessions += 1;
	}
	const sessions = [];
	for (const group of groups.values()) {
		for (const row of group.models.values()) {
			sessions.push({
				sessionId: group.id,
				sessionKey: group.key,
				title: group.title,
				project: group.project,
				cwd: group.cwd,
				createdAt: group.createdAt,
				lastTime: row.lastTime || group.lastTime || group.createdAt,
				turns: group.turns,
				provider: row.provider,
				model: row.model,
				modelsTotal: group.models.size,
				subagentCount: group.subagentCount,
				...row.buckets,
				costByCurrency: row.cost,
				isSubagent: group.orphanSubagent,
			});
		}
	}
	// Ordering value of one cost map: the CNY-equivalent total when a rate is
	// known (the dashboard reports CNY), else the dominant currency's own total.
	const dominant = Object.entries(totalCost).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
	const costOf_ = fx === undefined
		? (costByCurrency) => dominant === null ? 0 : costByCurrency[dominant] ?? 0
		: (costByCurrency) => (costByCurrency?.CNY ?? 0) + (costByCurrency?.USD ?? 0) * fx.cnyPerUsd;
	sessions.sort((left, right) => costOf_(right.costByCurrency) - costOf_(left.costByCurrency)
		|| (right.input + right.cacheRead + right.cacheWrite + right.output)
			- (left.input + left.cacheRead + left.cacheWrite + left.output));
	const byModel = [...modelMap.values()]
		.map((row) => ({ provider: row.provider, model: row.model, ...row.buckets, costByCurrency: row.cost, priced: pricing[row.model ?? ''] !== undefined }))
		.sort((left, right) => costOf_(right.costByCurrency) - costOf_(left.costByCurrency)
			|| (right.input + right.cacheRead + right.cacheWrite + right.output)
				- (left.input + left.cacheRead + left.cacheWrite + left.output));
	// Day series from the earliest sample to today, zero-filled.
	const today = dayOf(Date.now());
	const byDay = [];
	if (dayMap.size > 0) {
		const days = [...dayMap.keys()].sort();
		const cursor = new Date(`${days[0]}T00:00:00`);
		const end = new Date(`${today}T00:00:00`);
		while (cursor <= end && byDay.length < 400) {
			const date = dayOf(cursor.getTime());
			const row = dayMap.get(date);
			byDay.push(row ?? { date, buckets: zeroBuckets(), cost: {} });
			cursor.setDate(cursor.getDate() + 1);
		}
	}
	// Cap by session, never mid-session: a client that re-sorts by time must
	// still see complete sessions, so rows of one session are kept together and
	// only whole sessions fall off the end.
	const sessionTotal = new Set(sessions.map((row) => row.sessionKey)).size;
	const bySession = [];
	const keptKeys = new Set();
	for (const row of sessions) {
		if (!keptKeys.has(row.sessionKey)) {
			if (keptKeys.size >= MAX_SESSION_GROUPS) continue;
			keptKeys.add(row.sessionKey);
		}
		bySession.push(row);
	}
	const todayCost = dayMap.get(today)?.cost ?? {};
	return {
		summary: {
			sessions: records.length,
			// Sessions the user actually started; subagent logs are folded into them.
			rootSessions: sessionTotal,
			subagents,
			activeSessions,
			totals,
			costByCurrency: totalCost,
			todayCostByCurrency: todayCost,
			dominantCurrency: dominant,
			firstDay: byDay[0]?.date ?? null,
			lastDay: today,
		},
		byDay: byDay.map((row) => ({ date: row.date, ...row.buckets, costByCurrency: row.cost })),
		byModel,
		bySession,
		sessionCount: bySession.length,
		sessionTotal,
		unpricedModels: [...unpriced].sort(),
	};
}
