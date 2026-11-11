import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import type {CommandBridge, CommandContext, CommandInfo, StyledBlock, StyledCell, StyledSpan} from '../../../src/api.js';
import type {EventBus} from '../../../src/api.js';
import {createSchedulerCommand} from '../src/commands.js';
import {noopLog} from '../src/log.js';
import plugin from '../src/index.js';
import type {Runner} from '../src/runner.js';
import {formatTime} from '../src/schedule.js';
import {appendRun, readJobs, updateJobs} from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'scheduler-cmd-'));
after(() => rmSync(root, {recursive: true, force: true}));
let n = 0;

const NOW = new Date(2026, 9, 24, 12, 0).getTime();
const commands: CommandInfo[] = [
	{
		name: 'task',
		description: '',
		policy: 'safe',
		subcommands: [
			{name: 'list', aliases: ['ls'], usage: '', description: '', policy: 'safe'},
			{name: 'new', aliases: [], usage: '', description: '', policy: 'confirm'},
		],
	},
	{
		name: 'claude',
		description: '',
		policy: 'deny',
		subcommands: [
			{name: 'auth', aliases: [], usage: '', description: '', policy: 'confirm', subcommands: [{name: 'login', aliases: [], usage: '', description: '', policy: 'deny'}]},
		],
	},
	{name: 'account', description: '', policy: 'safe', subcommands: [{name: 'grant', aliases: [], usage: '', description: '', policy: 'deny'}]},
	{name: 'chat', description: '', policy: 'deny', subcommands: [{name: 'start', aliases: [], usage: '', description: '', policy: 'confirm'}]},
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
	const runWith = async (other: Partial<CommandContext>, ...args: string[]) => {
		printed.length = 0;
		await command.run(args, {print: t => void printed.push(t), clear() {}, exit() {}, ...other});
		return printed.join('\n');
	};
	return {dataDir, run, runWith, started: () => started, ticks: () => ticks};
};

