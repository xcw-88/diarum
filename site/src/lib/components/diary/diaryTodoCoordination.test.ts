// @ts-nocheck
/**
 * Cross-surface card / editor coordination, driven for real.
 *
 * Two ways the read-only card and the inline editor used to end up disagreeing
 * about one Event's status, and the editor's first autosave then wrote the
 * older value back:
 *
 *  - **Controller Review Fix 2 (P1-2), the entry race.** Opening the Event while
 *    the card's `normal -> pending` was still on the wire seeded the editor with
 *    `normal`. Covered by the `C` suite: the gate waits for that Event's own
 *    write and re-reads the model afterwards.
 *  - **Controller Review Fix 3 (P1-3), the live-list replacement race.** A list
 *    `GET` issued *before* the write was accepted observes the old status and,
 *    when it returns, replaces the whole day — including the row the write had
 *    just moved, and including the row the gate then re-reads. Covered by the
 *    `R` suite: an accepted status is recorded against a revision and is not
 *    overwritten by a response that started before it, while a response that
 *    starts afterwards keeps the server's answer.
 *
 * All of it is real execution rather than source assertions:
 *
 *  - `createPageHarness` composes the production pieces — the pending registry,
 *    the accepted-status overlay, the entry gate, the REAL `DiaryEditorOwnership`
 *    and the REAL `runDiaryTodoAction` transaction — over a status transport and
 *    a list transport the test releases by hand. The list transport snapshots
 *    the server when it is *issued*, which is what makes an in-flight response
 *    stale instead of merely slow;
 *  - the second suite seeds the REAL `WorkMemoSaveMachine` the way production
 *    seeds it, and shows what that first autosave sends. Its negative control is
 *    the write that used to do the damage.
 *
 * A small source guard at the end only checks that the component routes through
 * this coordinator; the behaviour is covered above, not there.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
	DiaryTodoAcceptedStatuses,
	DiaryTodoPendingMutations,
	enterEventWhenTodoSettled
} from './diaryTodoCoordination.ts';
import { DiaryEditorOwnership, memoEventTarget } from './diaryEditorOwnership.ts';
import { runDiaryTodoAction } from './diaryTodoStatus.ts';
import { WorkMemoSaveMachine } from '../worklog/workMemoSaveMachine.ts';
import { isContentEffectivelyEmpty } from '../worklog/workMemoContent.ts';

/** Lets queued microtasks run without letting the machine's timers fire. */
const settleMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The page, minus Svelte.
 *
 * Models the two things this coordination is about: the **live list** the
 * component renders — which every load replaces with new objects — and the
 * **server** the requests observe. The card's status request and the list
 * request are both hand-released promises, so "that response was already on the
 * wire" is a deterministic interleaving rather than a timing guess.
 */
