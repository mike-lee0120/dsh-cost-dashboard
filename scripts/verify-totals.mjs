#!/usr/bin/env node
/**
 * Independent checks of dsh-cost-dashboard's token accounting and pricing.
 *
 * 1. Snapshot check - compare scanned per-session totals against
 *    $DSH_HOME/storages/session_projcache.json, the harness's own folded
 *    `tokenUsage` projection cache. That cache is a point-in-time snapshot, so
 *    a session whose selected log was written after it is reported as skipped
 *    (not failed): its newer events simply postdate the snapshot.
 * 2. Live fold check - fold every selected log with the token meter's
 *    `tokenUsage` semantics (@deepseek-ai/dsh-token-meter) and compare that
 *    against scan.mjs's own parseSession totals. This covers the logs the
 *    snapshot cannot, including a migrated successor generation.
 * 3. Generation-selection check - a synthetic session directory holding several
 *    format generations must resolve to the highest one.
 * 4. Pricing check - DeepSeek's official CNY rates and retired aliases, and the
 *    peak window (Beijing time, weekdays only, holidays excluded).
 *
 * The snapshot check anchors the fold, the fold check covers current storage
 * generations, and the pricing check pins the published rates, so a drift in
 * any of the three fails.
 *
 * Usage: node scripts/verify-totals.mjs
 * Exit 0 when no mismatch is reported; 1 otherwise.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dshHome, decompressLog, listSessionFiles, parseSession } from '../scan.mjs';
import { BUILTIN_PRICING, DEFAULT_PEAK_HOURS, DEFAULT_PEAK_WEEKDAYS, normalizeEntry, sampleCost } from '../pricing.mjs';

const BUCKET_KEYS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const zeroBuckets = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const bucketsEqual = (left, right) => BUCKET_KEYS.every((key) => left[key] === right[key]);
/** The meter's bucket names for one provider usage sample. */
const bucketsFrom = (usage) => ({
	uncachedInputTokens: usage.inputTokens,
	outputTokens: usage.outputTokens,
	cacheReadTokens: usage.cacheReadTokens ?? 0,
	cacheWriteTokens: usage.cacheWriteTokens ?? 0,
});

/** Last raw `usage` chunk of a durable settlement stream; local mirror of dsh-llm's helper. */
function localLastStreamChunk(stream, type) {
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const record = stream[index];
		if (record.type === 'chunk' && record.chunk.type === type) return record.chunk;
	}
	return undefined;
}

const home = dshHome();

// Prefer the deployment's own chunk helper so the fold below is judged against
// shipped code; fall back to the identical local mirror on a bare checkout.
let lastStreamChunk = localLastStreamChunk;
for (const candidate of [
	join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'),
	join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'),
]) {
	if (!existsSync(candidate)) continue;
	try {
		({ lastAssistantStreamChunk: lastStreamChunk } = await import(candidate));
		console.log(`fold reference: shipped dsh-llm helper (${candidate})`);
		break;
	} catch (error) {
		console.error(`could not load ${candidate}: ${error.message}`);
	}
}
if (lastStreamChunk === localLastStreamChunk) console.log('fold reference: local mirror of dsh-llm lastAssistantStreamChunk');

/**
 * The `tokenUsage` projection of @deepseek-ai/dsh-token-meter: each durable
 * Assistant settlement reports its usage, a repeat for the same (turn, step)
 * replaces the previous contribution, and `llm/retry-started` closes the
 * replacement slot so the retried attempt adds to the total.
 */
