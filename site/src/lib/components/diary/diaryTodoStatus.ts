/**
 * The Event-level Todo state machine for Diary Multi-Event V1 (Task 2).
 *
 * An Event's todo state **is** `work_memos.status` (`normal | pending |
 * completed`). There is no second column, no second table and no diary-only
 * copy — so this module owns the meaning of that one column for the diary UI and
 * nothing else:
 *
 *   1. the single transition table (which action may follow which status);
 *   2. the small view model both surfaces render from, so the read-only card and
 *      the inline editor cannot drift apart;
 *   3. the "apply a todo action" transaction, with every side effect injected, so
 *      it runs under `node:test` with no component, no bundler and no server;
 *   4. the editor's commit adapter ({@link createSessionStatusCommit}), which is
 *      what makes "the durability barrier runs before the status is mutated"
 *      hold for the surface that has a live body, and what makes the outcome of
 *      the commit depend on the status revision alone — never on body
 *      generations the user types while the status request is in flight — see
 *      the P1 notes on {@link runDiaryTodoAction}.
 *
 * Zero runtime imports on purpose — see `workMemoDurability.ts` for the full
 * reasoning about Node's ESM resolver and `--experimental-transform-types`. The
 * status union arrives through a **type-only** import, which the compiler
 * erases; the local `isDiaryTodoStatus` mirrors the wire validator in
 * `workMemoStatusCore` and `diaryTodoStatus.test.ts` asserts the two agree, so
 * the duplication is checked rather than assumed.
 */

import type { WorkMemoStatusValue } from '../../api/workMemoStatusCore';

/** An Event's todo state. Identical to the persisted `work_memos.status`. */
export type DiaryTodoStatus = WorkMemoStatusValue;

/** The union as a value, in the order the UI presents it. */
export const DIARY_TODO_STATUSES = ['normal', 'pending', 'completed'] as const;

/** Whether an untrusted value is one of the three persisted statuses. */
export function isDiaryTodoStatus(value: unknown): value is DiaryTodoStatus {
	return typeof value === 'string' && (DIARY_TODO_STATUSES as readonly string[]).includes(value);
}

/**
 * Coerce an untrusted status to a safe one. A garbled value renders as
 * `normal` — the conservative choice, because it offers no "cancel todo" action
 * the user did not ask for.
 */
export function normalizeDiaryTodoStatus(value: unknown): DiaryTodoStatus {
	return isDiaryTodoStatus(value) ? value : 'normal';
}

/**
 * A semantic action the user performs on one Event's todo state. Named for the
 * intent, not for the endpoint, so a future surface can reuse the table.
 */
export type DiaryTodoAction = 'set-pending' | 'complete' | 'reopen' | 'clear';

/**
 * THE transition table. This is the spec the product states, written once:
 *
 *   normal    --set-pending--> pending      "设为待办"
 *   pending   --complete-----> completed    勾选完成
 *   completed --reopen-------> pending      重新打开 / 取消勾选
 *   pending   --clear--------> normal       "取消待办"
 *   completed --clear--------> normal       允许"取消待办"
 *
 * `null` means the transition is not offered from that status — e.g. going
 * straight from `normal` to `completed` — so a drifted control can never invent
 * a transition the product does not have. Every legal transition changes the
 * status, so a result equal to the input is never possible.
 */
export function applyDiaryTodoAction(
	status: DiaryTodoStatus,
	action: DiaryTodoAction
): DiaryTodoStatus | null {
	switch (action) {
		case 'set-pending':
			return status === 'normal' ? 'pending' : null;
		case 'complete':
			return status === 'pending' ? 'completed' : null;
		case 'reopen':
			return status === 'completed' ? 'pending' : null;
		case 'clear':
			return status === 'normal' ? null : 'normal';
	}
}

/**
 * Everything a surface needs to render one Event's todo control. Derived from
 * the status alone, so both surfaces are guaranteed to offer the same actions.
 */
