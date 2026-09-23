/**
 * Headless editing session for a single Work Memo surface.
 *
 * It owns exactly the wiring that used to live inline in `WorkMemoEditor`: the
 * autosave snapshot, the image-upload gate and Work Memo media reconciliation.
 * Extracting it means the inline Diary event editor and the full-page Worklog
 * editor share one implementation instead of forking it.
 *
 * Deliberately free of Svelte, PocketBase and `$lib` imports — every dependency
 * is injected — so it can be unit tested with plain `node:test`, which is the
 * only frontend test mechanism this project has.
 *
 * The reviewed primitives stay untouched and remain the authors of the
 * behaviour: `WorkMemoSaveMachine` (single-flight / debounce / flush / POST
 * once / delete mutex), `WorkMemoImageUploadGate`, `WorkMemoMediaReconciler`
 * (the only association mutation owner) and the `workMemoContent` guards.
 *
 * Durability (added in Controller Review Fix 2)
 * ---------------------------------------------
 * This session is the single author of the "it is now safe to destroy this
 * editor" question. Two methods carry that contract:
 *
 *   hasDurabilityWork()  — is there anything at stake right now?
 *   flushDurably()       — make everything durable, or reject
 *
 * Both are one-line delegations to `workMemoDurability`, which owns the policy
 * (and is the zero-import module the tests load). Callers must not assemble
 * their own answer from individual machine phases; that definition is the only
 * one, and it is shared by the navigation guard, the event-to-event handoff and
 * the explicit "done" action.
 */

import {
	WorkMemoSaveMachine,
	type SaveMachineState,
	type WorkMemoSnapshot
} from './workMemoSaveMachine';
import { WorkMemoImageUploadGate, type ImageUploadState } from './workMemoImageUploadGate';
import {
	WorkMemoMediaReconciler,
	extractDataMediaIds,
	type AttachFn,
	type DetachFn,
	type ListAssociationsFn
} from './workMemoMediaAssociation';
import {
	getUploadCompletionDrain,
	isContentEffectivelyEmpty,
	isMediaSetStable,
	shouldPersistContent
} from './workMemoContent';
import {
	MediaReconcileTracker,
	hasDurabilityWork,
	retryAttachmentsWhenFailed,
	runDurableFlush,
	toDurabilityError
} from './workMemoDurability';

/** Status union owned by the save machine, re-exported for callers. */
export type WorkMemoStatusValue = WorkMemoSnapshot['status'];

/**
 * The durability vocabulary lives in `workMemoDurability`, which owns the
 * policy and is the module `node:test` can load. Re-exported so a host still
 * has a single import site for the session.
 */
export {
	ATTACHMENTS_NOT_DURABLE,
	BODY_NOT_DURABLE,
	WorkMemoDurabilityError
} from './workMemoDurability';
export type { WorkMemoDurabilityFailure } from './workMemoDurability';

export interface WorkMemoEditingSessionOptions {
	/** The diary day this memo belongs to. Never mutated by the session. */
	date: string;
	/** Existing memo id, or null for a memo that does not exist yet. */
	memoId: string | null;
	initialContent?: string;
	initialStatus?: WorkMemoStatusValue;
	initialIsPinned?: boolean;
	debounceMs?: number;

	create: (date: string, snapshot: WorkMemoSnapshot) => Promise<string>;
	update: (id: string, snapshot: WorkMemoSnapshot) => Promise<void>;
	remove: (id: string) => Promise<void>;
	listMedia: ListAssociationsFn;
	attachMedia: AttachFn;
	detachMedia: DetachFn;

	/**
	 * Invoked once the memo exists and every change made so far is persisted.
	 */
	onCreated?: (id: string) => void;

	/**
	 * Whether the session performs the post-create association recovery itself.
	 *
	 * The full-page Worklog editor navigates to the edit route, whose initial
	 * mount owns that one forced pass, so it passes `false`. The inline Diary
	 * editor has no edit route to hand it to and keeps the default.
	 */
	reconcileOnCreate?: boolean;

	onStateChange?: (state: SaveMachineState) => void;
}

