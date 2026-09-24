// @ts-nocheck
/**
 * Unit tests for the diary Event todo state machine.
 *
 * §13 of the Task 2 spec asks for a specific matrix; each case is named with the
 * letter it covers so a reviewer can check coverage by reading the test names.
 * The `F`-prefixed suite at the end is Controller Review Fix 1.
 *
 * Three things are driven for real rather than asserted against source:
 *
 *  - `runDiaryTodoAction` runs against a scripted persistence double, which is
 *    how the ordering ("settle everything before the status moves") and the
 *    failure policy are pinned down;
 *  - the **real** `WorkMemoSaveMachine` — it has no runtime imports, so
 *    `node:test` can load it — sits behind the production commit adapter in
 *    `sessionHarness`, so Controller Review Fix 1's P1 (a barrier that persists
 *    and *then* fails its association step) is asserted against actual requests
 *    instead of against a mock's bookkeeping;
 *  - the §6 / §13 L race uses the same real machine with a fake transport, which
 *    is the only way to prove that a status change and a debounced body save
 *    converge on one snapshot instead of overwriting each other.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	DIARY_TODO_STATUSES,
	applyDiaryTodoAction,
	createSessionStatusCommit,
	diaryTodoActionLabelKey,
	diaryTodoBadgeKey,
	diaryTodoFailureKey,
	getDiaryTodoViewModel,
	isDiaryTodoStatus,
	normalizeDiaryTodoStatus,
	runDiaryTodoAction
} from './diaryTodoStatus.ts';
import { isWorkMemoStatusValue } from '../../api/workMemoStatusCore.ts';
import { WorkMemoSaveMachine } from '../worklog/workMemoSaveMachine.ts';
import { isContentEffectivelyEmpty } from '../worklog/workMemoContent.ts';

// ---------------------------------------------------------------------------
// The transition table
// ---------------------------------------------------------------------------

describe('§13 A–E — the transition table is the spec', () => {
	it('A: normal -> pending via "set as todo"', () => {
		assert.equal(applyDiaryTodoAction('normal', 'set-pending'), 'pending');
	});

	it('B: pending -> completed via the checkbox', () => {
		assert.equal(applyDiaryTodoAction('pending', 'complete'), 'completed');
	});

	it('C: completed -> pending via "reopen"', () => {
		assert.equal(applyDiaryTodoAction('completed', 'reopen'), 'pending');
	});

	it('D: pending -> normal via "remove todo"', () => {
		assert.equal(applyDiaryTodoAction('pending', 'clear'), 'normal');
	});

	it('E: completed -> normal via "remove todo"', () => {
		assert.equal(applyDiaryTodoAction('completed', 'clear'), 'normal');
	});

	it('refuses every transition the product does not offer', () => {
		const illegal = [
			['normal', 'complete'],
			['normal', 'reopen'],
			['normal', 'clear'],
			['pending', 'set-pending'],
			['pending', 'reopen'],
			['completed', 'set-pending'],
			['completed', 'complete']
		];
		for (const [status, action] of illegal) {
			assert.equal(
				applyDiaryTodoAction(status, action),
				null,
				`${status} --${action}--> must not be reachable`
			);
		}
	});

	it('never maps a legal action to the status it started from', () => {
		for (const status of DIARY_TODO_STATUSES) {
			for (const action of ['set-pending', 'complete', 'reopen', 'clear']) {
				const next = applyDiaryTodoAction(status, action);
				if (next !== null) {
					assert.notEqual(next, status, `${status} --${action}--> must actually change something`);
				}
			}
		}
	});
});

describe('status validity mirrors the wire validator (checked, not assumed)', () => {
	it('the local union and the API core agree, both ways', () => {
		for (const status of DIARY_TODO_STATUSES) {
			assert.equal(isWorkMemoStatusValue(status), true, `${status} must be a valid wire status`);
		}
		for (const value of DIARY_TODO_STATUSES) {
			assert.equal(isDiaryTodoStatus(value), true);
		}
		assert.equal(DIARY_TODO_STATUSES.length, 3, 'a fourth status would need a wire change too');
	});

	it('normalizes anything unusable to the conservative default', () => {
		assert.equal(normalizeDiaryTodoStatus('pending'), 'pending');
		for (const value of ['', 'Pending', null, undefined, 1, {}, []]) {
			assert.equal(normalizeDiaryTodoStatus(value), 'normal', `${JSON.stringify(value)} -> normal`);
			assert.equal(isDiaryTodoStatus(value), false);
		}
	});
});

describe('the view model is derived from the status alone', () => {
	it('normal offers only the opt-in affordance', () => {
		assert.deepEqual(getDiaryTodoViewModel('normal'), {
			status: 'normal',
			isTodo: false,
			checked: false,
			toggleAction: null,
			canSetPending: true,
			canClear: false
		});
	});

	it('pending is an unchecked box that completes', () => {
		assert.deepEqual(getDiaryTodoViewModel('pending'), {
			status: 'pending',
			isTodo: true,
			checked: false,
			toggleAction: 'complete',
			canSetPending: false,
			canClear: true
		});
	});

	it('completed is a checked box that reopens', () => {
		assert.deepEqual(getDiaryTodoViewModel('completed'), {
			status: 'completed',
			isTodo: true,
			checked: true,
			toggleAction: 'reopen',
			canSetPending: false,
			canClear: true
		});
	});

	it('garbled input renders as a plain, non-todo Event', () => {
		assert.deepEqual(getDiaryTodoViewModel('DONE'), getDiaryTodoViewModel('normal'));
	});

	it('N: a normal Event needs no todo treatment at all', () => {
		// §13 N — the only thing a plain Event shows is the opt-in button; there
		// is no badge, no checkbox and nothing to cancel.
		assert.equal(diaryTodoBadgeKey('normal'), null);
		assert.equal(getDiaryTodoViewModel('normal').isTodo, false);
		assert.equal(diaryTodoBadgeKey('pending'), 'worklog.statusPending');
		assert.equal(diaryTodoBadgeKey('completed'), 'worklog.statusCompleted');
	});
});

describe('text keys', () => {
	it('names an accessible action for every transition', () => {
		assert.equal(diaryTodoActionLabelKey('set-pending'), 'diaryEvents.todoSetPending');
		assert.equal(diaryTodoActionLabelKey('complete'), 'diaryEvents.todoMarkComplete');
		assert.equal(diaryTodoActionLabelKey('reopen'), 'diaryEvents.todoReopen');
		assert.equal(diaryTodoActionLabelKey('clear'), 'diaryEvents.todoCancel');
	});

	it('phrases failures, and says nothing for an impossible one', () => {
		assert.equal(diaryTodoFailureKey('empty-draft'), 'diaryEvents.todoNeedsContent');
		assert.equal(diaryTodoFailureKey('body-not-durable'), 'diaryEvents.todoFailed');
		assert.equal(diaryTodoFailureKey('status-not-saved'), 'diaryEvents.todoFailed');
		assert.equal(diaryTodoFailureKey('illegal-action'), null);
	});
});

// ---------------------------------------------------------------------------
// runDiaryTodoAction
// ---------------------------------------------------------------------------

/**
 * A scripted persistence double. Records the order of every side effect so the
 * ordering requirements — §5 and Fix 1's barrier — can be asserted instead of
 * described. The shape mirrors the **read-only card** composition: a stored row
 * whose barrier has nothing to settle, so the transaction's own ordering is what
 * this exercises.
 */