export interface DiaryTodoViewModel {
	/** The normalized status this view was built from. */
	status: DiaryTodoStatus;
	/** True for `pending` and `completed`: the Event is a todo at all. */
	isTodo: boolean;
	/** Checkbox state. Only meaningful when `isTodo`. */
	checked: boolean;
	/** The action the checkbox performs, or null when there is no checkbox. */
	toggleAction: 'complete' | 'reopen' | null;
	/** Whether "set as todo" is offered (`normal` only). */
	canSetPending: boolean;
	/** Whether "cancel todo" is offered (`pending` and `completed`). */
	canClear: boolean;
}

/** Build the view model for an Event's status. Accepts untrusted input. */
export function getDiaryTodoViewModel(status: unknown): DiaryTodoViewModel {
	const normalized = normalizeDiaryTodoStatus(status);
	const isTodo = normalized !== 'normal';
	return {
		status: normalized,
		isTodo,
		checked: normalized === 'completed',
		toggleAction: normalized === 'pending' ? 'complete' : normalized === 'completed' ? 'reopen' : null,
		canSetPending: normalized === 'normal',
		canClear: isTodo
	};
}

/**
 * Why a todo action did not take effect.
 *
 * - `illegal-action` — the transition is not offered from the current status.
 * - `empty-draft` — a brand new Event with no content has no row to attach a
 *   todo state to, and creating a blank one would be worse than refusing.
 * - `body-not-durable` — the durability barrier failed, so the status was left
 *   alone. Nothing of this action was written: the target status is never handed
 *   to a write path until the barrier has resolved.
 * - `status-not-saved` — the barrier passed but the **status revision itself**
 *   did not land; the previous status is still the truth on the server. A body
 *   generation that fails *after* the status landed is deliberately not this:
 *   the action has already succeeded by then and the failure belongs to the
 *   ordinary autosave error state.
 */
export type DiaryTodoFailure =
	| 'illegal-action'
	| 'empty-draft'
	| 'body-not-durable'
	| 'status-not-saved';

export interface DiaryTodoApplyResult {
	ok: boolean;
	/** The status the surface should show now. Unchanged on failure. */
	status: DiaryTodoStatus;
	/** Non-null when `ok` is false. */
	failure: DiaryTodoFailure | null;
	/**
	 * The underlying rejection, when there was one. Handed straight to the
	 * caller's error-to-message mapping — this module never matches on text.
	 */
	error?: unknown;
}

/**
 * The side effects one Event's todo change needs. Both surfaces implement this
 * over their own write path, which is exactly the part that legitimately
 * differs: the read-only card talks to the API, the open editor goes through the
 * shared editing session so the save machine keeps owning the single snapshot.
 */
export interface DiaryTodoPersistence {
	/** Whether the memo row exists yet. */
	isPersisted: () => boolean;
	/** Whether a not-yet-persisted draft body is effectively empty. */
	isDraftEmpty: () => boolean;
	/** The status the surface currently shows. */
	getStatus: () => DiaryTodoStatus;
	/**
	 * THE DURABILITY BARRIER. Make everything the surface is holding durable —
	 * uploads settled, body persisted, associations reconciled — **without**
	 * changing the status. Rejects on any durability failure; implementations
	 * must not swallow one.
	 *
	 * It runs BEFORE the status is mutated, and that ordering is the whole
	 * guarantee behind this transaction: a rejection here provably wrote nothing
	 * about the todo, because at that moment no write path has been told what the
	 * target status is.
	 */
	makeBodyDurable: () => Promise<void>;
	/**
	 * Persist `status` and reject on failure. Runs only after
	 * {@link makeBodyDurable} resolved.
	 *
	 * Three obligations for the implementation:
	 *
	 *  - it must not re-run the barrier, and must not treat a *media/attachment*
	 *    failure as a commit failure — everything that could fail that way was
	 *    already settled by the barrier, so re-reading it here is how a commit
	 *    that actually landed gets reported as a failure (Controller Review
	 *    Fix 1's P1);
	 *  - **its success must depend on the status revision alone, never on body
	 *    generations produced afterwards.** Resolving only when *all* pending
	 *    work is saved is the Fix 2 P1: the status ships, the user keeps typing,
	 *    the newer body save fails, and the todo is reported as failed even
	 *    though the server holds the new status. A later failure must surface as
	 *    an ordinary body/autosave error, with the todo left alone;
	 *  - if it mutates its own status before the request, it must undo that
	 *    mutation before rejecting, so a failure never leaves the editor showing
	 *    a state the database does not hold.
	 */
	commitStatus: (status: DiaryTodoStatus) => Promise<void>;
}

