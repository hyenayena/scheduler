import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {CommandBridge, Logger} from '../../../src/api.js';
import {scriptEnv} from './env.js';
import {nextRun} from './schedule.js';
import {appendRun, type Job, readJobs, type RunStatus, updateJobs} from './store.js';

export const TICK_MS = 15_000;
const BUSY_RETRY_MS = 30_000;
export const CMD_TIMEOUT_MS = 10 * 60_000;
export const SH_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_MAX = 64 * 1024;

export type ShResult = {code: number | null; output: string; timedOut: boolean};
export type RunSh = (script: string, opts: {cwd: string; timeoutMs: number}) => Promise<ShResult>;

export const runSh: RunSh = (script, {cwd, timeoutMs}) =>
	new Promise(resolve => {
		const env = scriptEnv(process.env);
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

type Holder = {pid: number; start?: string};

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
	cwd: string;
	log: Logger;
	bridge: () => CommandBridge | undefined;
	notify: (text: string) => void;
	now?: () => number;
	runSh?: RunSh;
	tickMs?: number;
};

export type Runner = {start(): void; stop(): void; tick(): Promise<void>; readonly leader: boolean; readonly running: ReadonlySet<number>};

export const redact = (log: Logger, text: string): string => log.redact?.(text) ?? text;

const label = (job: Job) => `#${job.id}${job.name ? ` ${job.name}` : ''}`;

export function createRunner(deps: RunnerDeps): Runner {
	const now = deps.now ?? Date.now;
	const sh = deps.runSh ?? runSh;
	const lock = createLeaderLock(deps.dataDir);
	const running = new Set<number>();
	let timer: NodeJS.Timeout | undefined;
	let ticking = false;

	const settle = (job: Job, at: number, ms: number, status: RunStatus, rawNote: string | undefined, rawOutput: string | undefined) => {
		const note = rawNote === undefined ? undefined : redact(deps.log, rawNote);
		const output = rawOutput && redact(deps.log, rawOutput);
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
			return;
		}
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
