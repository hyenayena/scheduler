import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {CommandBridge, Logger} from '../../../src/api.js';
import {nextRun} from './schedule.js';
import {appendRun, type Job, readJobs, type RunStatus, updateJobs} from './store.js';

export const TICK_MS = 15_000;
// A console line waits this long when another assistant command holds the console.
const BUSY_RETRY_MS = 30_000;
export const CMD_TIMEOUT_MS = 10 * 60_000;
export const SH_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_MAX = 64 * 1024;
// Credentials never reach a scheduled script.
const SECRET_ENV = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];

export type ShResult = {code: number | null; output: string; timedOut: boolean};
export type RunSh = (script: string, opts: {cwd: string; timeoutMs: number}) => Promise<ShResult>;

/** Runs a script with `sh -c` in its own process group; the group is killed on timeout. */
export const runSh: RunSh = (script, {cwd, timeoutMs}) =>
	new Promise(resolve => {
		const env = {...process.env};
		for (const k of SECRET_ENV) delete env[k];
		let output = '';
		let timedOut = false;
		const child = spawn('/bin/sh', ['-c', script], {cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
		const take = (b: Buffer) => {
			output = (output + b.toString('utf8')).slice(-OUTPUT_MAX);
		};
		child.stdout.on('data', take);
		child.stderr.on('data', take);
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {}
		}, timeoutMs);
		timer.unref();
		child.on('error', err => {
			clearTimeout(timer);
			resolve({code: null, output: `${output}${err.message}`, timedOut});
		});
		child.on('close', code => {
			clearTimeout(timer);
			resolve({code, output, timedOut});
		});
	});

// ---- one runner per container: the yena process holding the lock runs the jobs ----

type Holder = {pid: number; start?: string};

// The process start time, so a pid reused after a restart does not count as the old holder.
const startOf = (pid: number): string | undefined => {
	try {
		return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19];
	} catch {
		return undefined;
	}
};