function persistenceDouble(options = {}) {
	const events = [];
	let status = options.status ?? 'normal';
	const state = {
		persisted: options.persisted ?? true,
		draftEmpty: options.draftEmpty ?? false,
		failBarrier: options.failBarrier ?? null,
		failCommit: options.failCommit ?? null,
		barrierAttempts: 0,
		commitAttempts: 0,
		commitArgs: []
	};

	const persistence = {
		isPersisted: () => state.persisted,
		isDraftEmpty: () => state.draftEmpty,
		getStatus: () => status,
		makeBodyDurable: async () => {
			state.barrierAttempts += 1;
			events.push('makeBodyDurable');
			if (state.failBarrier) throw state.failBarrier;
			// A successful barrier is what creates the row for a new Event.
			state.persisted = true;
		},
		commitStatus: async (next) => {
			state.commitAttempts += 1;
			state.commitArgs.push(next);
			events.push(`commitStatus:${next}`);
			if (state.failCommit) throw state.failCommit;
			status = next;
		}
	};

	return { persistence, state, events, getStatus: () => status };
}

describe('§13 A–E — the same transitions through the write path', () => {
	const cases = [
		['normal', 'set-pending', 'pending'],
		['pending', 'complete', 'completed'],
		['completed', 'reopen', 'pending'],
		['pending', 'clear', 'normal'],
		['completed', 'clear', 'normal']
	];

	for (const [from, action, to] of cases) {
		it(`${from} --${action}--> ${to}`, async () => {
			const h = persistenceDouble({ status: from });
			const result = await runDiaryTodoAction(h.persistence, action);

			assert.deepEqual(result, { ok: true, status: to, failure: null });
			assert.equal(h.getStatus(), to, 'the stored status moved');
			assert.deepEqual(
				h.events,
				['makeBodyDurable', `commitStatus:${to}`],
				'the barrier always runs first — for a stored row it simply has nothing to settle'
			);
			assert.equal(h.state.barrierAttempts, 1);
		});
	}

	it('an action the product does not offer touches nothing at all', async () => {
		const h = persistenceDouble({ status: 'normal' });
		const result = await runDiaryTodoAction(h.persistence, 'complete');

		assert.deepEqual(result, { ok: false, status: 'normal', failure: 'illegal-action' });
		assert.deepEqual(h.events, []);
		assert.equal(h.getStatus(), 'normal');
	});
});

