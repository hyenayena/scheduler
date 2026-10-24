import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {formatDuration, nextCron, nextRun, parseAt, parseCron, parseDuration, parseSchedule} from '../src/schedule.js';

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
