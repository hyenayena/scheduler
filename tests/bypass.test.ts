import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import type {CommandBridge, CommandContext, CommandInfo, CommandRunRequest} from '../../../src/api.js';
import {createSchedulerCommand} from '../src/commands.js';
import plugin from '../src/index.js';
import {noopLog} from '../src/log.js';
import {createRunner} from '../src/runner.js';
import {readJobs, updateJobs} from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'scheduler-bypass-'));
after(() => rmSync(root, {recursive: true, force: true}));
let n = 0;
const dir = () => path.join(root, `d${n++}`);

const catalog = (task: 'safe' | 'confirm'): CommandInfo[] => [
	{name: 'task', description: '', policy: task, subcommands: [{name: 'list', aliases: ['ls'], usage: '', description: '', policy: task}]},
	{name: 'scheduler', description: '', policy: 'confirm', subcommands: [{name: 'add', aliases: ['a'], usage: '', description: '', policy: 'confirm'}]},
	{name: 'account', description: '', policy: 'safe', subcommands: [{name: 'grant', aliases: ['g'], usage: '', description: '', policy: 'deny'}]},
];
const bridgeOf = (list: CommandInfo[]): CommandBridge => ({list: () => list, run: async () => ({status: 'ok', output: '', truncated: false, ms: 1})});
const assistant = (): Partial<CommandContext> => ({signal: new AbortController().signal});

const add = async (dataDir: string, list: CommandInfo[], other: Partial<CommandContext>, ...args: string[]) => {
	const command = createSchedulerCommand({dataDir, cwd: root, log: noopLog, runner: () => ({start() {}, stop() {}, tick: async () => {}, leader: true, running: new Set()})});
	await command.run(args, {print() {}, clear() {}, exit() {}, commandBridge: bridgeOf(list), ...other});
};

