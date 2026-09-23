/**
 * Durability policy for a Work Memo editing surface. Controller Review Fix 2
 * moved the answers here so they exist in exactly one place:
 *
 *   hasDurabilityWork(signals) — is there anything at stake right now?
 *   runDurableFlush(steps)     — make everything durable, or reject
 *
 * plus {@link MediaReconcileTracker}, which remembers *which* association pass
 * is the newest one so a flush can wait for that one rather than for whatever
 * happened to be running.
 *
 * Zero-import leaf module on purpose. The project's only frontend test
 * mechanism is `node --experimental-transform-types --test`, and Node's ESM
 * resolver does not guess an extension for a TypeScript specifier, so any module
 * a test imports must not import a local module at runtime. `import type` is
 * erased and therefore free — see `diaryEventNavigation.ts` for that pattern.
 *
 * `WorkMemoEditingSession` is the only production owner: it supplies the facts,
 * applies the answers and keeps no second copy of this policy.
 */

/**
 * Why a durability attempt failed. Callers must not parse message strings to
 * tell these apart — that is what this union is for.
 */
export type WorkMemoDurabilityFailure =
	/** The session was already destroyed when the flush was requested. */
	| 'destroyed'
	/** An image upload failed, so its placeholder never became durable. */
	| 'uploads'
	/** The body still holds a placeholder and must not be persisted as-is. */
	| 'body'
	/** The body was saved but a media association mutation did not land. */
	| 'attachments'
	/** The memo itself could not be created or updated. */
	| 'save';

/** Reason of a flush that refused to persist a body still holding a placeholder. */
export const BODY_NOT_DURABLE = 'WORK_MEMO_BODY_NOT_DURABLE';

/** Reason of a flush whose association mutations did not all land. */
export const ATTACHMENTS_NOT_DURABLE = 'WORK_MEMO_ATTACHMENTS_NOT_DURABLE';

/**
 * `name` carried by every {@link WorkMemoDurabilityError}.
 *
 * A module that must stay import-free (see the header) can recognise a
 * durability failure by this name instead of its class. The leaf's own test
 * asserts the two stay in step.
 */
export const DURABILITY_ERROR_NAME = 'WorkMemoDurabilityError';

export class WorkMemoDurabilityError extends Error {
	readonly reason: WorkMemoDurabilityFailure;
	readonly cause: unknown;

	constructor(reason: WorkMemoDurabilityFailure, message: string, cause?: unknown) {
		super(message);
		this.name = DURABILITY_ERROR_NAME;
		this.reason = reason;
		this.cause = cause;
	}
}

/** Wrap an arbitrary rejection, leaving an existing durability failure intact. */
export function toDurabilityError(
	reason: WorkMemoDurabilityFailure,
	error: unknown
): WorkMemoDurabilityError {
	if (error instanceof WorkMemoDurabilityError) return error;
	return new WorkMemoDurabilityError(
		reason,
		error instanceof Error ? error.message : String(error),
		error
	);
}

/**
 * The facts the "is anything at stake?" question is answered from. The caller
 * reads them off the save machine, the upload gate and the reconcile tracker;
 * this module never inspects those objects.
 */
export interface DurabilitySignals {
	/** Save-machine phase: `idle` | `scheduled` | `saving` | `saved` | `error`. */
	phase: string;
	/** Image uploads still in flight. */
	pendingImageUploads: number;
	/**
	 * Whether the on-screen body may be persisted as-is. Computed by the caller
	 * from the body plus the upload count — a placeholder `blob:` URL must not
	 * be written to the server.
	 */
	bodyPersistable: boolean;
	/** Whether an association pass is outstanding. */
	reconcilePending: boolean;
}

/**
 * True while destroying the editor could still lose body content or attachment
 * associations.
 *
 * Every clause is a distinct way to reach that state, and the save machine's
 * phase alone is not enough — that was the bug this replaces:
 *
 * - `scheduled` / `saving` — a debounced or in-flight persistence.
 * - `error` — the last attempt failed, so the body is not on the server.
 * - a pending upload — the editor holds a placeholder, so the save guard
 *   deliberately refuses to persist and the machine can sit at `idle`/`saved`
 *   while the body on screen is already newer than the row.
 * - a body that is not persistable — a placeholder survives in the body even
 *   though the upload counter reads zero; persisting it would store a dead
 *   `blob:` URL.
 * - an outstanding association pass — the body may be saved while the
 *   attachments it references are not yet linked to the memo.
 */
export function hasDurabilityWork(signals: DurabilitySignals): boolean {
	const phase = signals.phase;
	if (phase === 'scheduled' || phase === 'saving' || phase === 'error') return true;
	if (signals.pendingImageUploads > 0) return true;
	if (!signals.bodyPersistable) return true;
	if (signals.reconcilePending) return true;
	return false;
}

