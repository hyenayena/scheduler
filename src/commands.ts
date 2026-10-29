import type {Command, CommandBridge, CommandContext, Logger, Subcommand} from '../../../src/api.js';
import {createRunner, redact, type Runner} from './runner.js';
import {formatDuration, formatTime, parseSchedule} from './schedule.js';
import {type Job, MAX_JOBS, MAX_LINE, MAX_SCRIPT, readJobs, readRuns, updateJobs} from './store.js';

export type SchedulerDeps = {
	/** The module's own data dir: jobs.json, runs.jsonl, runner.lock. */
	dataDir: string;
	/** Where shell jobs run (the yena root). */
	cwd: string;
	log: Logger;
	now?: () => number;
	/** For tests: a runner instead of the real one. */
	runner?: (deps: Parameters<typeof createRunner>[0]) => Runner;
};

const WHEN = 'in <duration> | at <time> | every <duration> | daily <HH:MM> | cron <m> <h> <dom> <mon> <dow>';
const ADD_USAGE = `scheduler add [--name <name>] <when> <cmd|sh> <line…>   (when: ${WHEN})`;
// The one-line form in usage errors.
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
			'cmd runs a yena console line, as the console does for assistants',
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

function jobLine(job: Job, running: boolean): string {
	const state = job.paused ? 'paused' : running ? 'running' : `next ${formatTime(job.next)}`;
	const last = job.lastStatus ? ` · last ${job.lastStatus}` : '';
	return `#${job.id}${job.name ? ` ${job.name}` : ''}  ${job.when}  ${state}${last}  ${oneLine(actionText(job), 80)}`;
}

const idArg = (raw: string | undefined, usage: string): number => {
	const id = raw === undefined ? NaN : Number(raw.replace(/^#/, ''));
	if (!Number.isInteger(id) || id < 1) throw new Error(`Usage: ${usage}`);
	return id;
};

// The console's own policy for the line, when the console can tell: a command assistants may not run
// cannot be scheduled either (the scheduler runs lines the way assistants do).
function checkLine(line: string, bridge: CommandBridge | undefined): void {
	const [name, first] = line.split(/\s+/);
	if (name === 'scheduler') throw new Error('A job cannot run scheduler commands');
	const list = bridge?.list() ?? [];
	if (list.length === 0) return;
	const info = list.find(c => c.name === name);
	if (!info) throw new Error(`Unknown command "${oneLine(name ?? '', 40)}"; "help" lists them`);
	const sub = first === undefined ? undefined : info.subcommands.find(s => s.name === first || s.aliases.includes(first));
	if ((sub?.policy ?? info.policy) === 'deny') {
		throw new Error(`"${name}${sub ? ` ${sub.name}` : ''}" cannot be run by the scheduler (it is not available to assistants)`);
	}
}

export function createSchedulerCommand(deps: SchedulerDeps): Command {
	const now = deps.now ?? Date.now;
	// The console comes with the first context the command gets (the autostart at UI start).
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
		for (const job of sorted) ctx.print(jobLine(job, runner?.running.has(job.id) ?? false));
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
		if (kind === 'cmd') {
			if (text.length > MAX_LINE) throw new Error(`A console line is at most ${MAX_LINE} characters`);
			checkLine(text, bridge);
		} else if (text.length > MAX_SCRIPT) throw new Error(`A script is at most ${MAX_SCRIPT} characters; put a longer one in a file and run that`);
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
			};
			state.jobs.push(created);
			return created;
		});
		deps.log.info('job added', {kind, schedule: job.schedule.kind, byCaller: ctx.signal !== undefined});
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
		ctx.print(jobLine(job, runner?.running.has(job.id) ?? false));
		ctx.print(`  ${job.action.kind === 'cmd' ? 'console line' : 'script'}: ${job.action.kind === 'cmd' ? job.action.line : job.action.script}`);
		ctx.print(`  added ${formatTime(job.createdAt)}, ran ${job.runs} time${job.runs === 1 ? '' : 's'}${job.lastRun ? `, last ${formatTime(job.lastRun)}` : ''}`);
		const runs = readRuns(deps.dataDir, id, 3);
		for (const r of runs) {
			ctx.print(`  ${formatTime(r.at)} ${r.status}${r.note ? ` (${redact(deps.log, r.note)})` : ''}`);
			if (r.output) ctx.print(redact(deps.log, r.output).trimEnd().split('\n').slice(-5).map(l => `    ${oneLine(l, 200)}`).join('\n'));
		}
	};

	const log = (rawId: string | undefined, ctx: CommandContext): void => {
		const id = rawId === undefined ? undefined : idArg(rawId, 'scheduler log [<id>]');
		const runs = readRuns(deps.dataDir, id, 20);
		if (runs.length === 0) {
			ctx.print('No runs yet.');
			return;
		}
		for (const r of runs) ctx.print(`${formatTime(r.at)}  #${r.id}  ${r.status}${r.note ? ` (${oneLine(redact(deps.log, r.note), 120)})` : ''}  ${(r.ms / 1000).toFixed(1)} s`);
	};

	return {
		name: 'scheduler',
		description: 'Run console lines or shell scripts later or repeatedly; kept across restarts',
		usage: USAGE,
		args: [{name: 'subcommand', description: 'What to do (none: a summary of the jobs)'}],
		notes: NOTES,
		agent: 'safe',
		// Starts the runner when the UI starts, with the console it runs lines in.
		autostart: true,
		subcommands,
		async run([sub, ...rest], ctx) {
			const first = ensureRunner(ctx);
			switch (sub) {
				case undefined:
					// At start-up only a summary, and only when something is scheduled.
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