describe('§13 I — a brand new Event secures the body BEFORE the status', () => {
	it('creates the row first, then writes the todo status', async () => {
		const h = persistenceDouble({ status: 'normal', persisted: false, draftEmpty: false });
		const result = await runDiaryTodoAction(h.persistence, 'set-pending');

		assert.deepEqual(result, { ok: true, status: 'pending', failure: null });
		assert.deepEqual(
			h.events,
			['makeBodyDurable', 'commitStatus:pending'],
			'the durability barrier must come first — the status has nowhere to live until the row exists'
		);
		assert.equal(h.state.barrierAttempts, 1);
		assert.equal(h.getStatus(), 'pending');
	});

	it('runs the barrier exactly once per action', async () => {
		const h = persistenceDouble({ status: 'pending' });
		await runDiaryTodoAction(h.persistence, 'complete');
		assert.equal(h.state.barrierAttempts, 1, 'once, and not once per status kind');
		assert.equal(h.state.commitAttempts, 1);
	});
});

describe('§13 J / K — a body that cannot be made durable leaves the status alone', () => {
	it('J: a failed barrier writes no status', async () => {
		const failure = new Error('create failed');
		const h = persistenceDouble({ status: 'normal', persisted: false, failBarrier: failure });
		const result = await runDiaryTodoAction(h.persistence, 'set-pending');

		assert.equal(result.ok, false);
		assert.equal(result.failure, 'body-not-durable');
		assert.equal(result.status, 'normal');
		assert.equal(h.state.commitAttempts, 0, 'no status request was issued');
		assert.deepEqual(h.events, ['makeBodyDurable'], 'the barrier was the only thing that ran');
		assert.equal(h.getStatus(), 'normal', 'the model did not move either');
	});

	it('K: an upload-backed rejection is handed through for the caller to phrase', async () => {
		// The editor's barrier is `session.flushDurably()`, which rejects with a
		// WorkMemoDurabilityError carrying `reason: 'uploads'`. The pure module
		// must not swallow or re-wrap it: `durabilityMessageKey` needs the
		// original to pick the right message.
		const uploadFailure = Object.assign(new Error('upload failed'), {
			name: 'WorkMemoDurabilityError',
			reason: 'uploads'
		});
		const h = persistenceDouble({ status: 'normal', persisted: false, failBarrier: uploadFailure });
		const result = await runDiaryTodoAction(h.persistence, 'set-pending');

		assert.equal(result.failure, 'body-not-durable');
		assert.equal(result.error, uploadFailure, 'the rejection is passed through untouched');
		assert.equal(h.state.commitAttempts, 0);
		assert.equal(h.getStatus(), 'normal');
	});

	it('an empty new draft is refused instead of creating a blank row', async () => {
		const h = persistenceDouble({ status: 'normal', persisted: false, draftEmpty: true });
		const result = await runDiaryTodoAction(h.persistence, 'set-pending');

		assert.deepEqual(result, { ok: false, status: 'normal', failure: 'empty-draft' });
		assert.deepEqual(h.events, [], 'nothing was created and nothing was written');
		assert.equal(h.state.persisted, false);
	});
});

describe('§13 G — a failed status write never moves the model', () => {
	it('reports failure and leaves the previous status in place', async () => {
		const failure = new TypeError('Failed to fetch');
		const h = persistenceDouble({ status: 'pending', failCommit: failure });
		const result = await runDiaryTodoAction(h.persistence, 'complete');

		assert.equal(result.ok, false);
		assert.equal(result.failure, 'status-not-saved');
		assert.equal(result.status, 'pending', 'the caller must keep rendering the old status');
		assert.equal(result.error, failure);
		assert.equal(h.getStatus(), 'pending', 'the persistence layer rolled itself back');
		assert.equal(h.state.commitAttempts, 1);
		assert.deepEqual(h.events, ['makeBodyDurable', 'commitStatus:completed']);
	});

	it('§13 F / M — only a bare status can reach the writer', async () => {
		const h = persistenceDouble({ status: 'normal' });
		const result = await runDiaryTodoAction(h.persistence, 'set-pending');

		assert.deepEqual(h.state.commitArgs, ['pending'], 'no object, no body, no snapshot');
		assert.equal(typeof h.state.commitArgs[0], 'string');
		assert.deepEqual(
			Object.keys(result).sort(),
			['failure', 'ok', 'status'],
			'the result cannot smuggle content, date, position or media through'
		);
	});
});

// ---------------------------------------------------------------------------
// §13 H — single flight
// ---------------------------------------------------------------------------

describe('§13 H — rapid taps cannot produce a runaway burst of requests', () => {
	/**
	 * Models the two components' guard. The `.svelte` files are the authority for
	 * this shape (`if (!session || todoBusy) return;` in DiaryEventEditor,
	 * `if (isTodoPending(memo.id)) return;` in DiaryEvents); keep this model in
	 * sync with them.
	 */
	function createSurface(persistence) {
		let busy = false;
		let admitted = 0;
		return {
			get admitted() {
				return admitted;
			},
			async act(action) {
				if (busy) return null; // the second tap is dropped, not queued
				busy = true;
				admitted += 1;
				try {
					return await runDiaryTodoAction(persistence, action);
				} finally {
					busy = false;
				}
			}
		};
	}

	it('five simultaneous taps produce exactly one write', async () => {
		const h = persistenceDouble({ status: 'normal' });
		const surface = createSurface(h.persistence);

		const results = await Promise.all(
			Array.from({ length: 5 }, () => surface.act('set-pending'))
		);

		assert.equal(surface.admitted, 1, 'one tap got through');
		assert.equal(h.state.commitAttempts, 1, 'one request left the app');
		assert.equal(h.state.barrierAttempts, 1);
		assert.equal(results.filter((r) => r !== null).length, 1);
		assert.ok(results.find((r) => r !== null).ok);
	});

	it('taps after the first settles are admitted again', async () => {
		const h = persistenceDouble({ status: 'normal' });
		const surface = createSurface(h.persistence);

		assert.equal((await surface.act('set-pending')).ok, true);
		assert.equal((await surface.act('complete')).ok, true);
		assert.equal(h.getStatus(), 'completed');
		assert.equal(h.state.commitAttempts, 2);
	});
});

