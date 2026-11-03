import type {Command, CommandBridge, CommandContext, Logger, SpanTone, StyledBlock, StyledCell, StyledSpan, Subcommand} from '../../../src/api.js';
import {createRunner, redact, type Runner} from './runner.js';
import {line, printStyled, resolveCommandLine, span, table, textBlock} from './deps/core.js';
import {formatDuration, formatTime, parseSchedule} from './schedule.js';
import {type Job, MAX_JOBS, MAX_LINE, MAX_SCRIPT, readJobs, readRuns, type RunStatus, updateJobs} from './store.js';

export type SchedulerDeps = {
	dataDir: string;
	cwd: string;
	log: Logger;
	now?: () => number;
	runner?: (deps: Parameters<typeof createRunner>[0]) => Runner;
};

const WHEN = 'in <duration> | at <time> | every <duration> | daily <HH:MM> | cron <m> <h> <dom> <mon> <dow>';
const ADD_USAGE = `scheduler add [--name <name>] <when> <cmd|sh> <line…>   (when: ${WHEN})`;
const LINE = 'scheduler [list|add|show|remove|pause|resume|run|log|help]';
const USAGE = 'scheduler [subcommand]';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID = {name: 'id', description: 'The job number, as scheduler list shows it (#3 or 3)'};

const subcommands: Subcommand[] = [
	{name: 'list', aliases: ['ls', 'status'], usage: 'scheduler list', description: 'Jobs and when they run next', agent: 'safe'},
	{
		name: 'add',
		usage: 'scheduler add [--name <name>] <when> <kind> <line…>',
		description: 'Schedule a console line (cmd) or a shell script (sh), once or repeated',
		args: [
			{name: 'when', description: 'When it runs: in, at, every, daily or cron, with its values'},
			{name: 'kind', description: 'cmd (a yena console line) or sh (a shell script)'},
			{name: 'line', description: 'The console line or the script: the rest of the line'},
		],
		options: [{name: '--name', value: '<name>', description: 'A name for the job (letters, digits, . _ -)'}],
		notes: [
			`When: ${WHEN}`,
			'Durations: 90s, 10m, 1h30m, 2d, 1w; times: 2026-10-25T09:00, 2026-10-25, 09:00 (container time zone)',
			'cmd runs a yena console line; the user may schedule any line except those not available to assistants',
			'An assistant may schedule only lines it may run without asking, and no scripts',
			'A job added by an assistant (or before 0.3.0) runs only what assistants may run without asking at run time',
			'sh runs the rest of the line with /bin/sh in the yena root',
			'Example: scheduler add daily 09:00 cmd dev check',
		],
		agent: 'confirm',
	},
	{name: 'show', usage: 'scheduler show <id>', description: 'One job and its last runs', args: [ID], agent: 'safe'},
	{name: 'remove', aliases: ['rm'], usage: 'scheduler remove <id>', description: 'Delete a job', args: [ID], agent: 'confirm'},
	{name: 'pause', usage: 'scheduler pause <id>', description: 'Stop a job from running until resumed', args: [ID], agent: 'confirm'},
	{name: 'resume', usage: 'scheduler resume <id>', description: 'Let a paused job run again', args: [ID], agent: 'confirm'},
	{name: 'run', usage: 'scheduler run <id>', description: 'Run a job now (its schedule stays)', args: [ID], agent: 'confirm'},
	{
		name: 'log',
		usage: 'scheduler log [id]',
		description: 'The latest runs',
		args: [{name: 'id', description: 'Only the runs of this job'}],
		agent: 'safe',
	},
];

const NOTES = ['Jobs are kept on disk and run while yena is open; a run missed while yena was closed runs once when it opens'];

const oneLine = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, ' ');
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const actionText = (job: Job): string => (job.action.kind === 'cmd' ? `cmd ${job.action.line}` : `sh ${job.action.script}`);

const statusTone = (status: RunStatus): SpanTone => (status === 'ok' ? 'ok' : status === 'refused' ? 'warn' : 'error');

