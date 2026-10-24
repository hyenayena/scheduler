/**
 * When a job runs: once at a time, every fixed interval, or by a cron expression. Times are the
 * container's local time (TZ, UTC unless set).
 */
export type Schedule =
	| {kind: 'once'; at: number}
	| {kind: 'every'; everyMs: number; anchor: number}
	| {kind: 'cron'; expr: string};

const UNIT_MS: Record<string, number> = {s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000};
const DURATION_RE = /^(?:\d+[smhdw])+$/;
const MAX_MS = 366 * UNIT_MS.d!;
export const MIN_EVERY_MS = UNIT_MS.m!;

/** "90s", "10m", "1h30m", "2d", "1w" in milliseconds. */
export function parseDuration(text: string | undefined): number {
	if (text === undefined || !DURATION_RE.test(text)) throw new Error('A duration is a number with s, m, h, d or w, e.g. 10m, 1h30m, 2d');
	let ms = 0;
	for (const m of text.matchAll(/(\d+)([smhdw])/g)) ms += Number(m[1]) * UNIT_MS[m[2]!]!;
	if (ms <= 0 || ms > MAX_MS) throw new Error('A duration is longer than 0 and at most a year');
	return ms;
}

export function formatDuration(ms: number): string {
	const parts: string[] = [];
	let rest = ms;
	for (const [u, size] of [['d', UNIT_MS.d!], ['h', UNIT_MS.h!], ['m', UNIT_MS.m!], ['s', UNIT_MS.s!]] as const) {
		const n = Math.floor(rest / size);
		if (n > 0) parts.push(`${n}${u}`);
		rest -= n * size;
	}
	return parts.join('') || '0s';
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * "2026-10-25T09:00" (or with seconds, "Z" or an offset), "2026-10-25" (midnight) or "09:00" (the next
 * time it is 09:00) in epoch milliseconds.
 */
export function parseAt(text: string | undefined, now: number): number {
	if (text === undefined) throw new Error('Give a time: 2026-10-25T09:00, 2026-10-25 or 09:00');
	const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
	if (clock) {
		const [h, m] = [Number(clock[1]), Number(clock[2])];
		if (h > 23 || m > 59) throw new Error(`Invalid time "${text}"`);
		const d = new Date(now);
		d.setHours(h, m, 0, 0);
		if (d.getTime() <= now) d.setDate(d.getDate() + 1);
		return d.getTime();
	}
	const date = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
	if (!date) throw new Error(`Invalid time "${text}"; use 2026-10-25T09:00, 2026-10-25 or 09:00`);
	const [, y, mo, da, h = '00', mi = '00', s = '00', zone] = date;
	const local = `${y}-${mo}-${da}T${h}:${mi}:${s}`;
	const ms = zone ? Date.parse(`${local}${zone}`) : new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s)).getTime();
	const check = new Date(ms);
	if (!Number.isFinite(ms) || (!zone && (check.getMonth() !== Number(mo) - 1 || check.getDate() !== Number(da)))) throw new Error(`Invalid time "${text}"`);
	return ms;
}

// ---- cron: minute hour day-of-month month day-of-week ----

type Field = {set: Set<number>; star: boolean};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const LIMITS: Array<[number, number, string[] | undefined, string]> = [
	[0, 59, undefined, 'minute'],
	[0, 23, undefined, 'hour'],
	[1, 31, undefined, 'day of month'],
	[1, 12, MONTHS, 'month'],
	[0, 7, DAYS, 'day of week'],
];

function parseField(text: string, [lo, hi, names, what]: [number, number, string[] | undefined, string]): Field {
	const value = (v: string): number => {
		const named = names?.indexOf(v.toLowerCase()) ?? -1;
		const n = named >= 0 ? named + (what === 'month' ? 1 : 0) : /^\d+$/.test(v) ? Number(v) : NaN;
		if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`Invalid ${what} "${v}" in the cron expression`);
		return n;
	};
	const set = new Set<number>();
	for (const part of text.split(',')) {
		const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
		if (!m) throw new Error(`Invalid ${what} "${part}" in the cron expression`);
		const step = m[2] === undefined ? 1 : Number(m[2]);
		if (step < 1) throw new Error(`Invalid step in "${part}" in the cron expression`);
		let [from, to] = [lo, hi];
		if (m[1] !== '*') {
			const [a, b] = m[1]!.split('-');
			from = value(a!);
			to = b === undefined ? (m[2] === undefined ? from : hi) : value(b);
			if (to < from) throw new Error(`Invalid range "${part}" in the cron expression`);
		}
		for (let n = from; n <= to; n += step) set.add(what === 'day of week' && n === 7 ? 0 : n);
	}
	return {set, star: text === '*' || text.startsWith('*/')};
}

