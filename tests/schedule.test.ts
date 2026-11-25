import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {formatDuration, formatTime, nextCron, nextRun, parseAt, parseCron, parseDuration, parseSchedule, rezoneJobs} from '../src/schedule.js';
import type {Job} from '../src/store.js';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = local(2026, 10, 24, 12, 30);

describe('durations and times', () => {
	it('parses durations and refuses the rest', () => {
		assert.equal(parseDuration('90s'), 90_000);
		assert.equal(parseDuration('1h30m'), 5_400_000);
		assert.equal(parseDuration('2d'), 172_800_000);
		for (const bad of ['', '10', 'm', '1x', '0m', '400d', '1.5h']) assert.throws(() => parseDuration(bad), /duration/, bad);
		assert.equal(formatDuration(5_400_000), '1h30m');
	});

	it('parses dates, local times and clock times (today, or tomorrow once passed)', () => {
		assert.equal(parseAt('2026-10-25T09:00', NOW), local(2026, 10, 25, 9));
		assert.equal(parseAt('2026-10-25', NOW), local(2026, 10, 25));
		assert.equal(parseAt('2026-10-25T09:00:00Z', NOW), Date.UTC(2026, 9, 25, 9));
		assert.equal(parseAt('13:00', NOW), local(2026, 10, 24, 13));
		assert.equal(parseAt('09:00', NOW), local(2026, 10, 25, 9));
		for (const bad of ['25:00', '2026-02-30', 'tomorrow', '2026-10-25 09:00']) assert.throws(() => parseAt(bad, NOW), /time/i, bad);
	});
});

describe('cron', () => {
	it('finds the next matching minute', () => {
		const at = (expr: string, after = NOW) => nextCron(parseCron(expr), after);
		assert.equal(at('*/15 * * * *'), local(2026, 10, 24, 12, 45));
		assert.equal(at('0 9 * * *'), local(2026, 10, 25, 9));
		assert.equal(at('0 9 * * mon-fri'), local(2026, 10, 26, 9), 'Oct 24 2026 is a Saturday');
		assert.equal(at('30 12 * * *'), local(2026, 10, 25, 12, 30), 'strictly after now');
		assert.equal(at('0 0 1 jan *'), local(2027, 1, 1));
		assert.equal(at('0 0 29 2 *'), local(2028, 2, 29));
		assert.equal(at('0 0 31 2 *'), undefined, 'never');
		assert.equal(at('0 8 1 * 1'), local(2026, 10, 26, 8), 'day of month or day of week, as in cron');
		assert.equal(at('0 8 * * 7'), local(2026, 10, 25, 8), '7 is Sunday');
	});

	it('refuses broken expressions', () => {
		for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', '*/0 * * * *', 'x * * * *', '* * * 13 *']) {
			assert.throws(() => parseCron(bad), /cron/, bad);
		}
	});
});

describe('schedules', () => {
	it('reads the schedule words and leaves the rest', () => {
		assert.deepEqual(parseSchedule(['in', '10m', 'sh', 'ls'], NOW), {schedule: {kind: 'once', at: NOW + 600_000}, text: 'in 10m', first: NOW + 600_000, rest: ['sh', 'ls']});
		const every = parseSchedule(['every', '1h', 'cmd', 'task', 'list'], NOW);
		assert.deepEqual(every.schedule, {kind: 'every', everyMs: 3_600_000, anchor: NOW + 3_600_000});
		assert.equal(every.first, NOW + 3_600_000);
		assert.deepEqual(parseSchedule(['daily', '09:00', 'sh', 'x'], NOW).schedule, {kind: 'cron', expr: '0 9 * * *'});
		const cron = parseSchedule(['cron', '0', '9', '*', '*', '1-5', 'sh', 'x'], NOW);
		assert.deepEqual([cron.schedule, cron.text, cron.rest], [{kind: 'cron', expr: '0 9 * * 1-5'}, 'cron 0 9 * * 1-5', ['sh', 'x']]);
		assert.throws(() => parseSchedule(['every', '30s'], NOW), /at least 1m/);
		assert.throws(() => parseSchedule(['at', '2020-01-01'], NOW), /already passed/);
		assert.throws(() => parseSchedule(['cron', '0', '0', '31', '2', '*'], NOW), /never runs/);
		assert.throws(() => parseSchedule(['soon'], NOW), /The schedule is one of/);
	});

	it('every keeps its rhythm: a missed run is not repeated, the next one is the next slot', () => {
		const s = {kind: 'every' as const, everyMs: 3_600_000, anchor: NOW};
		assert.equal(nextRun(s, NOW), NOW + 3_600_000);
		assert.equal(nextRun(s, NOW + 5.5 * 3_600_000), NOW + 6 * 3_600_000);
		assert.equal(nextRun({kind: 'once', at: NOW}, NOW), undefined);
	});
});