export class WorkMemoEditingSession {
	private readonly reconciler: WorkMemoMediaReconciler;
	private readonly gate = new WorkMemoImageUploadGate();
	private readonly machine: WorkMemoSaveMachine;
	private readonly reconcileOnCreate: boolean;
	private readonly createdCallback?: (id: string) => void;

	private content: string;
	private status: WorkMemoStatusValue;
	private isPinned: boolean;
	private pendingImageUploadCount = 0;
	private destroyed = false;

	/**
	 * Reconciliation bookkeeping. The reconciler serialises mutations itself and
	 * resolves a superseded queued request as `stale`, so all the session has to
	 * remember is *which* pass is the newest one — the tracker owns that.
	 */
	private readonly tracker = new MediaReconcileTracker();

	constructor(options: WorkMemoEditingSessionOptions) {
		this.content = options.initialContent ?? '';
		this.status = options.initialStatus ?? 'normal';
		this.isPinned = options.initialIsPinned ?? false;
		this.reconcileOnCreate = options.reconcileOnCreate ?? true;
		this.createdCallback = options.onCreated;

		this.reconciler = new WorkMemoMediaReconciler({
			list: options.listMedia,
			attach: options.attachMedia,
			detach: options.detachMedia
		});

		this.machine = new WorkMemoSaveMachine({
			date: options.date,
			memoId: options.memoId,
			initialSnapshot: {
				content: this.content,
				status: this.status,
				isPinned: this.isPinned
			},
			create: options.create,
			update: options.update,
			remove: options.remove,
			onCreated: (id) => this.handleCreated(id),
			onStateChange: options.onStateChange,
			debounceMs: options.debounceMs,
			emptyContentPredicate: isContentEffectivelyEmpty
		});

		// An existing memo's own body is the sole desired-state source, so the
		// first pass repairs associations lost by an earlier failed attach.
		if (options.memoId) {
			this.reconciler.setMemoId(options.memoId);
			this.reconcileMediaAssociations(this.content, { force: true });
		}
	}

	get memoId(): string | null {
		return this.machine.getState().memoId;
	}

	get currentContent(): string {
		return this.content;
	}

	getState(): SaveMachineState {
		return this.machine.getState();
	}

	getSnapshot(): WorkMemoSnapshot {
		return this.machine.getCurrentSnapshot();
	}

	/**
	 * True while destroying this editor could still lose body content or
	 * attachment associations.
	 *
	 * Reads the three sources of truth and hands them to `workMemoDurability`,
	 * which owns the definition and the reasoning behind it. Nothing here
	 * re-derives a second answer from the machine's phase.
	 */
	hasDurabilityWork(): boolean {
		return hasDurabilityWork({
			phase: this.machine.getState().phase,
			pendingImageUploads: this.pendingImageUploadCount,
			bodyPersistable: shouldPersistContent(this.content, this.pendingImageUploadCount),
			reconcilePending: this.tracker.isPending
		});
	}

	/**
	 * Legacy name for {@link hasDurabilityWork}. Kept so an out-of-date caller
	 * cannot silently fall back to the weaker phase-only answer.
	 */
	hasPendingChanges(): boolean {
		return this.hasDurabilityWork();
	}

	handleContentChange(newContent: string): void {
		this.content = newContent;
		this.scheduleSaveWhenContentStable();
		this.reconcileMediaAssociations(newContent);
	}

	setStatus(status: WorkMemoStatusValue): void {
		this.status = status;
		this.scheduleSaveWhenContentStable();
	}

	setPinned(isPinned: boolean): void {
		this.isPinned = isPinned;
		this.scheduleSaveWhenContentStable();
	}

	handleImageUploadStateChange(state: ImageUploadState): void {
		const previousPending = this.pendingImageUploadCount;
		this.pendingImageUploadCount = Math.max(0, state.pending);
		this.gate.update(state);

		// Replacement/removal on the editor side fires onChange before the upload
		// counter reaches zero, so that update is deliberately blocked. The final
		// >0 -> 0 transition drains the latest stable editor state.
		const drain = getUploadCompletionDrain(
			previousPending,
			this.pendingImageUploadCount,
			this.content,
			this.reconciler.memoId !== null
		);
		if (drain.save) this.scheduleSaveWhenContentStable();
		if (drain.reconcile) this.reconcileMediaAssociations(this.content);
	}

