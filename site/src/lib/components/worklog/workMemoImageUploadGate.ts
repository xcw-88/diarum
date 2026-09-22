interface UploadWaiter {
	failureVersion: number;
	resolve: () => void;
	reject: (error: Error) => void;
}

export interface ImageUploadState {
	pending: number;
	error: string | null;
}

/**
 * Coordinates editor image uploads with Worklog navigation. A navigation that
 * starts while uploads are active waits for every upload. If one of those
 * uploads fails, that navigation is rejected once so the user remains on the
 * editor and can see the failure/retry.
 */
export class WorkMemoImageUploadGate {
	private pending = 0;
	private failureVersion = 0;
	private lastError = 'Image upload failed';
	private waiters: UploadWaiter[] = [];

	update(state: ImageUploadState): void {
		this.pending = Math.max(0, state.pending);
		if (state.error) {
			this.failureVersion += 1;
			this.lastError = state.error;
		}
		if (this.pending === 0) this.settleWaiters();
	}

	wait(): Promise<void> {
		if (this.pending === 0) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			this.waiters.push({ failureVersion: this.failureVersion, resolve, reject });
		});
	}

	private settleWaiters(): void {
		const waiters = this.waiters.splice(0);
		for (const waiter of waiters) {
			if (this.failureVersion > waiter.failureVersion) {
				waiter.reject(new Error(this.lastError));
			} else {
				waiter.resolve();
			}
		}
	}
}
