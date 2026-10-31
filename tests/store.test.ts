import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {readJobs, updateJobs} from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'scheduler-store-'));
after(() => rmSync(root, {recursive: true, force: true}));

const stored = (id: number, extra: Record<string, unknown>) => ({
	id,
	schedule: {kind: 'once', at: 1},
	when: 'in 1m',
	action: {kind: 'cmd', line: 'task list'},
	next: 1,
	createdAt: 1,
	runs: 0,
	...extra,
});

describe('store', () => {
	it('reads a job without a known author as legacy and keeps the author and a refused status', () => {
		const dataDir = path.join(root, 'a');
		mkdirSync(dataDir, {recursive: true});
		const jobs = [stored(1, {}), stored(2, {by: 'root'}), stored(3, {by: 'user', lastStatus: 'refused'}), stored(4, {by: 'assistant'})];
		writeFileSync(path.join(dataDir, 'jobs.json'), JSON.stringify({v: 1, nextId: 5, jobs}));
		assert.deepEqual(readJobs(dataDir).jobs.map(j => j.by), ['legacy', 'legacy', 'user', 'assistant']);
		updateJobs(dataDir, () => {});
		const again = readJobs(dataDir).jobs;
		assert.deepEqual(again.map(j => j.by), ['legacy', 'legacy', 'user', 'assistant']);
		assert.equal(again[2]!.lastStatus, 'refused');
	});
});
