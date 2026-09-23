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

/** Status union owned by the save machine, re-exported for callers. */
export type WorkMemoStatusValue = WorkMemoSnapshot['status'];

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
	 * True while a save is queued or in flight, or while the last attempt failed.
	 * Callers that are about to navigate away use this to decide whether the
	 * navigation has to be held back until the work is durable.
	 */
	hasPendingChanges(): boolean {
		const phase = this.machine.getState().phase;
		return phase === 'scheduled' || phase === 'saving' || phase === 'error';
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
	 * Wait for every in-flight image upload to settle. Rejects if an upload
	 * failed. Exposed separately from `flush` for callers that must tell an
	 * upload failure apart from a persistence failure and react differently.
	 */
	async waitForUploads(): Promise<void> {
		await this.gate.wait();
	}

	/** Wait for every in-flight upload, then persist every pending change. */
	async flush(): Promise<void> {
		await this.waitForUploads();
		await this.machine.flush();
	}

	/** Delete the memo. Waits for an in-flight save before removing. */
	async delete(): Promise<boolean> {
		return this.machine.delete();
	}

	destroy(): void {
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
	private reconcileMediaAssociations(source: string, options: { force?: boolean } = {}): void {
		if (!isMediaSetStable(source, this.pendingImageUploadCount)) return;
		void this.reconciler.reconcile(extractDataMediaIds(source), options);
	}
}