	/**
	 * Wait for every in-flight image upload to settle. Rejects with a
	 * {@link WorkMemoDurabilityError} (`reason: 'uploads'`) if one failed.
	 * Exposed separately from `flush` for callers that must tell an upload
	 * failure apart from a persistence failure and react differently.
	 */
	async waitForUploads(): Promise<void> {
		try {
			await this.gate.wait();
		} catch (error) {
			throw toDurabilityError('uploads', error);
		}
	}

	/** Wait for every in-flight upload, then persist every pending change. */
	async flush(): Promise<void> {
		await this.waitForUploads();
		await this.persistBody();
	}

	/**
	 * The "it is now safe to destroy this editor" contract.
	 *
	 * The sequence lives in `runDurableFlush` (uploads → persist → body
	 * persistable → newest association pass), so the ordering — and its
	 * reasoning — exists once instead of once per host. This method only
	 * supplies the session's own facts. It rejects when any step is not durable,
	 * and callers MUST keep the editor mounted on rejection.
	 */
	async flushDurably(): Promise<void> {
		return runDurableFlush({
			isDestroyed: () => this.destroyed,
			waitForUploads: () => this.waitForUploads(),
			persist: () => this.persistBody(),
			isBodyPersistable: () => shouldPersistContent(this.content, this.pendingImageUploadCount),
			// `persistBody()` has already run the create callback, so the
			// post-create pass is tracked by the time this is awaited. Should an
			// earlier pass have failed to prove the desired set, this explicit
			// attempt issues one more instead of re-throwing a failure the user
			// has no way to clear.
			settleAttachments: () =>
				retryAttachmentsWhenFailed(this.tracker, () =>
					this.reconcileMediaAssociations(this.content, { force: true })
				)
		});
	}

	/** Delete the memo. Waits for an in-flight save before removing. */
	async delete(): Promise<boolean> {
		return this.machine.delete();
	}

	destroy(): void {
		this.destroyed = true;
		this.reconciler.invalidate();
		this.machine.destroy();
	}

	private handleCreated(id: string): void {
		if (this.reconcileOnCreate) {
			// The memo now exists, so associations become reconcilable. The inline
			// Diary editor has no edit route to defer this to.
			this.reconciler.setMemoId(id);
			this.reconcileMediaAssociations(this.content, { force: true });
		}
		this.createdCallback?.(id);
	}

	private scheduleSave(): void {
		this.machine.schedule({
			content: this.content,
			status: this.status,
			isPinned: this.isPinned
		});
	}

	// Single guarded entry point for every ordinary save. While an image upload
	// placeholder (blob URL) is still in the content, the snapshot must NOT be
	// persisted — the durable URL arrives via a later content update.
	private scheduleSaveWhenContentStable(): void {
		if (!shouldPersistContent(this.content, this.pendingImageUploadCount)) return;
		this.scheduleSave();
	}

	// Association bookkeeping is driven ONLY by the set of stable data-media-id
	// values in the body, and the reconciler is a no-op when no memo exists yet
	// and when the media set is unchanged — so ordinary typing issues no request.
	//
	// The pass is handed to the tracker rather than dropped: a durable flush must
	// be able to await the NEWEST desired set, not just whatever happened to be
	// in flight.
	private reconcileMediaAssociations(source: string, options: { force?: boolean } = {}): void {
		if (!isMediaSetStable(source, this.pendingImageUploadCount)) return;
		this.tracker.track(this.reconciler.reconcile(extractDataMediaIds(source), options));
	}

	/** Persist the body, reporting a rejection as a durability failure. */
	private async persistBody(): Promise<void> {
		try {
			await this.machine.flush();
		} catch (error) {
			throw toDurabilityError('save', error);
		}
	}
}
