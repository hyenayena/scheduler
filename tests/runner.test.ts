import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import type {CommandBridge, CommandRunRequest, CommandRunResult} from '../../../src/api.js';
import type {ActivityReport} from '../src/deps/core.js';
import {noopLog} from '../src/log.js';
import {createLeaderLock, createRunner, runSh, type RunSh} from '../src/runner.js';
import {type Job, readJobs, readRuns, updateJobs} from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'scheduler-runner-'));
after(() => rmSync(root, {recursive: true, force: true}));
let n = 0;
const dir = () => path.join(root, `d${n++}`);

const job = (over: Partial<Job> & Pick<Job, 'id' | 'action' | 'schedule' | 'next'>): Job => ({when: 'test', createdAt: 0, runs: 0, by: 'user', ...over});
const put = (dataDir: string, jobs: Job[]) =>
	updateJobs(dataDir, s => {
		s.jobs = jobs;
		s.nextId = Math.max(...jobs.map(j => j.id)) + 1;
	});

const fakeBridge = (answer: (req: CommandRunRequest) => Partial<CommandRunResult> = () => ({})) => {
	const runs: CommandRunRequest[] = [];
	const bridge: CommandBridge = {
		list: () => [],
		run: async req => {
			runs.push(req);
			return {status: 'ok', output: 'done', truncated: false, ms: 5, ...answer(req)};
		},
	};
	return {bridge, runs};
};