function createPageHarness(options = {}) {
	const seeds = options.memos ?? [
		{ id: 'm1', status: 'normal', content: '<p>one</p>' },
		{ id: 'm2', status: 'normal', content: '<p>two</p>' }
	];

	/** What a request observes: the server's own state. */
	const server = new Map(seeds.map((seed) => [seed.id, { ...seed }]));
	/** The list the page renders. Every load replaces it with new objects. */
	let live = seeds.map((seed) => ({ ...seed }));

	const pending = new DiaryTodoPendingMutations();
	const accepted = new DiaryTodoAcceptedStatuses();

	/** Every status-only request the card issued, with its release handles. */
	const statusRequests = [];
	/** Every list request, with what it observed and when it started. */
	const loads = [];
	/** What the editor was seeded with, at the moment it was opened. */
	const enters = [];
	/** Every slot the ownership applied. */
	const applied = [];

	/**
	 * The page's model, read the way the component reads it: by looking the row
	 * up in the live list, never by holding on to an object.
	 */
	const model = { get: (id) => live.find((row) => row.id === id) ?? null };

	const ownership = new DiaryEditorOwnership({
		apply: (slot) => applied.push({ kind: slot.kind, target: slot.target }),
		flush: async () => {}
	});

	function statusTransport(id, status) {
		let release;
		const promise = new Promise((resolve, reject) => {
			release = { resolve, reject };
		});
		statusRequests.push({ id, status, promise, release });
		return promise;
	}

	function setServerStatus(id, status) {
		const row = server.get(id);
		if (row) row.status = status;
	}

	/** One card tap: the production transaction, over the status-only endpoint. */
	async function tapCard(id, action) {
		// The object the click carries: the row the card was rendered from.
		const memo = model.get(id);
		if (pending.isPending(id)) return null;
		return pending.track(
			id,
			(async () => {
				const result = await runDiaryTodoAction(
					{
						isPersisted: () => true,
						isDraftEmpty: () => false,
						getStatus: () => memo.status,
						makeBodyDurable: async () => {},
						commitStatus: async (next) => {
							await statusTransport(id, next);
							// The accepted PUT is what makes the server hold it.
							setServerStatus(id, next);
						}
					},
					action
				);
				if (!result.ok) return result;
				// `applyAcceptedCardStatus` in the component: record it, then move
				// the row that is in the list NOW — not the object the click
				// carried, which a response may already have replaced.
				accepted.recordAcceptedStatus(id, result.status);
				accepted.applyStatusToRows(live, id, result.status);
				return result;
			})()
		);
	}

	/**
	 * `loadMemos`. What the response carries is decided when it is *issued* —
	 * that is what makes an in-flight response stale rather than merely slow.
	 */
	function startLoad() {
		const loadStartedAtRevision = accepted.getAcceptedRevision();
		const observed = new Map([...server].map(([id, row]) => [id, { ...row }]));

		let releaseLoad;
		const onTheWire = new Promise((resolve) => {
			releaseLoad = resolve;
		});
		const applied = onTheWire.then(() => {
			const loaded = [...observed].map(([id, row]) => ({
				id,
				status: row.status,
				content: row.content
			}));
			live = accepted.reconcileLoadedMemos(loaded, loadStartedAtRevision);
			return live;
		});

		const handle = { loadStartedAtRevision, observed, applied, release: () => releaseLoad() };
		loads.push(handle);
		return handle;
	}

	/** The production entry path: gate, then the ownership transition. */
	function openEvent(id) {
		return enterEventWhenTodoSettled(id, {
			settleTodo: (memoId) => pending.settle(memoId),
			readMemo: (memoId) => model.get(memoId),
			enter: (fresh) => {
				// What `DiaryEventEditor` does on mount: it seeds its session from
				// the memo it is handed, so the recorded status IS the editor's
				// initial status.
				enters.push({ id: fresh.id, status: fresh.status });
				return ownership.enterEvent(memoEventTarget(fresh.id));
			}
		});
	}

	return {
		server,
		model,
		liveRows: () => live,
		liveRow: (id) => model.get(id),
		acceptedRevision: () => accepted.getAcceptedRevision(),
		setServerStatus,
		pending,
		statusRequests,
		loads,
		enters,
		applied,
		ownership,
		tapCard,
		startLoad,
		openEvent
	};
}

/**
 * Persist one body change through the REAL machine, seeded exactly as the
 * production editor seeds it: `initialSnapshot.status` is the status the editor
 * was handed.
 */
async function firstAutosave(seedStatus) {
	const sent = [];
	const machine = new WorkMemoSaveMachine({
		date: '2026-09-24',
		memoId: 'm1',
		initialSnapshot: { content: '<p>one</p>', status: seedStatus, isPinned: false },
		create: async () => 'm1',
		update: async (_id, snapshot) => {
			sent.push({ ...snapshot });
		},
		remove: async () => {},
		debounceMs: 5,
		emptyContentPredicate: isContentEffectivelyEmpty
	});
	// `WorkMemoEditingSession.handleContentChange` schedules with the status the
	// session holds — which is the seeded one until the user changes it.
	machine.schedule({ content: '<p>one edited</p>', status: seedStatus, isPinned: false });
	await machine.flush();
	return sent;
}