describe('zones', () => {
	const KYIV = 'Europe/Kyiv';
	const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

	it('reads a clock time and a date without offset in the zone, and keeps explicit offsets', () => {
		const now = utc(2026, 11, 25, 7, 14);
		assert.equal(parseAt('10:00', now, KYIV), utc(2026, 11, 25, 8, 0));
		assert.equal(parseAt('09:00', now, KYIV), utc(2026, 11, 26, 7, 0), 'rolls to the next wall day once passed');
		assert.equal(parseAt('2026-12-01T09:00', now, KYIV), utc(2026, 12, 1, 7, 0));
		assert.equal(parseAt('2026-07-01', now, KYIV), utc(2026, 6, 30, 21, 0));
		assert.equal(parseAt('2026-12-01T09:00Z', now, KYIV), utc(2026, 12, 1, 9, 0));
		assert.equal(parseAt('2026-12-01T09:00+05:00', now, KYIV), utc(2026, 12, 1, 4, 0));
		assert.throws(() => parseAt('2026-02-30', now, KYIV), /Invalid time/);
	});

	it('a clock time rolls over on the zone calendar, not the UTC one', () => {
		const now = utc(2026, 11, 25, 22, 30);
		assert.equal(parseAt('01:00', now, KYIV), utc(2026, 11, 25, 23, 0));
		assert.equal(parseAt('01:00', now, 'UTC'), utc(2026, 11, 26, 1, 0));
	});

	it('daily and cron follow the zone', () => {
		const now = utc(2026, 11, 25, 7, 14);
		assert.equal(nextCron(parseCron('0 9 * * *'), now, KYIV), utc(2026, 11, 26, 7, 0));
		assert.equal(nextCron(parseCron('0 9 * * *'), now, 'UTC'), utc(2026, 11, 25, 9, 0));
		assert.equal(nextRun({kind: 'cron', expr: '30 9 * * *'}, now, KYIV), utc(2026, 11, 25, 7, 30));
		const parsed = parseSchedule(['daily', '10:00', 'cmd', 'x'], now, KYIV);
		assert.equal(parsed.first, utc(2026, 11, 25, 8, 0));
		assert.deepEqual(parsed.rest, ['cmd', 'x']);
	});

	it('a slot in the spring gap runs at the shifted instant, once', () => {
		const before = utc(2026, 3, 28, 12, 0);
		const gap = nextCron(parseCron('30 3 * * *'), before, KYIV);
		assert.equal(gap, utc(2026, 3, 29, 1, 30));
		assert.equal(nextCron(parseCron('30 3 * * *'), gap!, KYIV), utc(2026, 3, 30, 0, 30));
	});

	it('a repeated autumn hour runs once, at the earlier instant', () => {
		const before = utc(2026, 10, 24, 12, 0);
		const first = nextCron(parseCron('30 3 * * *'), before, KYIV);
		assert.equal(first, utc(2026, 10, 25, 0, 30));
		assert.equal(nextCron(parseCron('30 3 * * *'), first!, KYIV), utc(2026, 10, 26, 1, 30));
		assert.equal(nextCron(parseCron('30 3 * * *'), utc(2026, 10, 25, 1, 10), KYIV), utc(2026, 10, 26, 1, 30));
	});

	it('formatTime shows the zone wall clock and its short name', () => {
		assert.match(formatTime(utc(2026, 11, 25, 7, 14), KYIV), /^2026-11-25 09:14 /);
		assert.match(formatTime(utc(2026, 11, 25, 7, 14), 'UTC'), /^2026-11-25 07:14 UTC$/);
	});

	it('rezoneJobs moves only the cron jobs still ahead, and only when the zone changes', () => {
		const now = utc(2026, 11, 25, 7, 14);
		const cron = (id: number, next: number, paused?: boolean): Job => ({
			id,
			schedule: {kind: 'cron', expr: '0 9 * * *'},
			when: 'daily 09:00',
			action: {kind: 'cmd', line: 'x'},
			next,
			createdAt: 0,
			runs: 0,
			by: 'user',
			...(paused && {paused}),
		});
		const state = {
			zone: 'UTC',
			jobs: [
				cron(1, utc(2026, 11, 26, 9)),
				cron(2, utc(2026, 11, 26, 9), true),
				cron(3, utc(2026, 11, 25, 6)),
				{...cron(4, utc(2026, 11, 26, 9)), schedule: {kind: 'every', everyMs: 60_000, anchor: 0} as const},
				{...cron(5, utc(2026, 11, 26, 9)), schedule: {kind: 'once', at: utc(2026, 11, 26, 9)} as const},
			],
		};
		assert.equal(rezoneJobs(state, KYIV, now), 2);
		assert.deepEqual(state.jobs.map(j => j.next), [utc(2026, 11, 26, 7), utc(2026, 11, 26, 7), utc(2026, 11, 25, 6), utc(2026, 11, 26, 9), utc(2026, 11, 26, 9)]);
		assert.equal(state.zone, KYIV);
		assert.equal(rezoneJobs(state, KYIV, now), 0);
	});
});
