import {randomBytes} from 'node:crypto';
import {appendFileSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {Schedule} from './schedule.js';

/** What a job does: a yena console line (as if typed in the console) or a shell script. */
export type JobAction = {kind: 'cmd'; line: string} | {kind: 'sh'; script: string};

export type RunStatus = 'ok' | 'error' | 'timeout';

export type Job = {
	id: number;
	name?: string;
	schedule: Schedule;
	// The schedule as it was given ("every 1h"), for display.
	when: string;
	action: JobAction;
	// Epoch ms of the next run.
	next: number;
	paused?: boolean;
	createdAt: number;
	runs: number;
	lastRun?: number;
	lastStatus?: RunStatus;
};

export type RunRecord = {id: number; at: number; ms: number; status: RunStatus; note?: string; output?: string};

type JobsFile = {v: 1; nextId: number; jobs: Job[]};

export const MAX_JOBS = 100;
export const MAX_LINE = 4096;
export const MAX_SCRIPT = 8192;
const MAX_FILE = 4 * 1024 * 1024;
const LOG_KEEP = 300;
const OUTPUT_KEEP = 2000;

export const jobsFile = (dataDir: string): string => path.join(dataDir, 'jobs.json');
export const runsFile = (dataDir: string): string => path.join(dataDir, 'runs.jsonl');

function writeAtomic(file: string, data: string): void {
	mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		writeFileSync(tmp, data, {flag: 'wx', mode: 0o600});
		renameSync(tmp, file);
	} catch (err) {
		rmSync(tmp, {force: true});
		throw err;
	}
}

function readText(file: string): string | undefined {
	try {
		const st = lstatSync(file);
		if (!st.isFile() || st.size > MAX_FILE) return undefined;
		return readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function parseSchedule(v: unknown): Schedule | undefined {
	if (!isRecord(v)) return undefined;
	if (v.kind === 'once' && isTime(v.at)) return {kind: 'once', at: v.at};
	if (v.kind === 'every' && isTime(v.everyMs) && v.everyMs >= 1000 && isTime(v.anchor)) return {kind: 'every', everyMs: v.everyMs, anchor: v.anchor};
	if (v.kind === 'cron' && typeof v.expr === 'string' && v.expr.length <= 200) return {kind: 'cron', expr: v.expr};
	return undefined;
}

function parseAction(v: unknown): JobAction | undefined {
	if (!isRecord(v)) return undefined;
	if (v.kind === 'cmd' && typeof v.line === 'string' && v.line !== '' && v.line.length <= MAX_LINE) return {kind: 'cmd', line: v.line};
	if (v.kind === 'sh' && typeof v.script === 'string' && v.script !== '' && v.script.length <= MAX_SCRIPT) return {kind: 'sh', script: v.script};
	return undefined;
}

function parseJob(v: unknown): Job | undefined {
	if (!isRecord(v) || !Number.isInteger(v.id) || (v.id as number) < 1) return undefined;
	const schedule = parseSchedule(v.schedule);
	const action = parseAction(v.action);
	if (!schedule || !action || !isTime(v.next) || !isTime(v.createdAt)) return undefined;
	return {
		id: v.id as number,
		...(typeof v.name === 'string' && v.name.length <= 64 && {name: v.name}),
		schedule,
		when: typeof v.when === 'string' ? v.when.slice(0, 200) : '',
		action,
		next: v.next,
		...(v.paused === true && {paused: true}),
		createdAt: v.createdAt,
		runs: Number.isInteger(v.runs) ? (v.runs as number) : 0,
		...(isTime(v.lastRun) && {lastRun: v.lastRun}),
		...((v.lastStatus === 'ok' || v.lastStatus === 'error' || v.lastStatus === 'timeout') && {lastStatus: v.lastStatus}),
	};
}

/** The jobs on disk; a missing or broken file reads as none (a broken one is kept aside, never overwritten silently). */
export function readJobs(dataDir: string): {nextId: number; jobs: Job[]} {
	const text = readText(jobsFile(dataDir));
	if (text === undefined) return {nextId: 1, jobs: []};
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		raw = undefined;
	}
	if (!isRecord(raw) || !Array.isArray(raw.jobs)) {
		renameSync(jobsFile(dataDir), `${jobsFile(dataDir)}.broken-${Date.now()}`);
		return {nextId: 1, jobs: []};
	}
	const jobs = raw.jobs.map(parseJob).filter((j): j is Job => j !== undefined);
	const top = Math.max(0, ...jobs.map(j => j.id));
	const nextId = Number.isInteger(raw.nextId) && (raw.nextId as number) > top ? (raw.nextId as number) : top + 1;
	return {nextId, jobs};
}

/** Changes the jobs in one read-modify-write; returns what `change` returns. */
export function updateJobs<T>(dataDir: string, change: (state: {nextId: number; jobs: Job[]}) => T): T {
	const state = readJobs(dataDir);
	const out = change(state);
	const file: JobsFile = {v: 1, nextId: state.nextId, jobs: state.jobs};
	writeAtomic(jobsFile(dataDir), JSON.stringify(file, null, '\t') + '\n');
	return out;
}

/** Appends a run to the log, keeping the latest ones only. */
export function appendRun(dataDir: string, run: RunRecord): void {
	const record = {...run, ...(run.output !== undefined && {output: run.output.slice(-OUTPUT_KEEP)})};
	mkdirSync(dataDir, {recursive: true, mode: 0o700});
	appendFileSync(runsFile(dataDir), JSON.stringify(record) + '\n', {mode: 0o600});
	const lines = (readText(runsFile(dataDir)) ?? '').split('\n').filter(Boolean);
	if (lines.length > LOG_KEEP * 2) writeAtomic(runsFile(dataDir), lines.slice(-LOG_KEEP).join('\n') + '\n');
}

export function readRuns(dataDir: string, id?: number, limit = 20): RunRecord[] {
	const out: RunRecord[] = [];
	for (const line of (readText(runsFile(dataDir)) ?? '').split('\n')) {
		if (!line) continue;
		try {
			const r = JSON.parse(line) as RunRecord;
			if (Number.isInteger(r.id) && isTime(r.at) && (id === undefined || r.id === id)) out.push(r);
		} catch {
			continue;
		}
	}
	return out.slice(-limit);
}
