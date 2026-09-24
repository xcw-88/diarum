/**
 * Pure auto-save state machine for WorkMemoEditor.
 *
 * Guarantees single-flight save requests: at most one POST or PUT is in flight
 * at any moment. Changes that arrive while a request is running are batched and
 * saved by the next request after the current one finishes.
 */

export interface WorkMemoSnapshot {
	content: string;
	status: 'normal' | 'pending' | 'completed';
	isPinned: boolean;
}

export type SavePhase = 'idle' | 'scheduled' | 'saving' | 'saved' | 'error';

export interface SaveMachineState {
	phase: SavePhase;
	error: string;
	memoId: string | null;
}

export interface SaveMachineOptions {
	date: string;
	memoId: string | null;
	initialSnapshot: WorkMemoSnapshot;
	create: (date: string, snapshot: WorkMemoSnapshot) => Promise<string>;
	update: (id: string, snapshot: WorkMemoSnapshot) => Promise<void>;
	remove: (id: string) => Promise<void>;
	onCreated?: (id: string) => void;
	onStateChange?: (state: SaveMachineState) => void;
	debounceMs?: number;
	emptyContentPredicate?: (html: string) => boolean;
}

export class WorkMemoSaveMachine {
	private date: string;
	private memoId: string | null;
	private currentSnapshot: WorkMemoSnapshot;
	private savedSnapshot: WorkMemoSnapshot;

	private phase: SavePhase = 'idle';
	private error = '';

	private timer: ReturnType<typeof setTimeout> | null = null;
	private savedTimer: ReturnType<typeof setTimeout> | null = null;
	private savePromise: Promise<string | undefined> | null = null;
	private pendingSave = false;
	private pendingCreatedId: string | null = null;
	private isDeleting = false;
	private destroyed = false;

	private create: (date: string, snapshot: WorkMemoSnapshot) => Promise<string>;
	private update: (id: string, snapshot: WorkMemoSnapshot) => Promise<void>;
	private remove: (id: string) => Promise<void>;
	private onCreated?: (id: string) => void;
	private onStateChange?: (state: SaveMachineState) => void;
	private debounceMs: number;
	private emptyContentPredicate?: (html: string) => boolean;

	constructor(options: SaveMachineOptions) {
		this.date = options.date;
		this.memoId = options.memoId;
		this.currentSnapshot = { ...options.initialSnapshot };
		this.savedSnapshot = { ...options.initialSnapshot };
		this.create = options.create;
		this.update = options.update;
		this.remove = options.remove;
		this.onCreated = options.onCreated;
		this.onStateChange = options.onStateChange;
		this.debounceMs = options.debounceMs ?? 800;
		this.emptyContentPredicate = options.emptyContentPredicate;
		this.notify();
	}

	getState(): SaveMachineState {
		return {
			phase: this.phase,
			error: this.error,
			memoId: this.memoId
		};
	}

	getCurrentSnapshot(): WorkMemoSnapshot {
		return { ...this.currentSnapshot };
	}

	private setPhase(phase: SavePhase) {
		this.phase = phase;
		this.notify();
	}

	private setError(error: string) {
		this.error = error;
		this.notify();
	}

	private notify() {
		this.onStateChange?.(this.getState());
	}

	private clearTimer() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private clearSavedTimer() {
		if (this.savedTimer) {
			clearTimeout(this.savedTimer);
			this.savedTimer = null;
		}
	}

	private scheduleSavedTimer() {
		this.clearSavedTimer();
		this.savedTimer = setTimeout(() => {
			this.savedTimer = null;
			if (this.phase === 'saved') {
				this.setPhase('idle');
			}
		}, 2000);
	}

	private snapshotKey(snapshot: WorkMemoSnapshot): string {
		return JSON.stringify(snapshot);
	}

	private needsSave(): boolean {
		return this.snapshotKey(this.currentSnapshot) !== this.snapshotKey(this.savedSnapshot);
	}

	private isEffectivelyEmpty(): boolean {
		return this.emptyContentPredicate
			? this.emptyContentPredicate(this.currentSnapshot.content)
			: !this.currentSnapshot.content;
	}