const statusSpan = (status: RunStatus): StyledSpan => span(status, {tone: statusTone(status)});

const idCell = (job: Job): StyledSpan[] => [span(`#${job.id}`, {tone: 'accent'}), ...(job.name ? [span(` ${job.name}`, {bold: true})] : [])];

const stateSpan = (job: Job, running: boolean): StyledSpan | string =>
	job.paused ? span('paused', {tone: 'warn'}) : running ? span('running', {tone: 'accent'}) : `next ${formatTime(job.next)}`;

const byText = (job: Job): string => (job.by === 'assistant' ? 'by an assistant' : job.by === 'legacy' ? 'from before 0.3.0' : '');

function jobCells(job: Job, running: boolean): StyledCell[] {
	const by = byText(job);
	return [
		idCell(job),
		span(job.when, {tone: 'muted'}),
		stateSpan(job, running),
		job.lastStatus ? ['last ', statusSpan(job.lastStatus)] : '',
		by === '' ? '' : span(by, {tone: 'muted'}),
		oneLine(actionText(job), 80),
	];
}

function jobLine(job: Job, running: boolean): StyledBlock {
	const by = byText(job);
	return line(
		...idCell(job),
		'  ',
		span(job.when, {tone: 'muted'}),
		'  ',
		stateSpan(job, running),
		...(job.lastStatus ? [' · last ', statusSpan(job.lastStatus)] : []),
		...(by === '' ? [] : [span(` · ${by}`, {tone: 'muted'})]),
		`  ${oneLine(actionText(job), 80)}`,
	);
}

