#!/usr/bin/env node
/**
 * One-shot verification: compare dsh-cost-dashboard's per-session token
 * accounting against the official session_projcache.json tokenUsage totals
 * (folded by @deepseek-ai/dsh-token-meter).
 *
 * Usage: node scripts/verify-totals.mjs
 * Exit 0 when every cached session matches; 1 otherwise.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAll, dshHome } from '../scan.mjs';

const home = dshHome();
const projcachePath = join(home, 'storages', 'session_projcache.json');
const projcache = JSON.parse(readFileSync(projcachePath, 'utf8'));

const { records, errors } = await scanAll(home, new Map());
if (errors.length > 0) {
	console.error('scan errors (these sessions cannot be compared):');
	for (const error of errors) console.error('  ' + error);
}

const scanned = new Map();
for (const record of records) {
	const totals = { in: 0, cr: 0, cw: 0, out: 0 };
	for (const { samples } of Object.values(record.models)) {
		for (const sample of samples) {
			totals.in += sample.in;
			totals.cr += sample.cr;
			totals.cw += sample.cw;
			totals.out += sample.out;
		}
	}
	scanned.set(record.id, totals);
}

let pass = 0;
let fail = 0;
const sessions = projcache?.tables?.sessions ?? {};
for (const [sessionId, table] of Object.entries(sessions)) {
	const expected = table?.rows?.tokenUsage?.val?.totals;
	if (expected === undefined) continue;
	const got = scanned.get(sessionId);
	if (got === undefined) {
		fail += 1;
		console.error(`FAIL ${sessionId}: not scanned (missing log file?)`);
		continue;
	}
	const fields = [
		['in', expected.uncachedInputTokens],
		['out', expected.outputTokens],
		['cr', expected.cacheReadTokens],
		['cw', expected.cacheWriteTokens],
	];
	let ok = true;
	for (const [key, want] of fields) {
		if (got[key] !== want) {
			ok = false;
			fail += 1;
			console.error(`FAIL ${sessionId}: ${key} scanned=${got[key]} expected=${want} (diff ${got[key] - want})`);
		}
	}
	if (ok) {
		pass += 1;
		console.log(`pass ${sessionId}: in=${got.in} cr=${got.cr} cw=${got.cw} out=${got.out}`);
	}
}

const extra = [...scanned.keys()].filter((id) => sessions[id]?.rows?.tokenUsage?.val?.totals !== undefined === false);
console.log(`\n${pass} passed, ${fail} failed, ${scanned.size} scanned, ${Object.keys(sessions).length} in projcache`);
process.exit(fail > 0 ? 1 : 0);