describe('runner', () => {
	it('runs due jobs once: a console line through the bridge (pre-approved), a script through sh', async () => {
		const dataDir = dir();
		let now = 1_000_000;
		const scripts: string[] = [];
		const sh: RunSh = async script => (scripts.push(script), {code: 0, output: 'hi\n', timedOut: false});
		put(dataDir, [
			job({id: 1, action: {kind: 'cmd', line: 'task list'}, schedule: {kind: 'every', everyMs: 60_000, anchor: 940_000}, next: 1_000_000}),
			job({id: 2, action: {kind: 'sh', script: 'echo hi'}, schedule: {kind: 'once', at: 999_000}, next: 999_000}),
			job({id: 3, action: {kind: 'sh', script: 'later'}, schedule: {kind: 'once', at: 2_000_000}, next: 2_000_000}),
			job({id: 4, action: {kind: 'sh', script: 'paused'}, schedule: {kind: 'once', at: 1}, next: 1, paused: true}),
		]);
		const {bridge, runs} = fakeBridge();
		const notes: string[] = [];
		const r = createRunner({dataDir, cwd: '/', log: noopLog, bridge: () => bridge, notify: t => notes.push(t), now: () => now, runSh: sh});
		await r.tick();
		await new Promise(res => setImmediate(res));
		assert.ok(r.leader);
		assert.deepEqual(runs.map(x => x.line), ['task list']);
		assert.equal(runs[0]!.caller, 'scheduler');
		assert.equal(await runs[0]!.confirm!({line: 'task list', command: 'task', caller: 'scheduler'}), true);
		assert.deepEqual(scripts, ['echo hi']);
		const {jobs} = readJobs(dataDir);
		assert.deepEqual(jobs.map(j => j.id), [1, 3, 4], 'the one-time job is done');
		const recurring = jobs.find(j => j.id === 1)!;
		assert.deepEqual([recurring.next, recurring.runs, recurring.lastStatus], [1_060_000, 1, 'ok']);
		assert.deepEqual(readRuns(dataDir).map(x => [x.id, x.status]), [[1, 'ok'], [2, 'ok']]);
		assert.ok(notes.some(t => t === '[scheduler] #2 (sh): ok in 0.0 s; done'));
		now = 1_000_000 + 10 * 60_000 + 30_000;
		await r.tick();
		assert.equal(runs.length, 2);
		assert.equal(readJobs(dataDir).jobs.find(j => j.id === 1)!.next, 1_000_000 + 11 * 60_000);
		r.stop();
	});

	it('waits for the console, retries when it is busy and records failures', async () => {
		const dataDir = dir();
		const now = 5_000_000;
		put(dataDir, [job({id: 1, action: {kind: 'cmd', line: 'x'}, schedule: {kind: 'every', everyMs: 60_000, anchor: 0}, next: now})]);
		let current: CommandBridge | undefined;
		const r = createRunner({dataDir, cwd: '/', log: noopLog, bridge: () => current, notify: () => {}, now: () => now});
		await r.tick();
		assert.equal(readJobs(dataDir).jobs[0]!.next, now, 'no console yet: still due');
		current = fakeBridge(() => ({status: 'busy'})).bridge;
		await r.tick();
		assert.equal(readJobs(dataDir).jobs[0]!.next, now + 30_000);
		assert.deepEqual(readRuns(dataDir), []);
		updateJobs(dataDir, s => void (s.jobs[0]!.next = now));
		current = fakeBridge(() => ({status: 'denied', reason: 'this command is not available to assistants'})).bridge;
		await r.tick();
		const [run] = readRuns(dataDir);
		assert.deepEqual([run!.status, run!.note], ['refused', 'this command is not available to assistants']);
		assert.equal(readJobs(dataDir).jobs[0]!.lastStatus, 'refused');
		r.stop();
	});

	it("runs the console lines of an assistant's or an old job without approval and records refusals", async () => {
		const dataDir = dir();
		const now = 6_000_000;
		const every = {kind: 'every', everyMs: 60_000, anchor: 0} as const;
		put(dataDir, [
			job({id: 1, action: {kind: 'cmd', line: 'task list'}, schedule: every, next: now, by: 'assistant'}),
			job({id: 2, action: {kind: 'cmd', line: 'task new x'}, schedule: every, next: now, by: 'legacy'}),
		]);
		const {bridge, runs} = fakeBridge(req => (req.line === 'task new x' ? {status: 'declined', reason: 'this caller cannot ask the user'} : {}));
		const r = createRunner({dataDir, cwd: '/', log: noopLog, bridge: () => bridge, notify: () => {}, now: () => now});
		await r.tick();
		assert.deepEqual(runs.map(x => [x.line, x.confirm]), [['task list', undefined], ['task new x', undefined]]);
		assert.deepEqual(readRuns(dataDir).map(x => [x.id, x.status, x.note]), [[1, 'ok', undefined], [2, 'refused', 'this caller cannot ask the user']]);
		const {jobs} = readJobs(dataDir);
		assert.deepEqual(jobs.map(j => [j.lastStatus, j.paused ?? false]), [['ok', false], ['refused', false]]);
		r.stop();
	});

	it('refuses the scripts of an assistant or an old job without running them, and pauses a repeating one', async () => {
		const dataDir = dir();
		const now = 7_000_000;
		put(dataDir, [
			job({id: 1, action: {kind: 'sh', script: 'rm -rf x'}, schedule: {kind: 'every', everyMs: 60_000, anchor: 0}, next: now, by: 'legacy'}),
			job({id: 2, action: {kind: 'sh', script: 'echo y'}, schedule: {kind: 'once', at: now}, next: now, by: 'assistant'}),
		]);
		const scripts: string[] = [];
		const sh: RunSh = async script => (scripts.push(script), {code: 0, output: '', timedOut: false});
		const notes: string[] = [];
		const r = createRunner({dataDir, cwd: '/', log: noopLog, bridge: () => undefined, notify: t => notes.push(t), now: () => now, runSh: sh});
		await r.tick();
		await new Promise(res => setImmediate(res));
		assert.deepEqual(scripts, []);
		const runs = readRuns(dataDir);
		assert.deepEqual(runs.map(x => [x.id, x.status]), [[1, 'refused'], [2, 'refused']]);
		assert.ok(runs.every(x => x.note === 'only the user can schedule scripts; add it again yourself'));
		const {jobs} = readJobs(dataDir);
		assert.deepEqual(jobs.map(j => [j.id, j.paused, j.lastStatus]), [[1, true, 'refused']], 'the one-time job is removed');
		assert.ok(notes.some(t => t.startsWith('[scheduler] #1 (sh): refused') && t.endsWith('; paused')));
		assert.ok(notes.some(t => t.startsWith('[scheduler] #2 (sh): refused') && t.endsWith('; done')));
		r.stop();
	});

	it('only one process runs jobs: a live holder keeps the lock, a dead one loses it', () => {
		const dataDir = dir();
		const a = createLeaderLock(dataDir);
		assert.equal(a.acquire(), true);
		writeFileSync(path.join(dataDir, 'runner.lock'), JSON.stringify({pid: 1}));
		const b = createLeaderLock(dataDir);
		assert.equal(b.acquire(), false, 'pid 1 is alive');
		writeFileSync(path.join(dataDir, 'runner.lock'), JSON.stringify({pid: 2 ** 22 + 7}));
		assert.equal(b.acquire(), true, 'a dead holder is replaced');
		b.release();
		assert.equal(existsSync(path.join(dataDir, 'runner.lock')), false);
	});

	it('the real sh runner captures output, reports the exit code, times out and drops credentials', async () => {
		process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-SHOULDNOTLEAK';
		try {
			const ok = await runSh('echo out; echo err >&2; echo "key=${ANTHROPIC_API_KEY:-none}"', {cwd: root, timeoutMs: 5000});
			assert.deepEqual([ok.code, ok.timedOut], [0, false]);
			assert.match(ok.output, /out/);
			assert.match(ok.output, /err/);
			assert.match(ok.output, /key=none/);
			assert.equal((await runSh('exit 3', {cwd: root, timeoutMs: 5000})).code, 3);
			const slow = await runSh('sleep 5', {cwd: root, timeoutMs: 200});
			assert.equal(slow.timedOut, true);
		} finally {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	it('a broken jobs file is set aside, not overwritten', () => {
		const dataDir = dir();
		put(dataDir, [job({id: 1, action: {kind: 'sh', script: 'x'}, schedule: {kind: 'once', at: 1}, next: 1})]);
		writeFileSync(path.join(dataDir, 'jobs.json'), '{broken');
		assert.deepEqual(readJobs(dataDir).jobs, []);
		const aside = readdirSync(dataDir).find(f => f.startsWith('jobs.json.broken-'));
		assert.ok(aside);
		assert.equal(readFileSync(path.join(dataDir, aside), 'utf8'), '{broken');
	});

	it('reports activity per job without the line or script, and a busy delay as gone', async () => {
		const dataDir = dir();
		put(dataDir, [
			job({id: 1, name: 'nightly', action: {kind: 'cmd', line: 'secret line'}, schedule: {kind: 'once', at: 1}, next: 1}),
			job({id: 2, action: {kind: 'sh', script: 'secret script'}, schedule: {kind: 'once', at: 1}, next: 1}),
			job({id: 3, action: {kind: 'sh', script: 'false'}, schedule: {kind: 'once', at: 1}, next: 1}),
			job({id: 4, action: {kind: 'cmd', line: 'busy line'}, schedule: {kind: 'every', everyMs: 60_000, anchor: 0}, next: 1}),
		]);
		const reports: ActivityReport[] = [];
		const sh: RunSh = async script => ({code: script === 'false' ? 1 : 0, output: '', timedOut: false});
		const {bridge} = fakeBridge(req => (req.line === 'busy line' ? {status: 'busy'} : {}));
		const r = createRunner({dataDir, cwd: '/', log: noopLog, bridge: () => bridge, notify: () => {}, now: () => 1_000_000, runSh: sh, activity: x => void reports.push(x)});
		await r.tick();
		await new Promise(resolve => setTimeout(resolve, 50));
		const of = (id: string) => reports.filter(x => x.id === id).map(x => x.state);
		assert.deepEqual(of('job-1'), ['running', 'ok']);
		assert.deepEqual(of('job-2'), ['running', 'ok']);
		assert.deepEqual(of('job-3'), ['running', 'failed']);
		assert.deepEqual(of('job-4'), ['running', 'gone']);
		assert.equal(reports.find(x => x.id === 'job-1')?.label, 'job #1 nightly');
		assert.ok(reports.every(x => x.source === 'scheduler' && !/secret|busy line/.test(x.label)));
		const quiet = createRunner({dataDir: dir(), cwd: '/', log: noopLog, bridge: () => bridge, notify: () => {}});
		await quiet.tick();
	});
});