describe('P1-2 — an Event is never opened on a status that is still in flight', () => {
	it('C1: opening waits for the card write, then seeds from the status it landed', async () => {
		const h = createPageHarness();

		const tap = h.tapCard('m1', 'set-pending');
		const open = h.openEvent('m1');

		await settleMicrotasks();
		assert.equal(h.statusRequests.length, 1, 'the card request is on the wire');
		assert.deepEqual(h.enters, [], 'no editor may be created while that write is unsettled');
		assert.deepEqual(h.applied, [], 'and the slot must not have moved either');

		h.statusRequests[0].release.resolve();
		await Promise.all([tap, open]);

		assert.deepEqual(
			h.enters,
			[{ id: 'm1', status: 'pending' }],
			'the editor is seeded from the status that actually landed'
		);
		assert.deepEqual(
			h.applied.filter((slot) => slot.kind === 'event'),
			[{ kind: 'event', target: 'memo:m1' }],
			'and only then does the slot move — exactly one editor'
		);
	});

	it('C2: a failed card write opens the editor on the status the card still shows', async () => {
		const h = createPageHarness();

		const tap = h.tapCard('m1', 'set-pending');
		const open = h.openEvent('m1');
		await settleMicrotasks();
		assert.deepEqual(h.enters, []);

		h.statusRequests[0].release.reject(new TypeError('Failed to fetch'));
		await Promise.all([tap, open]);

		assert.equal(h.model.get('m1').status, 'normal', 'the failed write changed nothing');
		assert.deepEqual(
			h.enters,
			[{ id: 'm1', status: 'normal' }],
			'the editor opens on the previous status, which is what the card shows'
		);
		assert.equal(h.pending.isPending('m1'), false, 'and nothing is left pending');
	});

	it('C3: pending -> completed in flight also opens on the landed status', async () => {
		const h = createPageHarness({ memos: [{ id: 'm1', status: 'pending', content: '<p>one</p>' }] });

		const tap = h.tapCard('m1', 'complete');
		const open = h.openEvent('m1');
		await settleMicrotasks();
		assert.deepEqual(h.enters, []);

		h.statusRequests[0].release.resolve();
		await Promise.all([tap, open]);

		assert.deepEqual(h.enters, [{ id: 'm1', status: 'completed' }]);
	});

	it('C4: two rapid opens cannot produce two editors', async () => {
		const h = createPageHarness();

		const tap = h.tapCard('m1', 'set-pending');
		const first = h.openEvent('m1');
		const second = h.openEvent('m1');
		await settleMicrotasks();
		assert.deepEqual(h.enters, [], 'neither open may start while the write is pending');

		h.statusRequests[0].release.resolve();
		await Promise.all([tap, first, second]);

		assert.deepEqual(
			h.applied.map((slot) => slot.kind),
			['none', 'event'],
			'the slot walked the two-phase handoff exactly once'
		);
		assert.equal(h.ownership.target, 'memo:m1');
		assert.equal(
			h.applied.filter((slot) => slot.kind === 'event').length,
			1,
			'the ownership single-flight is intact: no second editor was applied'
		);
	});

	it('C6: a write in flight for another Event does not delay this one', async () => {
		const h = createPageHarness();

		const tap = h.tapCard('m1', 'set-pending');
		await settleMicrotasks();
		assert.equal(h.statusRequests.length, 1, 'm1 is still on the wire');
		assert.equal(h.pending.isPending('m1'), true);

		// Deliberately NOT released: m2 must open without waiting for m1.
		await h.openEvent('m2');

		assert.deepEqual(
			h.enters,
			[{ id: 'm2', status: 'normal' }],
			'm2 opened while m1’s write was still in flight'
		);
		assert.equal(h.pending.isPending('m1'), true, 'and m1’s own write is untouched by that');

		h.statusRequests[0].release.resolve();
		await tap;
		assert.equal(h.model.get('m1').status, 'pending', 'which still lands normally');
	});

	it('an Event that is no longer listed is not opened', async () => {
		const h = createPageHarness();

		const outcome = await h.openEvent('gone');

		assert.equal(outcome, 'missing');
		assert.deepEqual(h.applied, []);
	});
});

/**
 * Controller Review Fix 3 (P1-3) — a live-list replacement must not resurrect a
 * status the card write already moved.
 *
 * The entry gate alone cannot close this one: a response that was already on the
 * wire puts the *model* back in time, and re-reading the model afterwards then
 * faithfully hands over the stale row.
 */