	/**
	 * Schedule a save for the given snapshot. No-op if the machine is deleting,
	 * destroyed, or the snapshot matches the last saved state.
	 */
	schedule(snapshot: WorkMemoSnapshot) {
		if (this.destroyed || this.isDeleting) return;

		this.currentSnapshot = { ...snapshot };
		this.clearSavedTimer();

		if (this.phase === 'saved') {
			this.setPhase('idle');
		}

		// New, not yet created, and still empty: wait for real content.
		if (!this.memoId && this.isEffectivelyEmpty()) {
			this.clearTimer();
			if (this.phase === 'error') {
				this.setError('');
				this.setPhase('idle');
			}
			return;
		}

		if (!this.needsSave()) {
			this.clearTimer();
			if (this.phase === 'error') {
				this.setError('');
				this.setPhase('idle');
			}
			return;
		}

		if (this.phase === 'saving') {
			this.pendingSave = true;
			return;
		}

		this.clearTimer();
		this.setPhase('scheduled');
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.tick();
		}, this.debounceMs);
	}

	/**
	 * Execute a single save attempt. Single-flight: if another save is already
	 * running, this is a no-op and the pending flag handles the follow-up.
	 */
	private async tick(): Promise<void> {
		if (this.destroyed || this.isDeleting) return;
		if (this.phase === 'saving') return;
		if (!this.needsSave()) {
			this.setPhase('idle');
			return;
		}

		this.clearTimer();
		this.setPhase('saving');
		this.pendingSave = false;

		const sentSnapshot = { ...this.currentSnapshot };
		const wasCreating = !this.memoId;
		this.savePromise = this.performSave(sentSnapshot);

		try {
			const newId = await this.savePromise;
			if (this.destroyed || this.isDeleting) return;

			if (newId) {
				this.memoId = newId;
				// Defer onCreated until all pending changes are saved and the
				// machine is truly idle.
				this.pendingCreatedId = newId;
			}
			this.savedSnapshot = sentSnapshot;

			if (this.pendingSave || this.needsSave()) {
				// More changes arrived while the request was in flight.
				// If we just created the memo, save the pending changes
				// immediately so the user can be moved to the real edit route.
				this.setPhase('scheduled');
				const delay = newId ? 0 : this.debounceMs;
				this.timer = setTimeout(() => {
					this.timer = null;
					void this.tick();
				}, delay);
			} else {
				this.setError('');
				this.setPhase('saved');
				this.scheduleSavedTimer();
				if (this.pendingCreatedId) {
					this.onCreated?.(this.pendingCreatedId);
					this.pendingCreatedId = null;
				}
			}
		} catch (e) {
			if (this.destroyed || this.isDeleting) return;
			this.setError(e instanceof Error ? e.message : String(e));
			this.setPhase('error');
		} finally {
			this.savePromise = null;
		}
	}

	private async performSave(snapshot: WorkMemoSnapshot): Promise<string | undefined> {
		if (this.memoId) {
			await this.update(this.memoId, snapshot);
			return undefined;
		}
		return await this.create(this.date, snapshot);
	}

	/**
	 * Flush all pending changes. Returns a promise that resolves when every
	 * change that existed at call time (and any changes made while flushing)
	 * has been saved, or rejects if a save fails.
	 */
	async flush(): Promise<void> {
		if (this.destroyed || this.isDeleting) return;
		this.clearTimer();

		while (this.needsSave() || this.savePromise) {
			if (this.savePromise) {
				await this.savePromise;
				continue;
			}
			if (this.phase === 'scheduled') {
				// A save was already scheduled but not yet executed; flush it now.
				this.clearTimer();
				await this.tick();
			} else if (this.needsSave()) {
				await this.tick();
			}
			if (this.phase === 'error') {
				throw new Error(this.error || 'Save failed during flush');
			}
		}
	}

	/**
	 * Persist the snapshot until the machine has shipped **`status`**, and
	 * resolve as soon as a request carrying it has succeeded.
	 *
	 * Why this is not `flush()`. `flush()` resolves when *every* pending change
	 * is saved, so it also waits for changes the user made while the request was
	 * in flight — and it rejects when one of *those* fails. For a status commit
	 * that is the wrong obligation: the status may already be on the server, and
	 * a later body generation failing is an ordinary autosave error that must not
	 * be re-reported as "the status was not saved" (Controller Review Fix 2,
	 * P1-1). This method's contract is exactly the status revision:
	 *
	 *   - a change that arrives afterwards is NOT part of the promise. It stays
	 *     the ordinary autosave path's business, and it is still saved by the
	 *     machine's normal follow-up scheduling;
	 *   - `savedSnapshot` only ever moves on success, so reading
	 *     `savedSnapshot.status === status` is reading "the server holds it" —
	 *     no timeout heuristic, no extra bookkeeping, no second queue;
	 *   - it rejects when an attempt fails while the obligation is still
	 *     outstanding. At that point the status provably is not on the server
	 *     through this call, and the caller must not claim otherwise.
	 *
	 * It does NOT send a status-only payload: the revision that carries the
	 * status is the ordinary full snapshot the machine already owns, and the
	 * request is issued by the same single-flight `tick`. Nothing here is a
	 * second writer.
	 */
	async flushThroughStatus(status: WorkMemoSnapshot['status']): Promise<void> {
		if (this.destroyed || this.isDeleting) {
			throw new Error('Cannot persist a status on a machine that is not saving');
		}

		// The debounce must not be what decides when a status lands.
		this.clearTimer();

		while (this.savedSnapshot.status !== status) {
			if (this.destroyed || this.isDeleting) {
				throw new Error('The save machine was torn down before the status was persisted');
			}

			if (this.savePromise) {
				// An attempt is already on the wire — it may or may not carry the
				// status. Await it and re-read. `tick` handles its own rejection,
				// so a rejection here is the transport's, and it means the
				// obligation is still unmet.
				await this.savePromise;
				continue;
			}

			if (!this.needsSave()) {
				// Nothing is dirty yet the server does not hold the status: the
				// snapshot was rolled back underneath this call. Reporting success
				// would be a lie, and looping would not terminate.
				throw new Error('The status was no longer in the snapshot to persist');
			}

			await this.tick();
			if (this.phase === 'error') {
				throw new Error(this.error || 'Save failed while persisting a status');
			}
		}
	}

	/**
	 * Delete the memo. Waits for any in-flight save to finish first, then
	 * performs the delete. No further saves are accepted after this returns
	 * successfully.
	 */
	async delete(): Promise<boolean> {
		if (this.destroyed || this.isDeleting) return false;
		this.isDeleting = true;
		this.clearTimer();
		this.clearSavedTimer();

		try {
			if (this.savePromise) {
				await this.savePromise;
			}
			if (this.memoId) {
				await this.remove(this.memoId);
			}
			this.destroyed = true;
			return true;
		} catch (e) {
			this.isDeleting = false;
			this.setError(e instanceof Error ? e.message : String(e));
			this.setPhase('error');
			return false;
		}
	}

	destroy() {
		this.destroyed = true;
		this.clearTimer();
		this.clearSavedTimer();
	}
}