/**
 * The part of a reconcile pass result durability cares about, structurally
 * typed so this module needs no import from the reconciler.
 */
export interface ReconcileOutcome {
	/** Why the pass did nothing, or null when it ran its mutations. */
	skipped: string | null;
	/** How many intended mutations did not land. */
	failed: number;
}

/**
 * The only skip reasons that are a *complete* answer rather than a failure.
 *
 * Both are produced by `WorkMemoMediaReconciler.reconcile()` before any request
 * is made, and both mean there was provably nothing to do:
 *
 * - `no-memo` — the memo does not exist yet, so no association can be created.
 * - `unchanged` — the server's set already matches the body's media set.
 *
 * This is an allowlist because the alternative fails open. A reason that is not
 * listed is one where the desired set was never *proven* to be on the server.
 */
export const DURABILITY_SAFE_SKIP_REASONS: readonly string[] = ['no-memo', 'unchanged'];

/**
 * Translate a settled association pass into a durability failure, or null when
 * the pass proved the desired set is on the server.
 *
 * `failed > 0` means a mutation the session intended did not land — most
 * importantly an attach for an image the saved body references. That is a real
 * durability hole and must not be reported as success.
 *
 * A *skipped* pass is only a complete answer for the reasons in
 * {@link DURABILITY_SAFE_SKIP_REASONS}; everything else fails closed. This is
 * deliberately not delegated to the `failed` counter alone: **`list-failed` is
 * the case that makes that distinction matter.** When the association list
 * cannot be read, the desired set was never compared against the server, so the
 * attach the saved body needs may never have run — and for a newly created event
 * holding images that is exactly the situation, because the create is what makes
 * an association possible in the first place. Reporting "durable" there would
 * tell the user their images are saved when the database may hold no link at
 * all. Depending on a counter the reconciler happens to bump would make that
 * guarantee a side effect of an unrelated implementation detail, so the reason
 * is what is read.
 *
 * `stale` fails closed for the same reason: a newer request took over, so this
 * pass proved nothing. `MediaReconcileTracker` already discards the outcome of a
 * superseded pass, so a `stale` result reaching a caller here means no newer pass
 * is coming to replace it.
 */
export function classifyReconcileOutcome(result: ReconcileOutcome): WorkMemoDurabilityError | null {
	if (result.failed > 0) return new WorkMemoDurabilityError('attachments', ATTACHMENTS_NOT_DURABLE);
	if (result.skipped === null) return null;
	if (DURABILITY_SAFE_SKIP_REASONS.includes(result.skipped)) return null;
	return new WorkMemoDurabilityError('attachments', ATTACHMENTS_NOT_DURABLE);
}

export interface MediaReconcileTrackerOptions {
	/** Defaults to {@link classifyReconcileOutcome}. */
	classify?: (result: ReconcileOutcome) => WorkMemoDurabilityError | null;
	/** Message for a pass that rejected outright. Defaults to {@link ATTACHMENTS_NOT_DURABLE}. */
	failureMessage?: string;
}

/**
 * Remembers which association pass is the newest one, so a durable flush can
 * await the newest desired set instead of the pass that happened to be running.
 *
 * The reconciler already serialises its own mutations and resolves a superseded
 * queued request as `stale`; what it cannot do is tell a caller *when the
 * newest set is done*, because from its side every request looks alike. This
 * class supplies exactly that: the last `track()` wins, an older pass's outcome
 * is discarded, and `settle()` follows the tail until it stops moving.
 */
export class MediaReconcileTracker {
	private readonly classify: (result: ReconcileOutcome) => WorkMemoDurabilityError | null;
	private readonly failureMessage: string;

	/** Generation counter: only the newest `track()` may record an outcome. */
	private sequence = 0;
	/** Settles when the currently newest pass has recorded its outcome. */
	private tail: Promise<void> = Promise.resolve();
	private pending = false;
	private error: WorkMemoDurabilityError | null = null;

	constructor(options: MediaReconcileTrackerOptions = {}) {
		this.classify = options.classify ?? classifyReconcileOutcome;
		this.failureMessage = options.failureMessage ?? ATTACHMENTS_NOT_DURABLE;
	}

	/** Whether a pass is outstanding. Feeds {@link hasDurabilityWork}. */
	get isPending(): boolean {
		return this.pending;
	}

	/** The newest settled outcome's failure, or null. */
	get currentError(): WorkMemoDurabilityError | null {
		return this.error;
	}

