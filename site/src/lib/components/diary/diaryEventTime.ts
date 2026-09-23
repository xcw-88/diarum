/**
 * Pure display logic for a Work Memo rendered as a Diary Event.
 *
 * Zero imports on purpose: `node --experimental-transform-types --test` loads it
 * directly, so the one decision that is easy to get wrong — whether an entry is
 * a backfill — is covered by a unit test instead of by eyeballing the UI.
 */

export interface DiaryEventTimeDisplay {
	/** Local calendar date (YYYY-MM-DD) of the creation instant. */
	createdDate: string;
	/**
	 * True when the entry was written on a different local calendar day than the
	 * diary it belongs to, i.e. it is a backfill ("补记").
	 */
	backfilled: boolean;
	/** Local wall-clock hour (0-23) of the creation instant. */
	hours: number;
	/** Local wall-clock minute (0-59) of the creation instant. */
	minutes: number;
	/** True when the stored timestamp could not be parsed at all. */
	invalid: boolean;
}

const INVALID: DiaryEventTimeDisplay = {
	createdDate: '',
	backfilled: false,
	hours: 0,
	minutes: 0,
	invalid: true
};

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/**
 * Diarum stores timestamps as `"YYYY-MM-DD HH:MM:SS.mmmZ"` (an instant in UTC)
 * while a Work Memo's `date` is the local date-only string chosen by the client.
 *
 * The backfill decision therefore has to be made on the **local** calendar date
 * of the creation instant. Comparing the UTC date would mislabel every entry
 * written between local midnight and the UTC offset as a backfill (e.g. in UTC+8
 * an entry created at 00:30 on the 23rd is stored as 16:30 on the 22nd).
 */
export function getEventTimeDisplay(
	diaryDate: string,
	createdIso: string
): DiaryEventTimeDisplay {
	if (!createdIso || typeof createdIso !== 'string') return INVALID;

	const created = new Date(createdIso);
	if (Number.isNaN(created.getTime())) return INVALID;

	const createdDate = `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}`;

	return {
		createdDate,
		backfilled: Boolean(diaryDate) && createdDate !== diaryDate,
		hours: created.getHours(),
		minutes: created.getMinutes(),
		invalid: false
	};
}