/**
 * The part of `WorkMemoEditingSession` a todo commit needs.
 *
 * Structural on purpose: this module has no runtime imports (see the header), and
 * the session is the only production implementation. It is deliberately *not*
 * the whole session — only the four calls the commit path makes, so the contract
 * is visible at a glance.
 */
export interface DiaryTodoSessionHandle {
	/** The status the session's single snapshot currently holds. */
	getStatus: () => DiaryTodoStatus;
	/** `WorkMemoEditingSession.flushDurably` — the durability barrier. */
	flushDurably: () => Promise<void>;
	/** `WorkMemoEditingSession.setStatus` — mutate the one snapshot. */
	setStatus: (status: DiaryTodoStatus) => void;
	/**
	 * `WorkMemoEditingSession.flushThroughStatus` — persist the snapshot until
	 * the *status* is on the server, ignoring body generations produced later.
	 */
	flushThroughStatus: (status: DiaryTodoStatus) => Promise<void>;
}

/**
 * The three persistence members the *editor* surface needs, written against
 * {@link DiaryTodoSessionHandle}.
 *
 * This is the only place the ordering lives, and it is testable with a real
 * `WorkMemoSaveMachine` behind it because it imports nothing.
 *
 * Why `flushThroughStatus` and not `flushDurably()` in step two: the barrier in
 * step one already settled uploads, the body and the association set. Asking the
 * association layer again would let a post-barrier reconcile failure reject a
 * commit whose write had already landed (Controller Review Fix 1's P1). Why not
 * `flush()` either: `flush()` resolves only once *every* pending change is
 * saved, so a body generation the user typed while the status request was in
 * flight could fail and reject a status write that had already succeeded — and
 * the rollback below would undo a todo the server had already accepted
 * (Controller Review Fix 2's P1-1). `flushThroughStatus` is exactly the
 * obligation a status commit has: *this* revision, and nothing the user does
 * afterwards. The status is still written by the one writer
 * (`WorkMemoSaveMachine`, reached through the session); nothing here is a second
 * save path, a second snapshot or a second save guard.
 */
export function createSessionStatusCommit(session: DiaryTodoSessionHandle): {
	getStatus: () => DiaryTodoStatus;
	makeBodyDurable: () => Promise<void>;
	commitStatus: (status: DiaryTodoStatus) => Promise<void>;
} {
	return {
		getStatus: () => session.getStatus(),
		makeBodyDurable: () => session.flushDurably(),
		commitStatus: async (status) => {
			const previous = session.getStatus();
			session.setStatus(status);
			try {
				await session.flushThroughStatus(status);
			} catch (error) {
				// Put the snapshot back before reporting. The machine's own
				// saved-vs-current diff is what decides whether a further write
				// happens: on a plain failed request the rollback leaves no
				// difference, so nothing more is sent; if a request did land and a
				// later one failed, the rollback makes the old status the desired
				// state again and the next flush restores it.
				//
				// Reaching here means the *status revision* did not land — a body
				// generation that failed after it did never gets this far, because
				// the promise above has already resolved by then.
				session.setStatus(previous);
				throw error;
			}
		}
	};
}