// ---------------------------------------------------------------------------
// §6 / §13 L — the status change and the body save share ONE snapshot
// ---------------------------------------------------------------------------

describe('§6 / §13 L — a status change cannot clobber a body being edited', () => {
	/** The real machine, wrapped in a transport that records what was sent. */
	function machineHarness() {
		const sent = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const machine = new WorkMemoSaveMachine({
			date: '2026-09-23',
			memoId: 'm1',
			initialSnapshot: { content: '<p>old</p>', status: 'normal', isPinned: false },
			create: async () => 'm1',
			update: async (_id, snapshot) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				sent.push({ ...snapshot });
				await new Promise((resolve) => setTimeout(resolve, 2));
				inFlight -= 1;
			},
			remove: async () => {},
			debounceMs: 5,
			emptyContentPredicate: isContentEffectivelyEmpty
		});
		return { machine, sent, peakConcurrency: () => maxInFlight };
	}

	it('L: the edited body IS persisted, together with the new status', async () => {
		const { machine, sent } = machineHarness();

		// The user types: a debounced autosave is now pending.
		machine.schedule({ content: '<p>edited</p>', status: 'normal', isPinned: false });
		// The user then taps the todo box before the debounce fires. This is the
		// same machine, so it holds ONE snapshot.
		machine.schedule({ content: '<p>edited</p>', status: 'pending', isPinned: false });

		await machine.flush();

		assert.equal(sent.length, 1, 'the two changes coalesce into a single write');
		assert.equal(sent[0].status, 'pending', 'the newest status is what ships');
		assert.equal(sent[0].content, '<p>edited</p>', 'and the body being edited is not lost');
	});

	it('H: five schedules still leave exactly one request in flight', async () => {
		const { machine, sent, peakConcurrency } = machineHarness();

		for (let i = 0; i < 5; i += 1) {
			machine.schedule({ content: '<p>x</p>', status: 'pending', isPinned: false });
		}
		await machine.flush();

		assert.equal(sent.length, 1);
		assert.equal(peakConcurrency(), 1, 'the machine is single-flight');
	});

	it('demonstrates why a second writer is forbidden: a stale snapshot DOES clobber', async () => {
		// This is the failure mode the design avoids. If a status-only writer
		// existed alongside the editor's snapshot, an already-scheduled save
		// carrying the OLD status would land after it and silently undo the todo.
		// The editor therefore routes a status change through this same machine.
		const { machine, sent } = machineHarness();

		machine.schedule({ content: '<p>edited</p>', status: 'pending', isPinned: false });
		await machine.flush();
		assert.equal(sent.at(-1).status, 'pending');

		// A stale snapshot — exactly what a separate status-only call plus a
		// queued full-body save would produce.
		machine.schedule({ content: '<p>edited</p>', status: 'normal', isPinned: false });
		await machine.flush();

		assert.equal(
			sent.at(-1).status,
			'normal',
			'a stale full snapshot overwrites the newer status — this is the race §6 warns about'
		);
	});
});

// ---------------------------------------------------------------------------
// Controller Review Fix 1 (P1) — the barrier runs BEFORE the status moves
// ---------------------------------------------------------------------------

/**
 * The **editor** commit path, driven against the real save machine.
 *
 * `WorkMemoEditingSession` imports local modules at runtime, so `node:test`
 * cannot load it. What it can load is `WorkMemoSaveMachine` — the single writer
 * the session delegates to — so this harness reproduces the session's contract
 * over that machine, and every snapshot handed to the transport is recorded.
 *
 * The barrier is modelled faithfully to `runDurableFlush`:
 *
 *   1. uploads — `uploadFailure` rejects here, before anything is persisted;
 *   2. persist the body (this is the step that, under the pre-Fix-1 order, had
 *      already shipped the *new* status);
 *   3. the association set — `settleFailure` rejects here, which is the
 *      legitimate "body saved, media did not land" outcome P1 is about.
 *
 * The transport's outcome is scripted per request index (`failIndices`, or
 * `failAfter` for "everything past request N"), and `duringRequest` runs while a
 * request is on the wire. That is how a test reproduces "the user kept typing
 * while the status was being committed" — Fix 2's race — without a timer.
 */
