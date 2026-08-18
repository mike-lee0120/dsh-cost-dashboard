/**
 * Session-log scanning and usage accounting for dsh-cost-dashboard.
 *
 * Reads every persisted session artifact under $DSH_HOME/sessions (zstd
 * concatenated-frame `.jsonl.zstd` or plaintext `.jsonl`) and folds provider
 * usage into per-model token samples, mirroring the accounting semantics of
 * @deepseek-ai/dsh-token-meter's `tokenUsage` projection:
 *
 * - `assistant/chunk { type: 'usage' }` provides an early sample that
 *   survives a later request failure;
 * - `assistant/message` with `data.usage` provides the final sample for the
 *   same (turn, step);
 * - a repeated sample for the same (turn, step) REPLACES the earlier one
 *   instead of double-counting it.
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
			case 'assistant/message': {
				if (event.data?.usage === undefined) break;
				const source = event.data.message?.source;
				consider(
					event.data.turn,
					event.data.step,
					event.data.usage,
					event.time ?? 0,
					typeof source?.provider === 'string' ? source.provider : currentProvider,
					typeof source?.model === 'string' ? source.model : currentModel,
				);
				break;
			}
			default:
				break;
		}
	}
	commit();
	return record;
}

/**
 * Enumerate session artifact files under the sessions root.
 * @returns {{path:string, mtimeMs:number, size:number}[]}
 */
function listSessionFiles(home) {
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
			for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
				const path = join(root, project.name, session.name, name);
				try {
					const stats = statSync(path);
					if (stats.isFile()) files.push({ path, mtimeMs: stats.mtimeMs, size: stats.size });
				} catch {
					/* raced away - ignore */
				}
			}
		}
	}
	return files;
}

/**
 * Refresh the scan cache against the filesystem and return the parsed records.
 * Only new or changed (mtime/size) files are re-read; deleted files drop out.
 * @param {Map<string,{mtimeMs:number,size:number,record:object}>} cache - caller-held cache.
 * @returns {Promise<{records:object[], errors:string[], files:number}>}
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
 * @returns the dashboard stats document.
 */
export function aggregate(records, pricing) {
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
	const sessions = [];
	const unpriced = new Set();
	let subagents = 0;
	for (const record of records) {
		const sessionBuckets = zeroBuckets();
		const sessionCost = {};
		const sessionModels = [];
		let hasSamples = false;
		for (const { provider, model, samples } of Object.values(record.models)) {
			const modelKey = `${provider ?? '?'}\u0000${model ?? '?'}`;
			let modelRow = modelMap.get(modelKey);
			if (modelRow === undefined) {
				modelRow = { provider, model, buckets: zeroBuckets(), cost: {} };
				modelMap.set(modelKey, modelRow);
			}
			const entry = pricing[model ?? ''];
			if (entry === undefined && model != null) unpriced.add(model);
			for (const sample of samples) {
				hasSamples = true;
				addBuckets(totals, sample);
				addBuckets(modelRow.buckets, sample);
				addBuckets(sessionBuckets, sample);
				const cost = entry === undefined ? null : sampleCostOf(entry, sample);
				addCost(totalCost, cost);
				addCost(modelRow.cost, cost);
				addCost(sessionCost, cost);
				const day = dayOf(sample.t);
				let dayRow = dayMap.get(day);
				if (dayRow === undefined) {
					dayRow = { date: day, buckets: zeroBuckets(), cost: {} };
					dayMap.set(day, dayRow);
				}
				addBuckets(dayRow.buckets, sample);
				addCost(dayRow.cost, cost);
			}
			sessionModels.push({ provider, model });
		}
		if (record.delegationDepth > 0) subagents += 1;
		sessions.push({
			sessionId: record.id,
			title: record.title,
			project: record.cwd === null ? null : record.cwd.split('/').filter(Boolean).pop() ?? record.cwd,
			cwd: record.cwd,
			createdAt: record.createdAt,
			lastTime: record.lastTime,
			turns: record.turns,
			models: sessionModels,
			...sessionBuckets,
			costByCurrency: sessionCost,
			isSubagent: record.delegationDepth > 0,
			hasSamples,
		});
	}
	// Dominant currency for ordering (the currency with the greatest total).
	const dominant = Object.entries(totalCost).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
	const costOf_ = (costByCurrency) => dominant === null ? 0 : costByCurrency[dominant] ?? 0;
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
	const todayCost = dayMap.get(today)?.cost ?? {};
	return {
		summary: {
			sessions: records.length,
			subagents,
			activeSessions: sessions.filter((session) => session.hasSamples).length,
			totals,
			costByCurrency: totalCost,
			todayCostByCurrency: todayCost,
			dominantCurrency: dominant,
			firstDay: byDay[0]?.date ?? null,
			lastDay: today,
		},
		byDay: byDay.map((row) => ({ date: row.date, ...row.buckets, costByCurrency: row.cost })),
		byModel,
		bySession: sessions.slice(0, 100).map(({ hasSamples, ...rest }) => rest),
		sessionCount: sessions.length,
		unpricedModels: [...unpriced].sort(),
	};
}