describe('scheduler policy bypass attempts', () => {
	it('judges the line the way the bridge parses it: padding, tabs and subcommand aliases', async () => {
		const dataDir = dir();
		const refuse = async (re: RegExp, who: Partial<CommandContext>, ...line: string[]) => {
			await assert.rejects(add(dataDir, catalog('safe'), who, 'add', 'in', '1m', 'cmd', ...line), re);
			assert.equal(readJobs(dataDir).jobs.length, 0);
		};
		await refuse(/Unknown command/, {}, '\tscheduler\tadd');
		await refuse(/cannot run scheduler commands/, assistant(), 'scheduler', 'a', 'in', '1m');
		await refuse(/"account grant" cannot be run/, {}, 'account', 'g', 'x');
		await refuse(/"account grant" cannot be run/, assistant(), 'account', 'g', 'x');
		await refuse(/Unknown command "Scheduler"/, {}, 'Scheduler', 'add');
		await refuse(/Unknown command "TASK"/, assistant(), 'TASK', 'list');
		await add(dataDir, catalog('safe'), assistant(), 'add', 'in', '1m', 'cmd', 'task', 'ls');
		assert.equal(readJobs(dataDir).jobs[0]!.by, 'assistant');
	});

	it('an assistant adds nothing when the console asks for every command (ask mode lists safe as confirm)', async () => {
		const dataDir = dir();
		await assert.rejects(add(dataDir, catalog('confirm'), assistant(), 'add', 'in', '1m', 'cmd', 'task', 'list'), /needs the user's approval/);
		assert.equal(readJobs(dataDir).jobs.length, 0);
		await add(dataDir, catalog('confirm'), {}, 'add', 'in', '1m', 'cmd', 'task', 'list');
		assert.equal(readJobs(dataDir).jobs[0]!.by, 'user');
	});

	it('the author cannot be set through the arguments', async () => {
		const dataDir = dir();
		await add(dataDir, catalog('safe'), assistant(), 'add', '--name', 'by-user', 'in', '1m', 'cmd', 'task', 'list');
		await assert.rejects(add(dataDir, catalog('safe'), assistant(), 'add', 'in', '1m', 'sh', 'by:user'), /cannot schedule shell scripts/);
		assert.deepEqual(readJobs(dataDir).jobs.map(j => j.by), ['assistant']);
	});

	it('a stored author that is not exactly user or assistant counts as legacy', () => {
		const dataDir = dir();
		mkdirSync(dataDir, {recursive: true});
		const base = {schedule: {kind: 'once', at: 1}, when: 'x', action: {kind: 'sh', script: 'id'}, next: 1, createdAt: 1, runs: 0};
		const forged = [' user', 'USER', true, null, ['user'], {by: 'user'}].map((by, i) => ({...base, id: i + 1, by}));
		writeFileSync(path.join(dataDir, 'jobs.json'), JSON.stringify({v: 1, nextId: 9, jobs: forged}));
		assert.deepEqual(readJobs(dataDir).jobs.map(j => j.by), forged.map(() => 'legacy'));
	});
});

describe('scheduler run time', () => {
	const job = (id: number, by: 'user' | 'assistant' | 'legacy', line: string) => ({
		id,
		schedule: {kind: 'every' as const, everyMs: 60_000, anchor: 0},
		when: 'every 1m',
		action: {kind: 'cmd' as const, line},
		next: 1000,
		createdAt: 0,
		runs: 0,
		by,
	});

	it('gives only the jobs of the user a pre-approval, and records a refusal for the others', async () => {
		const dataDir = dir();
		updateJobs(dataDir, s => {
			s.jobs = [job(1, 'user', 'task new'), job(2, 'assistant', 'task new'), job(3, 'legacy', 'task new')];
			s.nextId = 4;
		});
		const seen: CommandRunRequest[] = [];
		const bridge: CommandBridge = {
			list: () => [],
			run: async req => {
				seen.push(req);
				return req.confirm ? {status: 'ok', output: '', truncated: false, ms: 1} : {status: 'declined', output: '', truncated: false, ms: 1, reason: 'this caller cannot ask the user'};
			},
		};
		const r = createRunner({dataDir, cwd: '/', log: noopLog, bridge: () => bridge, notify: () => {}, now: () => 2000});
		await r.tick();
		await new Promise(res => setImmediate(res));
		await new Promise(res => setImmediate(res));
		r.stop();
		assert.deepEqual(seen.map(x => typeof x.confirm), ['function', 'undefined', 'undefined']);
		assert.deepEqual(readJobs(dataDir).jobs.map(j => [j.id, j.lastStatus, j.paused ?? false]), [[1, 'ok', false], [2, 'refused', false], [3, 'refused', false]]);
	});

	it('maps a denied line to refused, even for the user', async () => {
		const dataDir = dir();
		updateJobs(dataDir, s => {
			s.jobs = [job(1, 'user', 'claude auth login')];
			s.nextId = 2;
		});
		const bridge: CommandBridge = {list: () => [], run: async () => ({status: 'denied', output: '', truncated: false, ms: 1})};
		const r = createRunner({dataDir, cwd: '/', log: noopLog, bridge: () => bridge, notify: () => {}, now: () => 2000});
		await r.tick();
		await new Promise(res => setImmediate(res));
		await new Promise(res => setImmediate(res));
		r.stop();
		assert.equal(readJobs(dataDir).jobs[0]!.lastStatus, 'refused');
	});
});

describe('scheduler plugin working directory', () => {
	const load = async (build: unknown) => {
		const dataDir = dir();
		const list = await plugin({dataDir, events: {emit() {}, on: () => () => {}}, log: undefined as never, build} as never);
		return {dataDir, command: list[0]!};
	};

	it('registers with and without build info', async () => {
		for (const build of [undefined, {root: {path: '/somewhere'}}, {}]) {
			const {command} = await load(build);
			assert.equal(command.name, 'scheduler');
		}
	});
});