describe('Fix 3 — a list response cannot overwrite a status this page accepted', () => {
	/** Bring the page to "m1 = pending, accepted, nothing in flight". */
	async function acceptPending(h) {
		const tap = h.tapCard('m1', 'set-pending');
		await settleMicrotasks();
		h.statusRequests[0].release.resolve();
		await tap;
		assert.equal(
			h.liveRow('m1').status,
			'pending',
			'precondition: the acceptance moved the live row'
		);
		assert.equal(h.acceptedRevision(), 1, 'precondition: exactly one acceptance');
	}

	it('R1: a response already on the wire is applied under the accepted status', async () => {
		const h = createPageHarness();

		// 1. the card starts normal -> pending, and the PUT is on the wire
		const tap = h.tapCard('m1', 'set-pending');
		await settleMicrotasks();
		assert.equal(h.pending.isPending('m1'), true);

		// 2-4. a list request goes out while that write is in flight; it observes
		//      the OLD server status
		const stale = h.startLoad();
		assert.equal(
			stale.observed.get('m1').status,
			'normal',
			'the response carries the pre-mutation status'
		);

		// 5-6. that response lands first and replaces the whole list, so the page
		//      now renders a DIFFERENT object for m1
		const clickTimeRow = h.liveRow('m1');
		stale.release();
		await stale.applied;
		assert.notEqual(h.liveRow('m1'), clickTimeRow, 'the response replaced the row object');
		assert.equal(h.liveRow('m1').status, 'normal', 'and what it brought back is the old status');

		// 7-8. the card write is accepted afterwards
		h.statusRequests[0].release.resolve();
		await tap;
		assert.equal(
			h.liveRow('m1').status,
			'pending',
			'an accepted status belongs to the row in the list, not to the object the click carried'
		);

		// 9-11. opening the Event hands the editor the accepted status
		await h.openEvent('m1');
		assert.deepEqual(h.enters, [{ id: 'm1', status: 'pending' }]);

		// and the editor's first autosave carries it as well
		const sent = await firstAutosave(h.enters[0].status);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].status, 'pending', 'the autosave must not write the old status back');
	});

	it('R2: a response that lands after the write cannot take it back', async () => {
		const h = createPageHarness();

		// the response goes out first, while the server still says normal
		const stale = h.startLoad();
		assert.equal(stale.observed.get('m1').status, 'normal');

		// the write is accepted in the meantime
		await acceptPending(h);

		// now that response arrives and replaces the whole list
		stale.release();
		await stale.applied;

		assert.equal(
			h.liveRow('m1').status,
			'pending',
			'a response that started before the acceptance must not undo it'
		);
	});

	it('R3: a response that starts after the acceptance stays authoritative', async () => {
		const h = createPageHarness();
		await acceptPending(h);

		// another device completes it, so the server now holds completed
		h.setServerStatus('m1', 'completed');

		// a fresh request: issued AFTER the acceptance
		const fresh = h.startLoad();
		assert.equal(
			fresh.loadStartedAtRevision,
			h.acceptedRevision(),
			'the acceptance is already known when this request goes out'
		);
		fresh.release();
		await fresh.applied;

		assert.equal(
			h.liveRow('m1').status,
			'completed',
			'the overlay must not outlive its evidence and hide another device’s change'
		);
	});

	it('R4: a refused write records nothing, so the server keeps deciding', async () => {
		const h = createPageHarness();

		const stale = h.startLoad();
		const tap = h.tapCard('m1', 'set-pending');
		await settleMicrotasks();
		h.statusRequests[0].release.reject(new TypeError('Failed to fetch'));
		await tap;

		assert.equal(h.acceptedRevision(), 0, 'a refusal accepts nothing');
		assert.equal(h.liveRow('m1').status, 'normal', 'and it moved no row');

		// the gate still opens the editor on the status the card shows
		await h.openEvent('m1');
		assert.deepEqual(h.enters, [{ id: 'm1', status: 'normal' }]);

		// the in-flight response is applied as the server sent it
		stale.release();
		await stale.applied;
		assert.equal(h.liveRow('m1').status, 'normal');

		// and a change made elsewhere still reaches the page afterwards
		h.setServerStatus('m1', 'completed');
		const fresh = h.startLoad();
		fresh.release();
		await fresh.applied;
		assert.equal(h.liveRow('m1').status, 'completed');
	});

	it('R5: two acceptances for one Event leave only the latest in force', async () => {
		const h = createPageHarness();

		// a response that starts before either acceptance
		const stale = h.startLoad();

		await acceptPending(h); // normal -> pending, revision 1

		const second = h.tapCard('m1', 'complete');
		await settleMicrotasks();
		h.statusRequests[1].release.resolve();
		await second;
		assert.equal(h.liveRow('m1').status, 'completed', 'precondition: pending -> completed landed');
		assert.equal(h.acceptedRevision(), 2);

		stale.release();
		await stale.applied;

		assert.equal(
			h.liveRow('m1').status,
			'completed',
			'the stale response must be corrected to the LATEST acceptance, not the first'
		);
	});

	it('R6: an accepted status never bleeds onto another Event', async () => {
		const h = createPageHarness();

		// the server says completed for m2 — another device moved it
		h.setServerStatus('m2', 'completed');
		const stale = h.startLoad();
		assert.equal(stale.observed.get('m2').status, 'completed');

		await acceptPending(h); // m1 normal -> pending

		stale.release();
		await stale.applied;

		assert.equal(h.liveRow('m1').status, 'pending', 'm1 keeps what this page accepted');
		assert.equal(h.liveRow('m2').status, 'completed', 'm2 is untouched by m1’s record');
	});
});