function foldTokenUsage(events) {
	let totals = zeroBuckets();
	let last = null;
	for (const event of events) {
		if (event.type === 'llm/retry-started') {
			if (last !== null && last.turn === event.data?.turn && last.step === event.data?.step) last = null;
			continue;
		}
		if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
		const sample = event.type === 'assistant/message' && event.data?.usage !== undefined
			? event.data.usage
			: lastStreamChunk(event.data?.stream ?? [], 'usage')?.usage;
		if (sample === undefined) continue;
		const { turn, step } = event.data;
		const buckets = bucketsFrom(sample);
		const previous = last !== null && last.turn === turn && last.step === step ? last.buckets : undefined;
		if (previous !== undefined && bucketsEqual(previous, buckets)) continue;
		const next = zeroBuckets();
		for (const key of BUCKET_KEYS) next[key] = totals[key] - (previous?.[key] ?? 0) + buckets[key];
		totals = next;
		last = { turn, step, buckets };
	}
	return totals;
}

/** Scanner totals for one parsed record, in the meter's bucket names. */
function scannedTotals(record) {
	const totals = zeroBuckets();
	for (const { samples } of Object.values(record.models)) {
		for (const sample of samples) {
			totals.uncachedInputTokens += sample.in;
			totals.outputTokens += sample.out;
			totals.cacheReadTokens += sample.cr;
			totals.cacheWriteTokens += sample.cw;
		}
	}
	return totals;
}

/** Split one log into its committed event objects, ignoring a torn tail line. */
function eventsOf(text) {
	const lines = text.split('\n');
	if (lines.length > 0 && !text.endsWith('\n')) lines.pop();
	const events = [];
	for (const line of lines) {
		if (line === '') continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			/* an unreadable committed line cannot be folded */
		}
	}
	return events;
}

