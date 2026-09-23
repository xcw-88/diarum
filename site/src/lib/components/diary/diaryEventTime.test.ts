// @ts-nocheck
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventTimeDisplay } from './diaryEventTime.ts';

/**
 * Build a timestamp in Diarum's storage format ("YYYY-MM-DD HH:MM:SS.mmmZ", a
 * UTC instant) from *local* wall-clock components, so every assertion below is
 * independent of the machine's timezone.
 */
function stampFromLocal(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number
): string {
	const local = new Date(year, month - 1, day, hour, minute, 0, 0);
	const p = (n: number) => String(n).padStart(2, '0');
	return (
		`${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())} ` +
		`${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:00.000Z`
	);
}

describe('getEventTimeDisplay', () => {
	it('reports a same-day entry with its local wall-clock time', () => {
		const display = getEventTimeDisplay('2026-09-23', stampFromLocal(2026, 9, 23, 14, 26));

		assert.equal(display.invalid, false);
		assert.equal(display.createdDate, '2026-09-23');
		assert.equal(display.backfilled, false);
		assert.equal(display.hours, 14);
		assert.equal(display.minutes, 26);
	});

	it('marks an entry written on another local day as a backfill', () => {
		// Written today, filed under yesterday.
		const display = getEventTimeDisplay('2026-09-22', stampFromLocal(2026, 9, 23, 14, 26));

		assert.equal(display.backfilled, true);
		assert.equal(display.createdDate, '2026-09-23');
	});

	it('compares the LOCAL date, not the UTC date, of the timestamp', () => {
		// 00:30 local on the 23rd is still 16:30 UTC on the 22nd in UTC+8. A UTC
		// comparison would mislabel this entry as a backfill.
		const display = getEventTimeDisplay('2026-09-23', stampFromLocal(2026, 9, 23, 0, 30));

		assert.equal(display.createdDate, '2026-09-23');
		assert.equal(display.backfilled, false);
		assert.equal(display.hours, 0);
		assert.equal(display.minutes, 30);
	});

	it('detects a backfill across local midnight in the other direction', () => {
		// 23:50 local on the 22nd, filed under the 23rd.
		const display = getEventTimeDisplay('2026-09-23', stampFromLocal(2026, 9, 22, 23, 50));

		assert.equal(display.createdDate, '2026-09-22');
		assert.equal(display.backfilled, true);
	});

	it('degrades safely for an unusable timestamp instead of throwing', () => {
		for (const bad of ['', 'not-a-date', undefined, null]) {
			const display = getEventTimeDisplay('2026-09-23', bad);
			assert.equal(display.invalid, true, `expected invalid for ${String(bad)}`);
			assert.equal(display.backfilled, false);
			assert.equal(display.createdDate, '');
		}
	});

	it('never claims a backfill when there is no diary date to compare against', () => {
		const display = getEventTimeDisplay('', stampFromLocal(2026, 9, 23, 14, 26));

		assert.equal(display.invalid, false);
		assert.equal(display.backfilled, false);
	});

	it('accepts both storage and ISO spellings of the same instant', () => {
		const iso = new Date(2026, 8, 23, 14, 26).toISOString();
		const stored = stampFromLocal(2026, 9, 23, 14, 26);

		const fromIso = getEventTimeDisplay('2026-09-23', iso);
		const fromStored = getEventTimeDisplay('2026-09-23', stored);

		assert.deepEqual(fromIso, fromStored);
	});
});