describe('DiaryTodoAcceptedStatuses', () => {
	it('counts acceptances and reports what it recorded', () => {
		const accepted = new DiaryTodoAcceptedStatuses();

		assert.equal(accepted.getAcceptedRevision(), 0);
		assert.equal(accepted.recordAcceptedStatus('m1', 'pending'), 1);
		assert.equal(accepted.recordAcceptedStatus('m1', 'completed'), 2);
		assert.equal(accepted.recordAcceptedStatus('m2', 'pending'), 3);
		assert.equal(accepted.getAcceptedRevision(), 3);
	});

	it('patches rows by id, and reports a row it does not have', () => {
		const accepted = new DiaryTodoAcceptedStatuses();
		const rows = [
			{ id: 'm1', status: 'normal' },
			{ id: 'm2', status: 'normal' }
		];

		assert.equal(accepted.applyStatusToRows(rows, 'm1', 'pending'), true);
		assert.equal(accepted.applyStatusToRows(rows, 'gone', 'pending'), false);
		assert.deepEqual(rows, [
			{ id: 'm1', status: 'pending' },
			{ id: 'm2', status: 'normal' }
		]);
	});

	it('corrects only what a response could not have observed, in place', () => {
		const accepted = new DiaryTodoAcceptedStatuses();
		accepted.recordAcceptedStatus('m1', 'pending'); // revision 1

		const staleRows = [{ id: 'm1', status: 'normal' }];
		assert.equal(
			accepted.reconcileLoadedMemos(staleRows, 0),
			staleRows,
			'the same array, so the call site can assign it straight to the model'
		);
		assert.equal(staleRows[0].status, 'pending', 'this response started before the acceptance');

		const freshRows = [{ id: 'm1', status: 'completed' }];
		accepted.reconcileLoadedMemos(freshRows, 1);
		assert.equal(freshRows[0].status, 'completed', 'this one started after it, so it is newer');
	});
});

describe('P1-2 — the editor can no longer write the pre-mutation status back', () => {
	it('C5: seeded from the status the gate handed over, the first autosave carries it', async () => {
		const h = createPageHarness();

		const tap = h.tapCard('m1', 'set-pending');
		const open = h.openEvent('m1');
		await settleMicrotasks();
		h.statusRequests[0].release.resolve();
		await Promise.all([tap, open]);

		const seeded = h.enters[0];
		assert.equal(seeded.status, 'pending', 'precondition: the gate handed over the landed status');

		const sent = await firstAutosave(seeded.status);

		assert.equal(sent.length, 1);
		assert.equal(sent[0].status, 'pending', 'the autosave must not write the status it was opened with');
		assert.equal(sent[0].content, '<p>one edited</p>', 'and it still carries the edited body');
	});

	it('negative control: seeded from the click-time memo, that same autosave reverts the todo', async () => {
		// What the pre-fix entry gave the editor: the status captured when the
		// card was clicked, i.e. before its write landed. Both statuses are valid
		// on their own — only the interleaving is wrong.
		const sent = await firstAutosave('normal');

		assert.equal(sent.length, 1);
		assert.equal(
			sent[0].status,
			'normal',
			'this is the write that used to undo the "pending" the user had just been shown'
		);
	});
});