export type Cron = {minute: Field; hour: Field; dom: Field; month: Field; dow: Field};

export function parseCron(expr: string): Cron {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error('A cron expression has 5 fields: minute hour day-of-month month day-of-week');
	const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, LIMITS[i]!)) as [Field, Field, Field, Field, Field];
	return {minute, hour, dom, month, dow};
}

// As in cron: with both day fields restricted, either one matching is enough.
function dayMatches(c: Cron, d: Date): boolean {
	const dom = c.dom.set.has(d.getDate());
	const dow = c.dow.set.has(d.getDay());
	if (c.dom.star && c.dow.star) return true;
	if (c.dom.star) return dow;
	if (c.dow.star) return dom;
	return dom || dow;
}

const HORIZON_MS = 5 * 366 * UNIT_MS.d!;

/** The first minute after `after` that the expression matches; undefined when there is none within 5 years. */
export function nextCron(c: Cron, after: number): number | undefined {
	const d = new Date(after);
	d.setSeconds(0, 0);
	d.setMinutes(d.getMinutes() + 1);
	const end = after + HORIZON_MS;
	for (let i = 0; i < 100_000 && d.getTime() <= end; i++) {
		if (!c.month.set.has(d.getMonth() + 1)) {
			d.setMonth(d.getMonth() + 1, 1);
			d.setHours(0, 0, 0, 0);
		} else if (!dayMatches(c, d)) {
			d.setDate(d.getDate() + 1);
			d.setHours(0, 0, 0, 0);
		} else if (!c.hour.set.has(d.getHours())) {
			d.setHours(d.getHours() + 1, 0, 0, 0);
		} else if (!c.minute.set.has(d.getMinutes())) {
			d.setMinutes(d.getMinutes() + 1, 0, 0);
		} else {
			return d.getTime();
		}
	}
	return undefined;
}

/** The next run strictly after `after`; undefined when the schedule has no more runs. */
export function nextRun(s: Schedule, after: number): number | undefined {
	switch (s.kind) {
		case 'once':
			return s.at > after ? s.at : undefined;
		case 'every': {
			if (s.anchor > after) return s.anchor;
			const k = Math.floor((after - s.anchor) / s.everyMs) + 1;
			return s.anchor + k * s.everyMs;
		}
		case 'cron':
			return nextCron(parseCron(s.expr), after);
	}
}

/**
 * Reads a schedule from the start of the arguments:
 *   in <duration> | at <time> | every <duration> | daily <HH:MM> | cron <m> <h> <dom> <mon> <dow>
 * and returns it with the arguments after it and the first run.
 */
export function parseSchedule(args: string[], now: number): {schedule: Schedule; text: string; first: number; rest: string[]} {
	const [word, ...after] = args;
	let schedule: Schedule;
	let used: number;
	switch (word) {
		case 'in':
			schedule = {kind: 'once', at: now + parseDuration(after[0])};
			used = 2;
			break;
		case 'at':
			schedule = {kind: 'once', at: parseAt(after[0], now)};
			used = 2;
			break;
		case 'every': {
			const everyMs = parseDuration(after[0]);
			if (everyMs < MIN_EVERY_MS) throw new Error('"every" is at least 1m');
			schedule = {kind: 'every', everyMs, anchor: now + everyMs};
			used = 2;
			break;
		}
		case 'daily': {
			const m = /^(\d{1,2}):(\d{2})$/.exec(after[0] ?? '');
			if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('"daily" takes a time like 09:00');
			schedule = {kind: 'cron', expr: `${Number(m[2])} ${Number(m[1])} * * *`};
			used = 2;
			break;
		}
		case 'cron':
			if (after.length < 5) throw new Error('"cron" takes 5 fields: minute hour day-of-month month day-of-week');
			schedule = {kind: 'cron', expr: after.slice(0, 5).join(' ')};
			parseCron(schedule.expr);
			used = 6;
			break;
		default:
			throw new Error('The schedule is one of: in <duration>, at <time>, every <duration>, daily <HH:MM>, cron <m> <h> <dom> <mon> <dow>');
	}
	const first = schedule.kind === 'once' ? schedule.at : nextRun(schedule, now);
	if (first === undefined) throw new Error('That schedule never runs');
	if (schedule.kind === 'once' && first <= now) throw new Error('That time has already passed');
	return {schedule, text: args.slice(0, used).join(' '), first, rest: args.slice(used)};
}

/** A time for people, with the zone: "2026-10-25 09:00 UTC". */
export function formatTime(ms: number): string {
	const d = new Date(ms);
	const zone = new Intl.DateTimeFormat('en-GB', {timeZoneName: 'short'}).formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? '';
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${zone ? ` ${zone}` : ''}`;
}