	/**
	 * Take ownership of a pass. A newer call supersedes the previous one: the
	 * older pass still runs (the reconciler owns its own queue) but its outcome
	 * can no longer settle the tracker or clear the error.
	 */
	track(pass: Promise<ReconcileOutcome>): void {
		const sequence = ++this.sequence;
		this.pending = true;
		// Both branches resolve, so `tail` never rejects: `settle()` reports the
		// failure itself and only once.
		this.tail = pass.then(
			(result) => this.record(sequence, () => this.classify(result)),
			(reason) =>
				this.record(
					sequence,
					() => new WorkMemoDurabilityError('attachments', this.failureMessage, reason)
				)
		);
	}

	/**
	 * Await the newest pass. Each iteration re-reads the tail, so a pass that
	 * was replaced while it was awaited does not end the wait — the newest
	 * desired set does. Throws the recorded failure afterwards, if any.
	 */
	async settle(): Promise<void> {
		for (;;) {
			const tail = this.tail;
			await tail;
			if (this.tail === tail) break;
		}
		if (this.error) throw this.error;
	}

	private record(sequence: number, resolveError: () => WorkMemoDurabilityError | null): void {
		// A newer pass owns the outcome: this one was superseded while queued and
		// its desired set is stale by definition.
		if (sequence !== this.sequence) return;
		this.pending = false;
		this.error = resolveError();
	}
}

/**
 * Step 4 of a durable flush, with the retry the failure policy implies.
 *
 * A recorded failure means an earlier pass could not prove the desired set, and
 * `WorkMemoMediaReconciler` deliberately leaves its reconciled key unset so the
 * next explicit trigger can recover. Without issuing that next pass, `settle()`
 * would re-throw the same recorded failure on every attempt and the editor could
 * never be left — the user's only escape would be a reload. That is why the
 * controller asked for this step to retry rather than only to wait.
 *
 * The retry is deliberately not unconditional: a tracker with no failure has
 * already proved the desired set, and re-listing on every explicit save would be
 * traffic with nothing left to learn from it.
 *
 * @param tracker  the newest-pass bookkeeping
 * @param reissue  issue one more pass for the *current* desired set
 */
export async function retryAttachmentsWhenFailed(
	tracker: MediaReconcileTracker,
	reissue: () => void
): Promise<void> {
	if (tracker.currentError) reissue();
	await tracker.settle();
}

/**
 * The effects a durable flush needs. Each one is owned elsewhere — the upload
 * gate, the save machine and the reconcile tracker — so this module stays free
 * of them and the ordering below can be tested on its own.
 */
export interface DurableFlushSteps {
	/** True once the session has been torn down. */
	isDestroyed: () => boolean;
	/** Wait for every in-flight image upload; reject if one failed. */
	waitForUploads: () => Promise<void>;
	/** Persist the current body, creating the memo when it does not exist yet. */
	persist: () => Promise<void>;
	/** Whether the body is persistable *now* (no placeholder left in it). */
	isBodyPersistable: () => boolean;
	/** Await the newest association pass; reject if a mutation did not land. */
	settleAttachments: () => Promise<void>;
}

/**
 * The "it is now safe to destroy this editor" contract.
 *
 * Resolves only when ALL of the following are true:
 *   1. every in-flight image upload has settled;
 *   2. the editor's final stable body was captured and persisted;
 *   3. the body that was persisted held no placeholder;
 *   4. the newest desired media-association set finished reconciling.
 *
 * It rejects otherwise, and callers MUST keep the editor mounted on rejection.
 * `SaveMachine.flush()` alone is not sufficient: it neither waits for uploads
 * nor for the association pass.
 *
 * Ordering notes: uploads come first because the save guard refuses to persist
 * a placeholder body, so saving first would persist nothing and then report
 * success. Reconciliation comes last because it is what makes the images the
 * saved body references reachable. Uploads cannot deadlock against the save —
 * the gate is settled by the editor, not by the save machine — and a reconcile
 * pass never schedules a save, so there is no feedback loop.
 */
export async function runDurableFlush(steps: DurableFlushSteps): Promise<void> {
	if (steps.isDestroyed()) {
		throw new WorkMemoDurabilityError('destroyed', 'the editing session was already destroyed');
	}

	// 1. Uploads first: a placeholder body must never be persisted.
	try {
		await steps.waitForUploads();
	} catch (error) {
		throw toDurabilityError('uploads', error);
	}

	// 2. Persist the final body (this creates the row when it does not exist).
	try {
		await steps.persist();
	} catch (error) {
		throw toDurabilityError('save', error);
	}

	// 3. The body must actually be persistable now. Reaching here with a
	//    placeholder still in it means the upload never resolved: reporting
	//    success would promise durability the session cannot deliver.
	if (!steps.isBodyPersistable()) {
		throw new WorkMemoDurabilityError('body', BODY_NOT_DURABLE);
	}

	// 4. Wait for the NEWEST association pass.
	await steps.settleAttachments();

	if (steps.isDestroyed()) {
		throw new WorkMemoDurabilityError('destroyed', 'the session was destroyed while flushing');
	}
}