describe('DiaryTodoPendingMutations', () => {
	it('settle resolves immediately when nothing is in flight', async () => {
		const pending = new DiaryTodoPendingMutations();

		await pending.settle('nobody');

		assert.deepEqual(pending.pendingIds, []);
	});

	it('a rejected mutation settles its waiters instead of throwing at them', async () => {
		const pending = new DiaryTodoPendingMutations();
		let reject;
		const mutation = new Promise((_resolve, rej) => {
			reject = rej;
		});

		pending.track('m1', mutation);
		const settled = pending.settle('m1');
		reject(new Error('boom'));

		await settled; // must not throw: the model keeps the old status
		assert.equal(pending.isPending('m1'), false, 'and the handle is released');
	});

	it('notifies subscribers and reports the ids in tracking order', async () => {
		const pending = new DiaryTodoPendingMutations();
		const seen = [];
		const unsubscribe = pending.subscribe(() => seen.push(pending.pendingIds));

		pending.track('m1', Promise.resolve());
		pending.track('m2', new Promise(() => {}));
		await settleMicrotasks();
		unsubscribe();

		assert.deepEqual(seen[0], ['m1']);
		assert.deepEqual(seen.at(-1), ['m2']);
		assert.deepEqual(pending.pendingIds, ['m2']);
	});

	it('an older mutation settling does not clear a newer handle for the same id', async () => {
		const pending = new DiaryTodoPendingMutations();
		let resolveFirst;
		const first = new Promise((resolve) => {
			resolveFirst = resolve;
		});

		pending.track('m1', first);
		pending.track('m1', new Promise(() => {}));
		resolveFirst();
		await settleMicrotasks();

		assert.equal(pending.isPending('m1'), true, 'the newer handle is still the tracked one');
	});
});

/**
 * Component wiring. There is still no component test framework in this project,
 * so — as in `diaryEditorOwnership.test.ts` — these assertions read the
 * `.svelte` source. They are a guard that the component routes through the
 * coordinator; the behaviour itself is covered by the real-promise suites above.
 */
describe('card/editor coordination wiring', () => {
	const source = readFileSync(new URL('./DiaryEvents.svelte', import.meta.url), 'utf8');

	it('the card mutation is registered before it is awaited', () => {
		assert.match(
			source,
			/todoMutations\.track\(\s*memo\.id,/,
			'the in-flight write must be visible to the entry gate'
		);
	});

	it('the accepted status is recorded and applied to the live row inside that promise', () => {
		assert.match(source, /const accepted = await persistCardTodoStatus\(memo, action\)/);
		assert.match(source, /if \(accepted !== null\) applyAcceptedCardStatus\(memo\.id, accepted\)/);
		assert.match(source, /todoAccepted\.recordAcceptedStatus\(id, status\)/);
		assert.match(
			source,
			/todoAccepted\.applyStatusToRows\(memos, id, status\)/,
			'the row in the list is what moves, not the object the click carried'
		);
		assert.ok(
			!/memo\.status = result\.status/.test(source),
			'a captured object must no longer be the only place an accepted status lands'
		);
	});

	it('the list path reads the revision before the request and reconciles after it', () => {
		assert.match(source, /const loadStartedAtRevision = todoAccepted\.getAcceptedRevision\(\)/);
		assert.match(
			source,
			/memos = todoAccepted\.reconcileLoadedMemos\(result\.memos, loadStartedAtRevision\)/,
			'the response must be corrected on its way into the model'
		);
		assert.ok(
			!/memos = result\.memos/.test(source),
			'a raw response must not be assigned to the model unchecked'
		);
	});

	it('the entry point goes through the gate instead of straight to the slot', () => {
		assert.match(source, /enterEventWhenTodoSettled\(memo\.id, \{/);
		assert.match(
			source,
			/readMemo: \(id\) => memos\.find\(/,
			'the memo must be re-read after the write settles'
		);
		assert.ok(
			!/requestEvent\(memoEventTarget\(memo\.id\)\)/.test(source),
			'openEvent must not bypass the gate with the click-time memo'
		);
	});

	it('the busy state is a mirror of the registry, not a second source', () => {
		assert.match(source, /todoMutations\.subscribe\(/, 'the mirror must be driven by the registry');
		assert.ok(
			!/todoPendingIds = \[\.\.\.todoPendingIds/.test(source),
			'the pending list must not be hand-maintained alongside the registry'
		);
	});
});