/** Read the selected artifact of every session, exactly as scanAll does. */
const sessions = [];
const readErrors = [];
for (const file of listSessionFiles(home)) {
	try {
		const buffer = readFileSync(file.path);
		const text = file.compressed ? await decompressLog(buffer) : buffer.toString('utf8');
		sessions.push({ file, text });
	} catch (error) {
		readErrors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
console.log(`selected ${sessions.length} session logs (${readErrors.length} unreadable)`);
for (const error of readErrors) console.error(`  read error ${error}`);

let failures = 0;

// --- 1. live fold check ------------------------------------------------------
const byId = new Map();
let folded = 0;
for (const { file, text } of sessions) {
	const record = parseSession(text);
	if (record.id !== null) byId.set(record.id, { file, record });
	const expected = foldTokenUsage(eventsOf(text));
	const got = scannedTotals(record);
	folded += 1;
	if (bucketsEqual(expected, got)) continue;
	failures += 1;
	const label = record.id ?? file.path;
	const diff = BUCKET_KEYS
		.filter((key) => expected[key] !== got[key])
		.map((key) => `${key}: scanned=${got[key]} meter=${expected[key]} (diff ${got[key] - expected[key]})`)
		.join('; ');
	console.error(`FAIL fold ${label} [v${file.version}]: ${diff}`);
}
console.log(`fold check: ${folded - failures}/${folded} logs match the token meter`);

// --- 2. frozen projcache snapshot check -------------------------------------
const projcachePath = join(home, 'storages', 'session_projcache.json');
if (!existsSync(projcachePath)) {
	console.log('snapshot check: skipped (no storages/session_projcache.json)');
} else {
	const cache = JSON.parse(readFileSync(projcachePath, 'utf8'));
	const snapshots = cache?.tables?.sessions ?? {};
	// The cache file's own mtime bounds how current its totals can be.
	const snapshottedAt = statSync(projcachePath).mtimeMs;
	let pass = 0;
	let skipped = 0;
	let snapshotFailures = 0;
	for (const [sessionId, table] of Object.entries(snapshots)) {
		const expected = table?.rows?.tokenUsage?.val?.totals;
		if (expected === undefined) continue;
		const entry = byId.get(sessionId);
		if (entry === undefined) {
			snapshotFailures += 1;
			console.error(`FAIL snapshot ${sessionId}: not scanned (missing log file?)`);
			continue;
		}
		if (entry.file.mtimeMs > snapshottedAt) {
			skipped += 1;
			continue;
		}
		const got = scannedTotals(entry.record);
		const fields = [
			['uncachedInputTokens', expected.uncachedInputTokens],
			['outputTokens', expected.outputTokens],
			['cacheReadTokens', expected.cacheReadTokens],
			['cacheWriteTokens', expected.cacheWriteTokens],
		];
		let ok = true;
		for (const [key, want] of fields) {
			if (got[key] === want) continue;
			ok = false;
			snapshotFailures += 1;
			console.error(`FAIL snapshot ${sessionId}: ${key} scanned=${got[key]} expected=${want} (diff ${got[key] - want})`);
		}
		if (ok) pass += 1;
	}
	failures += snapshotFailures;
	console.log(`snapshot check: ${pass} passed, ${skipped} skipped (log newer than the snapshot), ${snapshotFailures} failed, ${Object.keys(snapshots).length} cached`);
}

// --- 3. generation-selection regression -------------------------------------
const fixture = mkdtempSync(join(tmpdir(), 'cost-dashboard-generations-'));
try {
	const makeSession = (project, session, names) => {
		const dir = join(fixture, 'sessions', project, session);
		mkdirSync(dir, { recursive: true });
		for (const name of names) writeFileSync(join(dir, name), '{}\n');
		return dir;
	};
	makeSession('--migrated--', 'session-a', ['session.lock', 'session.jsonl.zstd', 'session.v3.jsonl.zstd']);
	makeSession('--plaintext--', 'session-b', ['session.jsonl']);
	makeSession('--v1--', 'session-c', ['session.v1.jsonl.zstd']);
	makeSession('--empty--', 'session-d', ['session.lock', 'session.migration.abc123.tmp']);
	const picked = new Map(listSessionFiles(fixture).map((file) => [file.path, file]));
	const checks = [
		['highest generation wins', join(fixture, 'sessions', '--migrated--', 'session-a', 'session.v3.jsonl.zstd'), 3],
		['unversioned generation is v0', join(fixture, 'sessions', '--plaintext--', 'session-b', 'session.jsonl'), 0],
		['v1 is selected when it is the only generation', join(fixture, 'sessions', '--v1--', 'session-c', 'session.v1.jsonl.zstd'), 1],
	];
	for (const [label, path, version] of checks) {
		const file = picked.get(path);
		if (file?.version === version) {
			console.log(`pass selection: ${label}`);
			continue;
		}
		failures += 1;
		console.error(`FAIL selection: ${label} (picked ${file === undefined ? 'nothing' : file.path})`);
	}
	const stray = [...picked.keys()].filter((path) => path.includes('session-d') || path.includes('migration'));
	if (stray.length > 0) {
		failures += 1;
		console.error(`FAIL selection: non-artifact files were scanned: ${stray.join(', ')}`);
	} else {
		console.log('pass selection: locks and migration temporaries are ignored');
	}
} finally {
	rmSync(fixture, { recursive: true, force: true });
}

// --- 4. pricing-table and peak-window check ---------------------------------
// DeepSeek 模型 & 价格: CNY per 1M tokens, idle is half of peak, peak applies on
// weekdays 09:00-12:00 / 14:00-18:00 Beijing time only.
const OFFICIAL_DEEPSEEK = {
	'deepseek-flash': { input: 1, inputHit: 0.02, output: 4, peak: { input: 2, inputHit: 0.04, output: 8 } },
	'deepseek-v4-pro': { input: 4.5, inputHit: 0.15, output: 13.5, peak: { input: 9, inputHit: 0.3, output: 27 } },
};
const RETIRED_ALIASES = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash-expires-on-0910'];
for (const [name, expected] of Object.entries(OFFICIAL_DEEPSEEK)) {
	const entry = BUILTIN_PRICING.models[name];
	const problems = [];
	if (entry === undefined) problems.push('missing');
	else {
		if (entry.currency !== 'CNY') problems.push(`currency=${entry.currency}`);
		for (const key of ['input', 'inputHit', 'output']) if (entry[key] !== expected[key]) problems.push(`${key}=${entry[key]} want ${expected[key]}`);
		for (const key of ['input', 'inputHit', 'output']) if (entry.peak?.[key] !== expected.peak[key]) problems.push(`peak.${key}=${entry.peak?.[key]} want ${expected.peak[key]}`);
		if (JSON.stringify(entry.peakHours) !== JSON.stringify(DEFAULT_PEAK_HOURS)) problems.push(`peakHours=${JSON.stringify(entry.peakHours)}`);
		if (JSON.stringify(entry.peakWeekdays) !== JSON.stringify(DEFAULT_PEAK_WEEKDAYS)) problems.push(`peakWeekdays=${JSON.stringify(entry.peakWeekdays)}`);
	}
	if (problems.length === 0) {
		console.log(`pass pricing: ${name} matches the official CNY list price`);
	} else {
		failures += 1;
		console.error(`FAIL pricing: ${name} ${problems.join(', ')}`);
	}
}
for (const alias of RETIRED_ALIASES) {
	const entry = BUILTIN_PRICING.models[alias];
	if (entry !== undefined && entry === BUILTIN_PRICING.models['deepseek-flash']) {
		console.log(`pass pricing: retired name ${alias} bills at Flash rates`);
	} else {
		failures += 1;
		console.error(`FAIL pricing: retired name ${alias} is not priced as Flash`);
	}
}

// One million tokens of each bucket: peak 2 + 0.04 + 8 = 10.04, idle 1 + 0.02 + 4 = 5.02.
const FLASH_SAMPLE = { in: 1e6, cr: 1e6, cw: 0, out: 1e6 };
/** Beijing-time wall clock to epoch ms; the dates below are 2026-09-21 (Mon) and 2026-09-19 (Sat). */
const beijing = (day, hour) => Date.UTC(2026, 8, day, hour - 8);
const flash = BUILTIN_PRICING.models['deepseek-flash'];
const windowChecks = [
	['weekday 10:00 Beijing is peak', beijing(21, 10), 10.04],
	['weekday 13:00 Beijing is idle', beijing(21, 13), 5.02],
	['weekday 15:00 Beijing is peak', beijing(21, 15), 10.04],
	['weekday 19:00 Beijing is idle', beijing(21, 19), 5.02],
	['Saturday 10:00 Beijing is idle all day', beijing(19, 10), 5.02],
];
for (const [label, time, expected] of windowChecks) {
	const amount = sampleCost(flash, { ...FLASH_SAMPLE, t: time }).amount;
	if (Math.abs(amount - expected) < 1e-9) {
		console.log(`pass peak window: ${label}`);
	} else {
		failures += 1;
		console.error(`FAIL peak window: ${label} - got ${amount}, want ${expected}`);
	}
}
// A statutory holiday must bill at idle rates even inside a weekday peak window.
const holiday = normalizeEntry({ ...flash, peakExcludeDates: ['2026-09-21'] });
const holidayAmount = holiday === null ? null : sampleCost(holiday, { ...FLASH_SAMPLE, t: beijing(21, 10) }).amount;
if (holidayAmount === 5.02) {
	console.log('pass peak window: peakExcludeDates forces idle rates');
} else {
	failures += 1;
	console.error(`FAIL peak window: peakExcludeDates ignored (got ${holidayAmount})`);
}
if (normalizeEntry({ ...flash, peakWeekdays: [7] }) === null && normalizeEntry({ ...flash, peakExcludeDates: ['2026/09/21'] }) === null) {
	console.log('pass pricing: invalid peakWeekdays/peakExcludeDates are rejected');
} else {
	failures += 1;
	console.error('FAIL pricing: invalid peakWeekdays/peakExcludeDates were accepted');
}

console.log(failures === 0 ? '\nOK: accounting matches the token meter, the snapshot and the price list' : `\n${failures} mismatch(es)`);
process.exit(failures > 0 ? 1 : 0);