const alive = (h: Holder): boolean => {
	try {
		process.kill(h.pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
	}
	return h.start === undefined || startOf(h.pid) === undefined || startOf(h.pid) === h.start;
};

export function createLeaderLock(dataDir: string): {acquire(): boolean; release(): void; held(): boolean} {
	const file = path.join(dataDir, 'runner.lock');
	let held = false;
	const me: Holder = {pid: process.pid, ...(startOf(process.pid) !== undefined && {start: startOf(process.pid)!})};
	const tryCreate = (): boolean => {
		try {
			mkdirSync(dataDir, {recursive: true, mode: 0o700});
			writeFileSync(file, JSON.stringify(me), {flag: 'wx', mode: 0o600});
			return true;
		} catch {
			return false;
		}
	};
	return {
		acquire() {
			if (held) return true;
			if (tryCreate()) return (held = true);
			let other: Holder | undefined;
			try {
				other = JSON.parse(readFileSync(file, 'utf8')) as Holder;
			} catch {
				other = undefined;
			}
			if (other && Number.isInteger(other.pid) && other.pid !== process.pid && alive(other)) return false;
			rmSync(file, {force: true});
			return (held = tryCreate());
		},
		release() {
			if (!held) return;
			held = false;
			try {
				const other = JSON.parse(readFileSync(file, 'utf8')) as Holder;
				if (other.pid === process.pid) rmSync(file, {force: true});
			} catch {}
		},
		held: () => held,
	};
}

export type RunnerDeps = {
	dataDir: string;
	/** Where scripts run (the yena root). */
	cwd: string;
	log: Logger;
	/** The console's command bridge, once a yena console exists. */
	bridge: () => CommandBridge | undefined;
	/** A one-line notice for the user. */
	notify: (text: string) => void;
	now?: () => number;
	runSh?: RunSh;
	tickMs?: number;
};

export type Runner = {start(): void; stop(): void; tick(): Promise<void>; readonly leader: boolean; readonly running: ReadonlySet<number>};

const label = (job: Job) => `#${job.id}${job.name ? ` ${job.name}` : ''}`;

export function createRunner(deps: RunnerDeps): Runner {
	const now = deps.now ?? Date.now;
	const sh = deps.runSh ?? runSh;
	const lock = createLeaderLock(deps.dataDir);
	const running = new Set<number>();
	let timer: NodeJS.Timeout | undefined;
	let ticking = false;

	// After a run: the next time (a missed recurring run is not repeated, it moves past now), or the
	// job ends when the schedule has no more runs. The file is read again: it may have changed meanwhile.
	const settle = (job: Job, at: number, ms: number, status: RunStatus, note: string | undefined, output: string | undefined) => {
		appendRun(deps.dataDir, {id: job.id, at, ms, status, ...(note !== undefined && {note}), ...(output && {output})});
		let ended = false;
		updateJobs(deps.dataDir, state => {
			const current = state.jobs.find(j => j.id === job.id);
			if (!current) return;
			const next = nextRun(current.schedule, Math.max(now(), at));
			if (next === undefined) {
				state.jobs = state.jobs.filter(j => j.id !== job.id);
				ended = true;
				return;
			}
			Object.assign(current, {next, runs: current.runs + 1, lastRun: at, lastStatus: status});
		});
		const text = `[scheduler] ${label(job)} (${job.action.kind}): ${status}${note ? ` — ${note}` : ''} in ${(ms / 1000).toFixed(1)} s${ended ? '; done' : ''}`;
		deps.notify(text);
		deps.log.info('job ran', {kind: job.action.kind, status, ms, ended});
	};

	const delay = (job: Job, ms: number) =>
		updateJobs(deps.dataDir, state => {
			const current = state.jobs.find(j => j.id === job.id);
			if (current) current.next = now() + ms;
		});

	const execute = async (job: Job): Promise<void> => {
		const at = now();
		if (job.action.kind === 'sh') {
			const r = await sh(job.action.script, {cwd: deps.cwd, timeoutMs: SH_TIMEOUT_MS});
			const status: RunStatus = r.timedOut ? 'timeout' : r.code === 0 ? 'ok' : 'error';
			settle(job, at, now() - at, status, status === 'error' ? `exit ${r.code ?? 'signal'}` : undefined, r.output);
			return;
		}
		const bridge = deps.bridge();
		if (!bridge) {
			// No console yet (yena is still starting): the job stays due for the next tick.
			return;
		}
		// The user, or an assistant with the user's approval, added this line; it runs without asking again.
		const r = await bridge.run({line: job.action.line, caller: 'scheduler', confirm: async () => true, timeoutMs: CMD_TIMEOUT_MS});
		if (r.status === 'busy') {
			delay(job, BUSY_RETRY_MS);
			deps.log.debug('job delayed', {reason: 'busy'});
			return;
		}
		const status: RunStatus = r.status === 'ok' ? 'ok' : r.status === 'timeout' ? 'timeout' : 'error';
		settle(job, at, r.ms, status, status === 'ok' ? undefined : (r.reason ?? r.status), r.output);
	};

	const tick = async (): Promise<void> => {
		if (ticking) return;
		ticking = true;
		try {
			if (!lock.acquire()) return;
			const t = now();
			const due = readJobs(deps.dataDir).jobs.filter(j => !j.paused && j.next <= t && !running.has(j.id));
			for (const job of due) {
				running.add(job.id);
				// Scripts run side by side; console lines one after another (the console runs one at a time).
				const p = execute(job)
					.catch(err => deps.log.warn('job failed to run', {errClass: err instanceof Error ? err.name : typeof err}))
					.finally(() => running.delete(job.id));
				if (job.action.kind === 'cmd') await p;
			}
		} catch (err) {
			deps.log.warn('scheduler tick failed', {errClass: err instanceof Error ? err.name : typeof err});
		} finally {
			ticking = false;
		}
	};

	return {
		start() {
			if (timer) return;
			void tick();
			timer = setInterval(() => void tick(), deps.tickMs ?? TICK_MS);
			timer.unref();
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = undefined;
			lock.release();
		},
		tick,
		get leader() {
			return lock.held();
		},
		running,
	};
}