function sessionHarness(options = {}) {
	const requests = [];
	/**
	 * The requests the transport actually accepted — the harness's model of what
	 * the server ended up holding. A request that throws never lands here, which
	 * is what lets a test say "the target status was never successfully
	 * recorded" instead of merely "a request mentioned it".
	 */
	const succeeded = [];
	const events = [];
	let body = options.content ?? '<p>memo</p>';
	let barrierCalls = 0;

	const shouldFail = (index) =>
		(options.failIndices?.includes(index) ?? false) ||
		(options.failAfter !== undefined && index > options.failAfter);

	const transport = async (snapshot) => {
		requests.push({ ...snapshot });
		const index = requests.length;
		// The request is on the wire from here until `duringRequest` resolves, so
		// a test can act on the page — keep typing, tap something — exactly while
		// it is in flight. That window is the whole of Controller Review Fix 2.
		await options.duringRequest?.(index, { ...snapshot });
		if (shouldFail(index)) {
			throw options.transportError ?? new TypeError('Failed to fetch');
		}
		succeeded.push({ ...snapshot });
	};

	const machine = new WorkMemoSaveMachine({
		date: '2026-09-23',
		memoId: options.memoId === undefined ? 'm1' : options.memoId,
		initialSnapshot: { content: body, status: options.status ?? 'normal', isPinned: false },
		create: async (_date, snapshot) => {
			await transport(snapshot);
			return 'created-1';
		},
		update: async (_id, snapshot) => transport(snapshot),
		remove: async () => {},
		debounceMs: 5,
		emptyContentPredicate: isContentEffectivelyEmpty
	});

	const session = {
		get memoId() {
			return machine.getState().memoId;
		},
		get currentContent() {
			return body;
		},
		/** Mirrors `WorkMemoEditingSession.handleContentChange`. */
		handleContentChange(next) {
			body = next;
			const snapshot = machine.getCurrentSnapshot();
			machine.schedule({ content: body, status: snapshot.status, isPinned: snapshot.isPinned });
		},
		/** Mirrors `WorkMemoEditingSession.getStatus` — reads the one snapshot. */
		getStatus: () => machine.getCurrentSnapshot().status,
		/** Mirrors `WorkMemoEditingSession.setStatus` — mutates the one snapshot. */
		setStatus(status) {
			const snapshot = machine.getCurrentSnapshot();
			machine.schedule({ content: body, status, isPinned: snapshot.isPinned });
		},
		/** Mirrors `WorkMemoEditingSession.flush` — persist, no media re-read. */
		flush: async () => {
			await machine.flush();
		},
		/**
		 * Mirrors `WorkMemoEditingSession.flushThroughStatus`, including its
		 * `toDurabilityError('save', …)` wrapping, so the harness reports a
		 * commit failure in the same vocabulary the UI phrases.
		 */
		flushThroughStatus: async (status) => {
			try {
				await machine.flushThroughStatus(status);
			} catch (error) {
				throw asDurabilityError('save', error);
			}
		},
		/** Mirrors `WorkMemoEditingSession.flushDurably` — the barrier. */
		flushDurably: async () => {
			barrierCalls += 1;
			events.push('barrier:start');
			try {
				if (options.uploadFailure) throw options.uploadFailure;
				await machine.flush();
				if (options.settleFailure) throw options.settleFailure;
				if (options.settleFailureFrom !== undefined && barrierCalls >= options.settleFailureFrom) {
					throw durabilityError('attachments');
				}
			} catch (error) {
				events.push('barrier:reject');
				throw error;
			}
			events.push('barrier:ok');
		}
	};

	return { session, machine, requests, succeeded, events, barrierCalls: () => barrierCalls };
}

/** The exact composition `DiaryEventEditor.svelte` uses, minus the component. */
function editorPersistence(h) {
	return {
		isPersisted: () => h.session.memoId !== null,
		isDraftEmpty: () => isContentEffectivelyEmpty(h.session.currentContent),
		...createSessionStatusCommit(h.session)
	};
}

/** A rejection shaped like the one `runDurableFlush` produces. */
function durabilityError(reason) {
	return asDurabilityError(reason, new Error(`${reason} did not land`));
}

/**
 * The wrapping `toDurabilityError` performs, mirrored for the harness: an
 * existing durability failure passes through unchanged, anything else is
 * labelled with the reason the wrapping site chose. Mirrors
 * `WorkMemoEditingSession.flushThroughStatus` reporting a commit failure as
 * `'save'`, so a test can assert the UI still gets a phraseable reason.
 */
function asDurabilityError(reason, error) {
	if (error && error.name === 'WorkMemoDurabilityError') return error;
	return Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
		name: 'WorkMemoDurabilityError',
		reason,
		cause: error
	});
}