/**
 * Apply one todo action to one Event.
 *
 * The order is the whole point, and it is §5 of the Task 2 spec as amended by
 * Controller Review Fix 1 and Fix 2:
 *
 *   1. resolve the target status from the transition table — an action the
 *      product does not offer is refused outright;
 *   2. refuse an empty brand-new Event, which has no row to attach a todo state
 *      to and no body worth creating one for;
 *   3. **the durability barrier, while the OLD status is still in place** —
 *      uploads settled, body persisted, row created if needed, associations
 *      reconciled. A rejection here means nothing about this action was written,
 *      because the target status has not been handed to anybody yet;
 *   4. only then move the status, on a path that cannot re-interpret a media
 *      failure as a commit failure, and whose success depends on the *status
 *      revision* alone. On rejection the caller keeps showing the old status and
 *      the implementation has undone its own mutation.
 *
 * Step 3 coming before step 4 is Fix 1's guarantee. Step 4 waiting only for the
 * status revision is Fix 2's:
 *
 *   A. the status revision fails → this action failed, the server still holds
 *      the old status, and the body the user typed is kept and saved by the
 *      ordinary autosave path under that old status;
 *   B. the status revision succeeds and a body generation produced afterwards
 *      fails → **this action succeeded**. The server holds the target status and
 *      the body failure is the ordinary autosave error. Rolling the status back
 *      here is the reported P1: the todo the user asked for would be undone on
 *      the strength of an unrelated later failure;
 *   C. the status revision succeeds and later generations succeed → success, as
 *      before.
 *
 * It never throws: a rejection is reported as a result, because "the todo did
 * not change and here is why" is an ordinary outcome the UI must render.
 */
export async function runDiaryTodoAction(
	persistence: DiaryTodoPersistence,
	action: DiaryTodoAction
): Promise<DiaryTodoApplyResult> {
	const current = normalizeDiaryTodoStatus(persistence.getStatus());
	const target = applyDiaryTodoAction(current, action);

	if (target === null) {
		return { ok: false, status: current, failure: 'illegal-action' };
	}

	// §5 — an empty draft is not an Event at all, so refuse rather than create a
	// blank row just to hold a checkbox state.
	if (!persistence.isPersisted() && persistence.isDraftEmpty()) {
		return { ok: false, status: current, failure: 'empty-draft' };
	}

	try {
		await persistence.makeBodyDurable();
	} catch (error) {
		return { ok: false, status: current, failure: 'body-not-durable', error };
	}

	try {
		await persistence.commitStatus(target);
	} catch (error) {
		return { ok: false, status: current, failure: 'status-not-saved', error };
	}

	return { ok: true, status: target, failure: null };
}

/**
 * Translation keys for the control's visible and accessible text.
 *
 * The status *badge* deliberately reuses `worklog.statusPending` /
 * `worklog.statusCompleted`: those labels already name the same persisted state
 * on the Worklog surface, and a second vocabulary for one column would be a bug
 * waiting to happen. Only the todo-specific affordances coin new keys.
 */
export type DiaryTodoTextKey =
	| 'worklog.statusPending'
	| 'worklog.statusCompleted'
	| 'diaryEvents.todoSetPending'
	| 'diaryEvents.todoCancel'
	| 'diaryEvents.todoMarkComplete'
	| 'diaryEvents.todoReopen'
	| 'diaryEvents.todoGroupLabel'
	| 'diaryEvents.todoUpdating'
	| 'diaryEvents.todoFailed'
	| 'diaryEvents.todoNeedsContent';

/** The badge label for a todo status, or null for `normal` (no badge). */
export function diaryTodoBadgeKey(status: unknown): DiaryTodoTextKey | null {
	const normalized = normalizeDiaryTodoStatus(status);
	if (normalized === 'pending') return 'worklog.statusPending';
	if (normalized === 'completed') return 'worklog.statusCompleted';
	return null;
}

/** The accessible label describing what a control will do. */
export function diaryTodoActionLabelKey(action: DiaryTodoAction): DiaryTodoTextKey {
	switch (action) {
		case 'set-pending':
			return 'diaryEvents.todoSetPending';
		case 'complete':
			return 'diaryEvents.todoMarkComplete';
		case 'reopen':
			return 'diaryEvents.todoReopen';
		case 'clear':
			return 'diaryEvents.todoCancel';
	}
}

/** The message a failed action should show. `illegal-action` never happens. */
export function diaryTodoFailureKey(failure: DiaryTodoFailure): DiaryTodoTextKey | null {
	if (failure === 'empty-draft') return 'diaryEvents.todoNeedsContent';
	if (failure === 'body-not-durable' || failure === 'status-not-saved') {
		return 'diaryEvents.todoFailed';
	}
	return null;
}
