import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import type {CommandBridge, CommandContext, CommandInfo} from '../../../src/api.js';
import {createSchedulerCommand} from '../src/commands.js';
import {noopLog} from '../src/log.js';
import plugin from '../src/index.js';
import type {Runner} from '../src/runner.js';
import {readJobs} from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'scheduler-cmd-'));
after(() => rmSync(root, {recursive: true, force: true}));
let n = 0;

const NOW = new Date(2026, 9, 24, 12, 0).getTime();
const commands: CommandInfo[] = [
	{name: 'task', description: '', policy: 'safe', subcommands: [{name: 'list', aliases: ['ls'], usage: '', description: '', policy: 'safe'}]},
	{name: 'claude', description: '', policy: 'deny', subcommands: [{name: 'start', aliases: [], usage: '', description: '', policy: 'confirm'}]},
	{name: 'chat', description: '', policy: 'deny', subcommands: []},
];
const bridge: CommandBridge = {list: () => commands, run: async () => ({status: 'ok', output: '', truncated: false, ms: 1})};

const setup = () => {
	const dataDir = path.join(root, `d${n++}`);
	let started = 0;
	let ticks = 0;
	const fakeRunner = (): Runner => ({start: () => void started++, stop() {}, tick: async () => void ticks++, leader: true, running: new Set()});
	const command = createSchedulerCommand({dataDir, cwd: root, log: noopLog, now: () => NOW, runner: fakeRunner});
	const printed: string[] = [];
	const ctx: CommandContext = {print: t => void printed.push(t), clear() {}, exit() {}, commandBridge: bridge};
	const run = async (...args: string[]) => {
		printed.length = 0;
		await command.run(args, ctx);
		return printed.join('\n');
	};
	return {dataDir, run, started: () => started, ticks: () => ticks};
};

describe('scheduler command', () => {
	it('starts the runner on its first call (the autostart) and says nothing while nothing is scheduled', async () => {
		const s = setup();
		assert.equal(await s.run(), '');
		assert.equal(s.started(), 1);
		assert.equal(await s.run(), 'Nothing is scheduled.');
		assert.equal(s.started(), 1);
	});

	it('starts no runner in a headless run, works on the store, and refuses run', async () => {
		const s = setup();
		const printed: string[] = [];
		const ctx: CommandContext = {print: t => void printed.push(t), clear() {}, exit() {}, commandBridge: bridge, headless: true};
		const command = createSchedulerCommand({dataDir: s.dataDir, cwd: root, log: noopLog, now: () => NOW, runner: () => assert.fail('runner created')});
		await command.run(['add', 'in', '10m', 'cmd', 'task', 'list'], ctx);
		await command.run(['list'], ctx);
		assert.match(printed.join('\n'), /Scheduled #1/);
		assert.equal(readJobs(s.dataDir).jobs.length, 1);
		await assert.rejects(async () => command.run(['run', '1'], ctx), /needs the app/);
	});

	it('adds console lines and scripts with any schedule, and lists them by next run', async () => {
		const s = setup();
		assert.match(await s.run('add', 'every', '1h', 'cmd', 'task', 'list'), /^Scheduled #1: first run 2026-10-24 13:00.* \(then every 1h\)\.$/);
		assert.match(await s.run('add', '--name', 'backup', 'in', '10m', 'sh', 'tar', 'czf', '/tmp/x.tgz', 'data'), /^Scheduled #2 backup: first run 2026-10-24 12:10/);
		assert.match(await s.run('add', 'cron', '0', '9', '*', '*', 'mon-fri', 'cmd', 'claude', 'start', 'Morning', 'summary', 'please'), /^Scheduled #3: .* \(then by its cron schedule\)/);
		const {jobs} = readJobs(s.dataDir);
		assert.deepEqual(jobs.map(j => j.action), [
			{kind: 'cmd', line: 'task list'},
			{kind: 'sh', script: 'tar czf /tmp/x.tgz data'},
			{kind: 'cmd', line: 'claude start Morning summary please'},
		]);
		const list = (await s.run('list')).split('\n');
		assert.match(list[0]!, /^#2 backup {2}in 10m {2}next 2026-10-24 12:10/);
		assert.match(list[1]!, /^#1 {2}every 1h/);
	});

	it('refuses lines the console would not run for an assistant, scheduler lines and bad input', async () => {
		const s = setup();
		await s.run();
		await assert.rejects(s.run('add', 'in', '1m', 'cmd', 'chat'), /cannot be run by the scheduler/);
		await assert.rejects(s.run('add', 'in', '1m', 'cmd', 'nope'), /Unknown command "nope"/);
		await assert.rejects(s.run('add', 'in', '1m', 'cmd', 'scheduler', 'list'), /cannot run scheduler commands/);
		await assert.rejects(s.run('add', 'in', '1m', 'ls'), /After the schedule comes "cmd/);
		await assert.rejects(s.run('add', 'in', '1m', 'sh'), /After the schedule comes "cmd/);
		await assert.rejects(s.run('add'), /Usage: scheduler add/);
		await assert.rejects(s.run('add', '--name', 'a b'), /job name/);
		await s.run('add', '--name', 'x', 'in', '1m', 'sh', 'true');
		await assert.rejects(s.run('add', '--name', 'x', 'in', '1m', 'sh', 'true'), /already named "x"/);
		assert.equal(readJobs(s.dataDir).jobs.length, 1);
	});

	it('pauses, resumes, runs now, shows and removes', async () => {
		const s = setup();
		await s.run('add', 'every', '1d', 'sh', 'echo', 'hi');
		assert.equal(await s.run('pause', '1'), 'Paused #1.');
		assert.match(await s.run('list'), /#1 {2}every 1d {2}paused/);
		assert.match(await s.run('resume', '#1'), /^Resumed #1; next run 2026-10-25 12:00/);
		assert.equal(await s.run('run', '1'), '#1 runs now.');
		assert.equal(readJobs(s.dataDir).jobs[0]!.next, NOW);
		assert.equal(s.ticks(), 1);
		assert.match(await s.run('show', '1'), /script: echo hi/);
		assert.equal(await s.run('log'), 'No runs yet.');
		assert.equal(await s.run('remove', '1'), 'Removed #1.');
		await assert.rejects(s.run('remove', '1'), /No job #1/);
		await assert.rejects(s.run('show', 'x'), /Usage: scheduler show <id>/);
		await assert.rejects(s.run('nope'), /Unknown subcommand: nope/);
	});

	it('policies: reading is safe, every change asks the user when an assistant does it', () => {
		const command = createSchedulerCommand({dataDir: path.join(root, 'p'), cwd: root, log: noopLog});
		const policy = Object.fromEntries(command.subcommands!.map(s => [s.name, s.agent]));
		assert.deepEqual(policy, {list: 'safe', add: 'confirm', show: 'safe', remove: 'confirm', pause: 'confirm', resume: 'confirm', run: 'confirm', log: 'safe', help: 'safe'});
		assert.equal(command.autostart, true);
	});

	it('the plugin registers the command and writes nothing at load', async () => {
		const dataDir = path.join(root, 'load');
		const list = await plugin({dataDir, events: {emit() {}, on: () => () => {}}, log: undefined as never});
		assert.deepEqual(list.map(c => c.name), ['scheduler']);
		assert.ok(!existsSync(dataDir));
	});
});