const assistant = (): Partial<CommandContext> => ({signal: new AbortController().signal});

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
		assert.match(await s.run('add', 'cron', '0', '9', '*', '*', 'mon-fri', 'cmd', 'chat', 'start', 'Morning', 'summary', 'please'), /^Scheduled #3: .* \(then by its cron schedule\)/);
		const {jobs} = readJobs(s.dataDir);
		assert.deepEqual(jobs.map(j => j.action), [
			{kind: 'cmd', line: 'task list'},
			{kind: 'sh', script: 'tar czf /tmp/x.tgz data'},
			{kind: 'cmd', line: 'chat start Morning summary please'},
		]);
		const list = (await s.run('list')).split('\n');
		assert.match(list[0]!, /^#2 backup {2}in 10m {2}next 2026-10-24 12:10/);
		assert.match(list[1]!, /^#1 {2}every 1h/);
		await s.run('add', 'in', '5m', 'cmd', 'task', 'new', 'two words', '--opt=a b');
		await s.run('add', 'in', '5m', 'sh', 'echo', 'two words', "it's", '');
		await s.run('add', 'in', '5m', 'sh', 'echo "a b"');
		assert.deepEqual(readJobs(s.dataDir).jobs.slice(3).map(j => j.action), [
			{kind: 'cmd', line: 'task new "two words" "--opt=a b"'},
			{kind: 'sh', script: "echo 'two words' it's ''"},
			{kind: 'sh', script: 'echo "a b"'},
		]);
	});

	it('refuses lines the console would not run for an assistant, scheduler lines and bad input', async () => {
		const s = setup();
		await s.run();
		await assert.rejects(s.run('add', 'in', '1m', 'cmd', 'chat'), /cannot be run by the scheduler/);
		await assert.rejects(s.run('add', 'in', '1m', 'cmd', 'nope'), /Unknown command "nope"/);
		await assert.rejects(s.run('add', 'in', '1m', 'cmd', 'scheduler', 'list'), /cannot run scheduler commands/);
		await assert.rejects(s.run('add', 'in', '1m', 'cmd', '"scheduler"', 'list'), /Unknown command/);
		await assert.rejects(s.run('add', 'in', '1m', 'ls'), /After the schedule comes "cmd/);
		await assert.rejects(s.run('add', 'in', '1m', 'sh'), /After the schedule comes "cmd/);
		await assert.rejects(s.run('add'), /Usage: scheduler add/);
		await assert.rejects(s.run('add', '--name', 'a b'), /job name/);
		await s.run('add', '--name', 'x', 'in', '1m', 'sh', 'true');
		await assert.rejects(s.run('add', '--name', 'x', 'in', '1m', 'sh', 'true'), /already named "x"/);
		assert.equal(readJobs(s.dataDir).jobs.length, 1);
	});

	it('the user may schedule any line but those not available to assistants, at any depth', async () => {
		const s = setup();
		await assert.rejects(s.run('add', 'in', '1m', 'cmd', 'claude', 'auth', 'login'), /"claude auth login" cannot be run by the scheduler/);
		await assert.rejects(s.run('add', 'in', '1m', 'cmd', 'account', 'grant', 'x'), /"account grant" cannot be run by the scheduler/);
		assert.equal(readJobs(s.dataDir).jobs.length, 0);
		await s.run('add', 'in', '1m', 'cmd', 'chat', 'start', 'hello');
		await s.run('add', 'in', '1m', 'cmd', 'task', 'new', 'x');
		await s.run('add', 'in', '1m', 'cmd', 'claude', 'auth');
		assert.deepEqual(readJobs(s.dataDir).jobs.map(j => [j.action.kind === 'cmd' && j.action.line, j.by]), [
			['chat start hello', 'user'],
			['task new x', 'user'],
			['claude auth', 'user'],
		]);
	});

	it('an assistant may schedule only lines it may run without asking, and no scripts', async () => {
		const s = setup();
		await s.run();
		await s.runWith(assistant(), 'add', 'in', '1m', 'cmd', 'task', 'list');
		await s.runWith(assistant(), 'add', 'in', '2m', 'cmd', 'task', 'ls');
		const refuse = async (args: string[], re: RegExp) => {
			const before = JSON.stringify(readJobs(s.dataDir));
			await assert.rejects(s.runWith(assistant(), 'add', 'in', '1m', ...args), re);
			assert.equal(JSON.stringify(readJobs(s.dataDir)), before);
		};
		await refuse(['cmd', 'task', 'new', 'x'], /"task new" needs the user's approval each time.*ask the user to add the job/);
		await refuse(['cmd', 'chat', 'start', 'hi'], /ask the user to add the job/);
		await refuse(['cmd', 'claude', 'auth', 'login'], /cannot be run by the scheduler/);
		await refuse(['cmd', 'chat'], /cannot be run by the scheduler/);
		await refuse(['cmd', 'scheduler', 'list'], /cannot run scheduler commands/);
		await refuse(['cmd', 'nope'], /Unknown command "nope"/);
		await refuse(['sh', 'echo', 'hi'], /cannot schedule shell scripts/);
		assert.deepEqual(readJobs(s.dataDir).jobs.map(j => j.by), ['assistant', 'assistant']);
	});

	it('without a catalog only the user may add console lines', async () => {
		for (const bridgeOf of [undefined, {...bridge, list: () => []}] as (CommandBridge | undefined)[]) {
			const s = setup();
			const ctx: Partial<CommandContext> = {headless: true, ...(bridgeOf && {commandBridge: bridgeOf})};
			await s.runWith(ctx, 'add', 'in', '1m', 'cmd', 'task', 'new', 'x');
			assert.equal(readJobs(s.dataDir).jobs[0]!.by, 'user');
			await assert.rejects(s.runWith({...ctx, ...assistant()}, 'add', 'in', '1m', 'cmd', 'task', 'list'), /cannot check this line yet; ask the user to add the job/);
			await assert.rejects(s.runWith(ctx, 'add', 'in', '1m', 'cmd', 'scheduler', 'list'), /cannot run scheduler commands/);
			await assert.rejects(s.runWith({...ctx, ...assistant()}, 'add', 'in', '1m', 'cmd', 'scheduler', 'list'), /cannot run scheduler commands/);
			assert.equal(readJobs(s.dataDir).jobs.length, 1);
		}
	});

	it('list and show tell the jobs of an assistant and of before 0.3.0', async () => {
		const s = setup();
		await s.run();
		await s.runWith(assistant(), 'add', 'in', '1m', 'cmd', 'task', 'list');
		await s.run('add', 'in', '2m', 'cmd', 'task', 'list');
		updateJobs(s.dataDir, state => void state.jobs.push({...state.jobs[1]!, id: 3, next: NOW + 180_000, by: 'legacy'}));
		const list = (await s.run('list')).split('\n');
		assert.match(list[0]!, /^#1 .* {2}by an assistant {2}cmd task list$/);
		assert.doesNotMatch(list[1]!, /by an assistant|before 0\.3\.0/);
		assert.match(list[2]!, /^#3 .* {2}from before 0\.3\.0 {2}cmd task list$/);
		assert.match(await s.run('show', '1'), /added 2026-10-24 12:00.* by an assistant, ran 0 times/);
		assert.match(await s.run('show', '3'), /added .* before 0\.3\.0 \(treated as an assistant's\), ran/);
		assert.doesNotMatch(await s.run('show', '2'), /by an assistant|before 0\.3\.0/);
	});

	it('prints styled blocks: list a head-less table, log a table with a head, failed runs in the error tone', async () => {
		const s = setup();
		await s.run('add', '--name', 'backup', 'every', '1h', 'sh', 'tar', 'czf', 'x');
		await s.run('add', 'in', '10m', 'cmd', 'task', 'list');
		updateJobs(s.dataDir, state => {
			state.jobs[0]!.lastStatus = 'error';
			state.jobs[1]!.paused = true;
		});
		appendRun(s.dataDir, {id: 1, at: NOW, ms: 1200, status: 'error', note: 'exit 2', output: 'boom'});
		appendRun(s.dataDir, {id: 2, at: NOW, ms: 100, status: 'refused'});
		const blocks: StyledBlock[][] = [];
		const ctx: CommandContext = {print: () => assert.fail('printed plain'), clear() {}, exit() {}, printStyled: b => void blocks.push([...b])};
		const command = createSchedulerCommand({dataDir: s.dataDir, cwd: root, log: noopLog, now: () => NOW, runner: () => ({start() {}, stop() {}, tick: async () => {}, leader: true, running: new Set()})});
		const parts = (cell: StyledCell | undefined): StyledSpan[] =>
			(Array.isArray(cell) ? cell : [cell]).map((p: string | StyledSpan | undefined) => (typeof p === 'string' ? {text: p} : (p ?? {text: ''})));
		const toneOf = (cell: StyledCell | undefined, text: string) => parts(cell).find(p => p.text === text)?.tone;

		await command.run(['list'], ctx);
		const list = blocks.pop()!;
		assert.equal(list.length, 1);
		const t = list[0]!;
		assert.ok(t.kind === 'table');
		assert.equal(t.head, undefined);
		assert.equal(t.flex, 5);
		const row = (id: string) => t.rows.find(r => parts(r[0])[0]!.text === id)!;
		assert.equal(toneOf(row('#1')[0], '#1'), 'accent');
		assert.equal(parts(row('#1')[0])[1]!.bold, true);
		assert.equal(toneOf(row('#1')[1], 'every 1h'), 'muted');
		assert.equal(toneOf(row('#1')[3], 'error'), 'error');
		assert.equal(toneOf(row('#2')[2], 'paused'), 'warn');
		assert.equal(row('#2')[3], '');

		await command.run(['log'], ctx);
		const log = blocks.pop()![0]!;
		assert.ok(log.kind === 'table');
		assert.deepEqual(log.head, ['When', 'Job', 'Status', 'Took']);
		const failed = log.rows.find(r => parts(r[1])[0]!.text === '#1')!;
		assert.equal(toneOf(failed[2], 'error'), 'error');
		assert.equal(toneOf(failed[2], ' (exit 2)'), 'muted');
		assert.equal(toneOf(failed[3], '1.2 s'), 'muted');
		assert.equal(toneOf(log.rows.find(r => parts(r[1])[0]!.text === '#2')![2], 'refused'), 'warn');

		await command.run(['show', '1'], ctx);
		const show = blocks.pop()!;
		assert.deepEqual(show.map(b => b.kind), ['line', 'line', 'line', 'line', 'text']);
		const first = show[0]!;
		assert.ok(first.kind === 'line');
		assert.equal(toneOf(first.spans, 'error'), 'error');
		const run = show[3]!;
		assert.ok(run.kind === 'line');
		assert.equal(toneOf(run.spans, 'error'), 'error');
		assert.deepEqual(show[4], {kind: 'text', text: '    boom', tone: 'muted'});
	});

	it('the plain form of show and log keeps the line texts', async () => {
		const s = setup();
		await s.run('add', 'every', '1h', 'sh', 'echo', 'hi');
		updateJobs(s.dataDir, state => void (state.jobs[0]!.lastStatus = 'timeout'));
		appendRun(s.dataDir, {id: 1, at: NOW, ms: 1200, status: 'timeout', note: 'after 60 s', output: 'a\nb'});
		const at = formatTime(NOW);
		assert.equal(
			await s.run('show', '1'),
			[`#1  every 1h  next ${formatTime(NOW + 3_600_000)} · last timeout  sh echo hi`, '  script: echo hi', `  added ${at}, ran 0 times`, `  ${at} timeout (after 60 s)`, '    a', '    b'].join('\n'),
		);
		assert.equal(await s.run('log'), `${at}  #1  timeout (after 60 s)  1.2 s`);
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
		assert.deepEqual(policy, {list: 'safe', add: 'confirm', show: 'safe', remove: 'confirm', pause: 'confirm', resume: 'confirm', run: 'confirm', log: 'safe'});
		assert.equal(command.autostart, true);
	});

	it('help goes to core through ctx.showHelp, or prints the usage without it', async () => {
		const s = setup();
		assert.equal(await s.run('help'), 'scheduler [subcommand]');
		const command = createSchedulerCommand({dataDir: path.join(root, 'h'), cwd: root, log: noopLog, runner: () => ({start() {}, stop() {}, tick: async () => {}, leader: true, running: new Set()})});
		let shown = 0;
		await command.run(['help'], {print() {}, clear() {}, exit() {}, showHelp: () => void shown++});
		assert.equal(shown, 1);
	});

	it('the plugin registers the command and writes nothing at load', async () => {
		const dataDir = path.join(root, 'load');
		const list = await plugin({dataDir, events: {emit() {}, on: () => () => {}}, log: undefined as never});
		assert.deepEqual(list.map(c => c.name), ['scheduler']);
		assert.ok(!existsSync(dataDir));
	});
});

describe('activity wiring', () => {
	it('the runner reports through the event bus', async () => {
		const sent: {topic: string; payload: unknown}[] = [];
		const events: EventBus = {emit: (topic, payload) => void sent.push({topic, payload}), on: () => () => {}};
		let activity: ((r: {source: string; id: string; label: string; state: 'running'}) => void) | undefined;
		const command = createSchedulerCommand({
			dataDir: path.join(root, `d${n++}`),
			cwd: root,
			log: noopLog,
			events,
			runner: deps => {
				activity = deps.activity;
				return {start() {}, stop() {}, tick: async () => {}, leader: true, running: new Set()};
			},
		});
		await command.run(['list'], {print() {}, clear() {}, exit() {}, commandBridge: bridge});
		assert.ok(activity);
		activity({source: 'scheduler', id: 'job-1', label: 'job #1', state: 'running'});
		assert.equal(sent.length, 1);
		assert.equal((sent[0]!.payload as {id: string}).id, 'job-1');
	});
});