const idArg = (raw: string | undefined, usage: string): number => {
	const id = raw === undefined ? NaN : Number(raw.replace(/^#/, ''));
	if (!Number.isInteger(id) || id < 1) throw new Error(`Usage: ${usage}`);
	return id;
};

type By = 'user' | 'assistant';

const NO_SCHEDULER = 'A job cannot run scheduler commands';

function checkLine(line: string, bridge: CommandBridge | undefined, by: By): void {
	const name = line.trim().split(/\s+/)[0] ?? '';
	if (name === 'scheduler') throw new Error(NO_SCHEDULER);
	const list = bridge?.list() ?? [];
	if (list.length === 0) {
		if (by === 'assistant') throw new Error('The scheduler cannot check this line yet; ask the user to add the job');
		return;
	}
	const r = resolveCommandLine(list, line);
	if (!r) throw new Error(`Unknown command "${oneLine(name, 40)}"; "help" lists them`);
	if (r.command === 'scheduler') throw new Error(NO_SCHEDULER);
	const path = r.subcommand ? `${r.command} ${r.subcommand}` : r.command;
	if (r.policy === 'deny') throw new Error(`"${path}" cannot be run by the scheduler (it is not available to assistants)`);
	if (by === 'assistant' && r.policy !== 'safe') {
		throw new Error(`"${path}" needs the user's approval each time, so an assistant cannot schedule it; ask the user to add the job`);
	}
}

export function createSchedulerCommand(deps: SchedulerDeps): Command {
	const now = deps.now ?? Date.now;
	let bridge: CommandBridge | undefined;
	let notify: (text: string) => void = () => {};
	let runner: Runner | undefined;

	const ensureRunner = (ctx: CommandContext): boolean => {
		if (ctx.commandBridge) bridge = ctx.commandBridge;
		if (ctx.headless) return false;
		if (!ctx.signal) notify = text => ctx.print(text);
		if (runner) return false;
		runner = (deps.runner ?? createRunner)({
			dataDir: deps.dataDir,
			cwd: deps.cwd,
			log: deps.log,
			bridge: () => bridge,
			notify: text => notify(text),
			...(deps.now && {now: deps.now}),
		});
		runner.start();
		deps.log.info('scheduler started');
		return true;
	};

	const list = (ctx: CommandContext, quietWhenEmpty: boolean): void => {
		const {jobs} = readJobs(deps.dataDir);
		if (jobs.length === 0) {
			if (!quietWhenEmpty) ctx.print('Nothing is scheduled.');
			return;
		}
		const sorted = [...jobs].sort((a, b) => a.next - b.next);
		if (quietWhenEmpty) {
			const first = sorted.find(j => !j.paused);
			ctx.print(`[scheduler] ${jobs.length} job${jobs.length === 1 ? '' : 's'}${first ? `; next #${first.id} at ${formatTime(first.next)}` : ''}`);
			return;
		}
		printStyled(ctx, [table(sorted.map(job => jobCells(job, runner?.running.has(job.id) ?? false)), {flex: 5})]);
	};

	const add = (args: string[], ctx: CommandContext): void => {
		let rest = args;
		let name: string | undefined;
		if (rest[0] === '--name') {
			name = rest[1];
			if (name === undefined || !NAME_RE.test(name)) throw new Error('A job name is up to 64 letters, digits, ".", "_" and "-"');
			rest = rest.slice(2);
		}
		if (rest.length === 0) throw new Error(`Usage: ${ADD_USAGE}`);
		const t = now();
		const parsed = parseSchedule(rest, t);
		const [kind, ...body] = parsed.rest;
		const text = body.join(' ').trim();
		if ((kind !== 'cmd' && kind !== 'sh') || text === '') throw new Error(`After the schedule comes "cmd <console line>" or "sh <script>". Usage: ${ADD_USAGE}`);
		const by: By = ctx.signal !== undefined ? 'assistant' : 'user';
		if (kind === 'cmd') {
			if (text.length > MAX_LINE) throw new Error(`A console line is at most ${MAX_LINE} characters`);
			checkLine(text, bridge, by);
		} else {
			if (text.length > MAX_SCRIPT) throw new Error(`A script is at most ${MAX_SCRIPT} characters; put a longer one in a file and run that`);
			if (by === 'assistant') throw new Error('An assistant cannot schedule shell scripts; ask the user to add it');
		}
		const job = updateJobs(deps.dataDir, state => {
			if (state.jobs.length >= MAX_JOBS) throw new Error(`At most ${MAX_JOBS} jobs`);
			if (name !== undefined && state.jobs.some(j => j.name === name)) throw new Error(`A job is already named "${name}"`);
			const created: Job = {
				id: state.nextId++,
				...(name !== undefined && {name}),
				schedule: parsed.schedule,
				when: parsed.text,
				action: kind === 'cmd' ? {kind: 'cmd', line: text} : {kind: 'sh', script: text},
				next: parsed.first,
				createdAt: t,
				runs: 0,
				by,
			};
			state.jobs.push(created);
			return created;
		});
		deps.log.info('job added', {kind, schedule: job.schedule.kind, by});
		const repeat = job.schedule.kind === 'every' ? ` (then every ${formatDuration(job.schedule.everyMs)})` : job.schedule.kind === 'cron' ? ' (then by its cron schedule)' : '';
		ctx.print(`Scheduled #${job.id}${name ? ` ${name}` : ''}: first run ${formatTime(job.next)}${repeat}.`);
	};

	const find = (id: number): Job => {
		const job = readJobs(deps.dataDir).jobs.find(j => j.id === id);
		if (!job) throw new Error(`No job #${id}; "scheduler list" shows them`);
		return job;
	};

	const change = (id: number, edit: (job: Job) => void): Job =>
		updateJobs(deps.dataDir, state => {
			const job = state.jobs.find(j => j.id === id);
			if (!job) throw new Error(`No job #${id}; "scheduler list" shows them`);
			edit(job);
			return job;
		});

	const show = (id: number, ctx: CommandContext): void => {
		const job = find(id);
		const blocks: StyledBlock[] = [
			jobLine(job, runner?.running.has(job.id) ?? false),
			line(
				span(`  ${job.action.kind === 'cmd' ? 'console line' : 'script'}: `, {tone: 'muted'}),
				job.action.kind === 'cmd' ? job.action.line : job.action.script,
			),
		];
		const by = job.by === 'assistant' ? ' by an assistant' : job.by === 'legacy' ? " before 0.3.0 (treated as an assistant's)" : '';
		blocks.push(line(span(`  added ${formatTime(job.createdAt)}${by}, ran ${job.runs} time${job.runs === 1 ? '' : 's'}${job.lastRun ? `, last ${formatTime(job.lastRun)}` : ''}`, {tone: 'muted'})));
		const runs = readRuns(deps.dataDir, id, 3);
		for (const r of runs) {
			blocks.push(line(`  ${formatTime(r.at)} `, statusSpan(r.status), ...(r.note ? [` (${redact(deps.log, r.note)})`] : [])));
			if (r.output) blocks.push(textBlock(redact(deps.log, r.output).trimEnd().split('\n').slice(-5).map(l => `    ${oneLine(l, 200)}`).join('\n'), 'muted'));
		}
		printStyled(ctx, blocks);
	};

	const log = (rawId: string | undefined, ctx: CommandContext): void => {
		const id = rawId === undefined ? undefined : idArg(rawId, 'scheduler log [<id>]');
		const runs = readRuns(deps.dataDir, id, 20);
		if (runs.length === 0) {
			ctx.print('No runs yet.');
			return;
		}
		const rows = runs.map((r): StyledCell[] => [
			span(formatTime(r.at), {tone: 'muted'}),
			span(`#${r.id}`, {tone: 'accent'}),
			[statusSpan(r.status), ...(r.note ? [span(` (${oneLine(redact(deps.log, r.note), 120)})`, {tone: 'muted'})] : [])],
			span(`${(r.ms / 1000).toFixed(1)} s`, {tone: 'muted'}),
		]);
		printStyled(ctx, [table(rows, {head: ['When', 'Job', 'Status', 'Took']})]);
	};

	return {
		name: 'scheduler',
		description: 'Run console lines or shell scripts later or repeatedly; kept across restarts',
		usage: USAGE,
		args: [{name: 'subcommand', description: 'What to do (none: a summary of the jobs)'}],
		notes: NOTES,
		agent: 'safe',
		autostart: true,
		subcommands,
		async run([sub, ...rest], ctx) {
			const first = ensureRunner(ctx);
			switch (sub) {
				case undefined:
					return list(ctx, first);
				case 'list':
				case 'ls':
				case 'status':
					if (rest.length > 0) throw new Error('Usage: scheduler list');
					return list(ctx, false);
				case 'help':
					return ctx.showHelp ? ctx.showHelp() : ctx.print(USAGE);
				case 'add':
					return add(rest, ctx);
				case 'show':
					return show(idArg(rest[0], 'scheduler show <id>'), ctx);
				case 'remove':
				case 'rm': {
					const id = idArg(rest[0], 'scheduler remove <id>');
					find(id);
					updateJobs(deps.dataDir, state => {
						state.jobs = state.jobs.filter(j => j.id !== id);
					});
					deps.log.info('job removed');
					ctx.print(`Removed #${id}.`);
					return;
				}
				case 'pause':
					change(idArg(rest[0], 'scheduler pause <id>'), j => void (j.paused = true));
					ctx.print(`Paused #${rest[0]!.replace(/^#/, '')}.`);
					return;
				case 'resume': {
					const job = change(idArg(rest[0], 'scheduler resume <id>'), j => {
						delete j.paused;
					});
					ctx.print(`Resumed #${job.id}; next run ${formatTime(job.next)}${job.next <= now() ? ' (due now)' : ''}.`);
					return;
				}
				case 'run': {
					if (ctx.headless) throw new Error('"scheduler run" needs the app (./yena)');
					const job = change(idArg(rest[0], 'scheduler run <id>'), j => {
						j.next = now();
						delete j.paused;
					});
					void runner?.tick();
					ctx.print(`#${job.id} runs now.`);
					return;
				}
				case 'log':
					return log(rest[0], ctx);
				default:
					throw new Error(`Unknown subcommand: ${sub.slice(0, 64)}. Usage: ${LINE}`);
			}
		},
	};
}