describe('Controller Review Fix 1 — the barrier runs before the status moves', () => {
	it('F1: an association failure AFTER a successful persist cannot leave the target status behind', async () => {
		// The P1 scenario in full: the body is being edited, the memo already
		// exists, and the barrier persists successfully but its association step
		// fails. Pre-fix, the status had been mutated before the barrier, so the
		// persist inside it shipped `pending` and the user was still told the
		// todo had failed.
		const h = sessionHarness({ status: 'normal', settleFailure: durabilityError('attachments') });
		h.session.handleContentChange('<p>edited with an image</p>');

		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');

		assert.equal(result.ok, false);
		assert.equal(result.failure, 'body-not-durable');
		assert.equal(result.status, 'normal', 'the surface keeps rendering the old status');
		assert.equal(result.error.reason, 'attachments', 'the original reason still reaches the UI mapper');
		assert.equal(h.session.getStatus(), 'normal', 'the session still holds the old status');
		assert.deepEqual(
			h.requests.map((r) => r.status),
			['normal'],
			'the one request that went out carried the OLD status'
		);
		assert.equal(h.requests[0].content, '<p>edited with an image</p>', 'the body was still secured');
		assert.equal(
			h.requests.some((r) => r.status === 'pending' || r.status === 'completed'),
			false,
			'the server was never told about the target status'
		);
	});

	it('F2: no later debounce or autosave can smuggle the target status in afterwards', async () => {
		const h = sessionHarness({ status: 'normal', settleFailure: durabilityError('attachments') });
		h.session.handleContentChange('<p>edited</p>');
		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');
		assert.equal(result.ok, false);

		// Let any timer the session could have armed fire.
		await new Promise((resolve) => setTimeout(resolve, 40));

		assert.equal(h.session.getStatus(), 'normal');
		assert.equal(h.machine.getCurrentSnapshot().status, 'normal', 'the snapshot never held the target status');
		assert.deepEqual(
			h.requests.map((r) => r.status),
			['normal'],
			'nothing was re-sent, and nothing carried the target status'
		);
	});

	it('F3: pending -> completed is covered by the same ordering', async () => {
		const h = sessionHarness({ status: 'pending', settleFailure: durabilityError('attachments') });
		h.session.handleContentChange('<p>edited</p>');

		const result = await runDiaryTodoAction(editorPersistence(h), 'complete');

		assert.equal(result.failure, 'body-not-durable');
		assert.equal(result.status, 'pending');
		assert.equal(h.session.getStatus(), 'pending');
		assert.deepEqual(h.requests.map((r) => r.status), ['pending']);
		assert.equal(
			h.requests.some((r) => r.status === 'completed'),
			false,
			'the server never saw "completed" while the UI reported failure'
		);
	});

	it('F4: a barrier that resolves still switches the status, through the same machine', async () => {
		const h = sessionHarness({ status: 'normal' });
		h.session.handleContentChange('<p>edited</p>');

		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');

		assert.deepEqual(result, { ok: true, status: 'pending', failure: null });
		assert.deepEqual(h.events, ['barrier:start', 'barrier:ok'], 'the barrier ran, and first');
		assert.deepEqual(
			h.requests.map((r) => r.status),
			['normal', 'pending'],
			'the barrier persisted under the old status, then the commit moved it'
		);
		assert.equal(h.session.getStatus(), 'pending');
	});

	it('F5: the body edited during the switch is never lost, in either request', async () => {
		const h = sessionHarness({ status: 'normal' });
		h.session.handleContentChange('<p>edited with an image</p>');

		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');

		assert.equal(result.ok, true);
		assert.deepEqual(
			h.requests.map((r) => r.content),
			['<p>edited with an image</p>', '<p>edited with an image</p>'],
			'both the barrier and the commit carry the body being edited'
		);
		assert.equal(h.requests.at(-1).status, 'pending');
	});

	it('F6: a still-uploading image stops the action before anything is written, and says which reason', async () => {
		const h = sessionHarness({ status: 'normal', uploadFailure: durabilityError('uploads') });
		h.session.handleContentChange('<p>draft holding an uploading image</p>');

		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');

		assert.equal(result.failure, 'body-not-durable');
		assert.equal(result.error.reason, 'uploads', 'an upload failure is not re-labelled as a todo failure');
		assert.equal(h.requests.length, 0, 'nothing was persisted: the body still held a placeholder');
		assert.equal(h.session.getStatus(), 'normal');
		assert.deepEqual(h.events, ['barrier:start', 'barrier:reject']);
	});

	it('F7: a failed commit rolls the snapshot back and does not retry in a loop', async () => {
		// The barrier succeeds (request 1), the status write fails (request 2).
		const h = sessionHarness({ status: 'normal', failAfter: 1 });
		h.session.handleContentChange('<p>edited</p>');

		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');

		assert.equal(result.ok, false);
		assert.equal(result.failure, 'status-not-saved');
		assert.equal(result.status, 'normal');
		assert.equal(h.session.getStatus(), 'normal', 'the adapter undid its own mutation');
		assert.equal(h.machine.getCurrentSnapshot().status, 'normal');
		assert.equal(h.machine.getState().phase, 'idle', 'the machine is not left stuck in an error phase');

		await new Promise((resolve) => setTimeout(resolve, 40));

		assert.deepEqual(
			h.requests.map((r) => r.status),
			['normal', 'pending'],
			'one failed attempt, and no retry storm behind it'
		);
		assert.equal(h.session.getStatus(), 'normal', 'and the surface still shows the old status');
	});

	it('F8: documents the P1 the ordering fixes — the OLD order leaves the status behind', async () => {
		// The pre-Fix-1 order, spelled out, to show the new suite is not
		// vacuous: mutate first, make durable second. The barrier's persist
		// succeeds and ships `pending`; its association step then fails; the old
		// catch rolled the session back while the server kept the new status.
		const h = sessionHarness({ status: 'normal', settleFailure: durabilityError('attachments') });
		h.session.handleContentChange('<p>edited</p>');

		h.session.setStatus('pending');
		await assert.rejects(() => h.session.flushDurably(), /attachments/);
		h.session.setStatus('normal'); // exactly what the old catch block did

		assert.equal(h.session.getStatus(), 'normal', 'the UI rolled back…');
		assert.equal(
			h.requests.some((r) => r.status === 'pending'),
			true,
			'…but the server had already been told "pending" — this is the P1'
		);
	});

	it('F9: a brand new Event is created first and switched second, without losing the body', async () => {
		const h = sessionHarness({ status: 'normal', memoId: null });
		h.session.handleContentChange('<p>first body</p>');

		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');

		assert.equal(result.ok, true);
		assert.equal(h.session.memoId, 'created-1', 'the barrier created the row');
		assert.deepEqual(
			h.requests.map((r) => r.status),
			['normal', 'pending'],
			'created under the old status, then switched'
		);
		assert.equal(
			h.requests.every((r) => r.content === '<p>first body</p>'),
			true,
			'no request dropped the body'
		);
	});

	it('F10: the commit persists, it does not re-settle media', async () => {
		// Settle fails from the SECOND barrier call on. The barrier itself is
		// clean, so only a commit that re-ran it would see a failure — by which
		// point its own request had already shipped the new status, which is the
		// same P1 shape wearing a different hat. The commit calling the machine's
		// persist path — never `flushDurably()` — is what makes this unreachable.
		const h = sessionHarness({ status: 'normal', settleFailureFrom: 2 });
		h.session.handleContentChange('<p>edited</p>');

		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');

		assert.deepEqual(result, { ok: true, status: 'pending', failure: null });
		assert.equal(
			h.barrierCalls(),
			1,
			'the barrier ran exactly once: the commit writes the snapshot, it does not re-read the association set'
		);
		assert.equal(h.requests.at(-1).status, 'pending', 'and the switch did land');
		assert.equal(h.session.getStatus(), 'pending');
	});
});

