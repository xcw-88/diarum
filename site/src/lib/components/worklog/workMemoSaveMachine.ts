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