// ---------------------------------------------------------------------------
// Controller Review Fix 2 (P1-1) — the commit waits for the STATUS revision
// ---------------------------------------------------------------------------

/** Lets queued timers fire; 40ms is comfortably past the 5ms test debounce. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Controller Review Fix 2 (P1-1) — the commit waits for the status revision, not for later body edits', () => {
	/**
	 * The text the "user" types into the body while the status request is on the
	 * wire. A distinct string makes every assertion about it readable.
	 */
	const TYPED_LATER = '<p>typed while the status was in flight</p>';

	/**
	 * The P1-1 scenario, assembled once.
	 *
	 * Request 1 is the barrier, request 2 is the status revision, request 3 is
	 * what the user typed while request 2 was in flight — and only request 3
	 * fails. `h` is assigned before any request can happen, because the harness
	 * only starts one when the test acts on it.
	 */
	function concurrentTypingHarness(options = {}) {
		// eslint-disable-next-line prefer-const
		let h;
		h = sessionHarness({
			status: options.status ?? 'normal',
			failIndices: [3],
			duringRequest: async (index) => {
				if (index !== 2) return;
				h.session.handleContentChange(TYPED_LATER);
			}
		});
		h.session.handleContentChange('<p>first edit</p>');
		return h;
	}

	it('T1: a body generation that fails AFTER the status landed cannot fail the todo', async () => {
		const h = concurrentTypingHarness();

		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');

		assert.deepEqual(result, { ok: true, status: 'pending', failure: null });
		assert.equal(
			h.session.getStatus(),
			'pending',
			'the status itself landed, so there is nothing to roll back'
		);
		assert.deepEqual(
			h.requests.map((r) => r.status),
			['normal', 'pending'],
			'the barrier, then the status revision — and the commit resolved on the second one alone'
		);
		assert.equal(
			h.requests[1].content,
			'<p>first edit</p>',
			'the status revision carried the body as it stood at commit time'
		);

		// The later generation goes out on the machine's ordinary schedule and
		// fails on its own, as an ordinary autosave error.
		await sleep(40);

		assert.deepEqual(
			h.requests.map((r) => r.status),
			['normal', 'pending', 'pending'],
			'the generation the user typed afterwards still ships, with the status it inherited'
		);
		assert.equal(h.requests[2].content, TYPED_LATER);
		assert.deepEqual(
			h.succeeded.map((r) => r.status),
			['normal', 'pending'],
			'the server keeps the target status: only the later body failed'
		);
		assert.equal(
			h.requests.some((r) => r.content === TYPED_LATER && r.status !== 'pending'),
			false,
			'no request ever tried to carry a body together with the OLD status'
		);
		assert.equal(h.session.getStatus(), 'pending', 'and the todo is still what the user set');
	});

	it('T2: pending -> completed is covered by the same contract', async () => {
		const h = concurrentTypingHarness({ status: 'pending' });

		const result = await runDiaryTodoAction(editorPersistence(h), 'complete');

		assert.deepEqual(result, { ok: true, status: 'completed', failure: null });
		assert.equal(h.session.getStatus(), 'completed');

		await sleep(40);

		assert.deepEqual(h.requests.map((r) => r.status), ['pending', 'completed', 'completed']);
		assert.deepEqual(
			h.succeeded.map((r) => r.status),
			['pending', 'completed'],
			'the completed status is on the server'
		);
		assert.equal(
			h.succeeded.some((r) => r.status === 'pending' && r.content === TYPED_LATER),
			false,
			'and the later body generation did not put "pending" back'
		);
	});

	it('T3: a failing status revision is what fails the todo — case A', async () => {
		// Only request 2 fails: the status revision itself.
		const h = sessionHarness({ status: 'normal', failIndices: [2] });
		h.session.handleContentChange('<p>edited</p>');

		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');

		assert.equal(result.ok, false);
		assert.equal(result.failure, 'status-not-saved');
		assert.equal(result.error.reason, 'save', 'still phrased in the durability vocabulary the UI maps');
		assert.equal(result.status, 'normal');
		assert.equal(h.session.getStatus(), 'normal', 'the adapter undid its own mutation');
		assert.deepEqual(
			h.succeeded.map((r) => r.status),
			['normal'],
			'the target status was never successfully recorded'
		);
		assert.deepEqual(
			h.requests.map((r) => r.status),
			['normal', 'pending'],
			'the failed attempt is the only trace of it'
		);

		// Case A: the body is kept, and the ordinary autosave continues under the
		// OLD status.
		assert.equal(h.machine.getCurrentSnapshot().content, '<p>edited</p>');
		h.session.handleContentChange('<p>edited twice</p>');
		await sleep(40);

		assert.deepEqual(
			h.requests.map((r) => r.status),
			['normal', 'pending', 'normal'],
			'the next autosave carries the body with the status that is actually stored'
		);
		assert.equal(h.requests.at(-1).content, '<p>edited twice</p>');
		assert.equal(h.session.getStatus(), 'normal');
	});

	it('T4: case B — the body failure is reported as a save error, the todo is not rolled back', async () => {
		const h = concurrentTypingHarness();
		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');
		assert.equal(result.ok, true);

		await sleep(40);

		assert.equal(
			h.machine.getCurrentSnapshot().content,
			TYPED_LATER,
			'the newest body is still the desired state'
		);
		assert.equal(
			h.machine.getCurrentSnapshot().status,
			'pending',
			'and the desired snapshot still carries the status the user chose'
		);
		assert.equal(h.machine.getState().phase, 'error', 'the ordinary autosave error state is set');
		assert.ok(h.machine.getState().error, 'with a message the save indicator can show');
		assert.equal(h.session.getStatus(), 'pending', 'the todo was not rolled back');
	});

	it('T5: case C — once the body can be retried, both the newest body and the target status land', async () => {
		const h = concurrentTypingHarness();
		await runDiaryTodoAction(editorPersistence(h), 'set-pending');
		await sleep(40);
		assert.equal(h.machine.getState().phase, 'error', 'precondition: the body generation failed');

		// The network is back and the ordinary flush retries it.
		await h.session.flush();

		assert.deepEqual(h.requests.at(-1), { content: TYPED_LATER, status: 'pending', isPinned: false });
		assert.notEqual(h.machine.getState().phase, 'error', 'the save error cleared');

		// Nothing is left dirty: a second flush issues no request at all.
		const before = h.requests.length;
		await h.session.flush();
		assert.equal(h.requests.length, before, 'the desired and saved snapshots agree');
	});

	it('T6: with no concurrent typing the commit is a single request that lands', async () => {
		const h = sessionHarness({ status: 'normal' });
		h.session.handleContentChange('<p>edited</p>');

		const result = await runDiaryTodoAction(editorPersistence(h), 'set-pending');

		assert.deepEqual(result, { ok: true, status: 'pending', failure: null });
		assert.deepEqual(h.requests.map((r) => r.status), ['normal', 'pending']);
		assert.equal(h.machine.getCurrentSnapshot().status, 'pending');
		assert.notEqual(h.machine.getState().phase, 'error');
		assert.equal(h.barrierCalls(), 1);
	});

	it('negative control: the pre-Fix-2 commit step rejects a status that had already landed', async () => {
		// Controller Review Fix 1's adapter, spelled out, with `flush()` as its
		// second step: barrier, then `setStatus`, then persist everything. Because
		// `flush()` resolves only once every pending change is saved, the body
		// generation the user typed during the status request becomes part of the
		// commit's fate.
		const h = concurrentTypingHarness();
		const previous = h.session.getStatus();

		await h.session.flushDurably();
		h.session.setStatus('pending');

		let failure = null;
		try {
			await h.session.flush();
		} catch (error) {
			failure = error;
		}
		if (failure) h.session.setStatus(previous);

		assert.ok(failure, 'flush() rejected over a generation the status did not depend on');
		assert.equal(h.session.getStatus(), 'normal', 'so it rolled the status back…');
		assert.equal(
			h.succeeded.some((r) => r.status === 'pending'),
			true,
			'…after the server had already accepted "pending"'
		);

		// It is not only a mislabelled UI: the rollback actively re-writes the
		// status the user asked for.
		await sleep(40);
		assert.equal(
			h.requests.at(-1).status,
			'normal',
			'the rollback puts the old status back over the one that landed — the P1'
		);
	});
});
