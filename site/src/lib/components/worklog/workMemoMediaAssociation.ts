/**
 * Pure, dependency-free coordination logic for linking Diarum Media records to a
 * Work Memo. Kept free of Svelte, PocketBase, and `$lib` imports so it can be
 * unit tested with plain `node:test`.
 *
 * Responsibilities (Worklog Frontend Image Integration V1):
 *  - diff the body's stable `data-media-id` set against the server's
 *    associations and compute exactly which associations to add or drop
 *  - recover associations lost by an earlier failed attach
 *  - drop associations whose media is no longer referenced by the body — but
 *    only once the LAST node referencing it is gone
 *  - never issue a request when the media set did not change
 *  - serialize every mutation and drain only the latest desired media set
 *  - never retry in a loop, never delete media, never touch `position`
 *
 * This module does NOT perform any save/snapshot logic, nor does it touch the
 * editor. Those remain the responsibility of WorkMemoEditor.
 */

export interface AttachResult {
	id: string;
	memo_id: string;
	media_id: string;
	position: number;
	created: string;
}

export type AttachFn = (memoId: string, mediaId: string) => Promise<AttachResult>;

/**
 * Association row as returned by `GET /api/v1/work-memos/:id/media`.
 * Structurally identical to the API client's `WorkMemoMedia`.
 */
export interface WorkMemoMediaAssociation {
	id: string;
	memo_id: string;
	media_id: string;
	position: number;
	created: string;
}

export type ListAssociationsFn = (memoId: string) => Promise<WorkMemoMediaAssociation[]>;
export type DetachFn = (memoId: string, associationId: string) => Promise<void>;

function isDuplicateAssociationError(e: unknown): boolean {
	return statusOf(e) === 409;
}

function statusOf(e: unknown): number | null {
	if (!e || typeof e !== 'object') return null;
	const status = (e as { status?: unknown }).status;
	return typeof status === 'number' ? status : null;
}

interface UploadMediaResult {
	id?: string | null;
}
interface CheveretoResult {
	cheveretoUrl: string;
}

/**
 * Given the result of an image upload or a media-library pick, return the
 * Diarum media id that can be associated with a Work Memo, or null when the
 * result carries no Diarum media id (e.g. a Chevereto external link).
 *
 * Chevereto is an explicit Worklog V1 degradation: externally-hosted images
 * appear in the memo body but are intentionally NOT part of Work Memo Media
 * association management.
 */
export function extractCommittableMediaId(
	result: UploadMediaResult | CheveretoResult
): string | null {
	if (result && 'cheveretoUrl' in result) return null;
	const id = (result as UploadMediaResult).id;
	return id ? String(id) : null;
}

const DATA_MEDIA_ID_IMG = /<img\b[^>]*\bdata-media-id\s*=\s*["']([^"']+)["']/gi;

/** Extract every `data-media-id` value from image tags in an HTML string. */
export function extractDataMediaIds(html: string): string[] {
	const matches = html.matchAll(DATA_MEDIA_ID_IMG);
	return [...matches].map((m) => m[1]);
}

/**
 * Collapse media ids to the unique, non-empty set that the body actually
 * references. A media referenced by several image nodes contributes ONE id.
 */
export function uniqueMediaIds(ids: Iterable<string>): Set<string> {
	const set = new Set<string>();
	for (const id of ids) if (id) set.add(id);
	return set;
}

const MEDIA_KEY_SEPARATOR = '\u0000';

/**
 * Stable, order-independent key for a media set. Reordering images in the body
 * does not change the referenced media, so it must not trigger a reconcile.
 */
export function mediaSetKey(ids: Iterable<string>): string {
	return [...uniqueMediaIds(ids)].sort().join(MEDIA_KEY_SEPARATOR);
}

export interface WorkMemoMediaDiff {
	/** Media ids referenced by the body but missing on the server. */
	attach: string[];
	/** Associations on the server that the body no longer references. */
	detach: WorkMemoMediaAssociation[];
}

/**
 * The single V1 reconciliation rule.
 *
 *   desired (unique data-media-id in the body) vs actual (server associations)
 *     A. in desired, not in actual  -> attach
 *     B. in actual, not in desired  -> detach
 *     C. in both                    -> nothing
 *     D. same media in several nodes -> still one id, so at most one association
 *
 * Associations of media that are still referenced are never touched, so a media
 * used by two image nodes keeps its association until the last node is removed.
 * `position` is never read for ordering the body and never rewritten.
 */
export function computeWorkMemoMediaDiff(
	desiredIds: Iterable<string>,
	associations: readonly WorkMemoMediaAssociation[]
): WorkMemoMediaDiff {
	const desired = uniqueMediaIds(desiredIds);

	const actualByMedia = new Map<string, WorkMemoMediaAssociation[]>();
	for (const association of associations) {
		if (!association || !association.id || !association.media_id) continue;
		const bucket = actualByMedia.get(association.media_id);
		if (bucket) bucket.push(association);
		else actualByMedia.set(association.media_id, [association]);
	}

	const attach: string[] = [];
	for (const mediaId of desired) {
		if (!actualByMedia.has(mediaId)) attach.push(mediaId);
	}

	const detach: WorkMemoMediaAssociation[] = [];
	for (const [mediaId, rows] of actualByMedia) {
		if (!desired.has(mediaId)) {
			// Rule B: nothing in the body references this media any more.
			detach.push(...rows);
			continue;
		}
		if (rows.length > 1) {
			// Defensive: UNIQUE(memo_id, media_id) makes this impossible today,
			// but if it ever happened the memo would show duplicate attachments
			// for one media. Keep the lowest-position row and drop the extras.
			const sorted = [...rows].sort(
				(a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)
			);
			detach.push(...sorted.slice(1));
		}
	}

	return { attach, detach };
}

export type ReconcileSkipReason = 'no-memo' | 'unchanged' | 'stale' | 'list-failed';

export interface ReconcileResult {
	/** Non-null when the pass did not run to completion. */
	skipped: ReconcileSkipReason | null;
	/** Media ids successfully attached during this pass. */
	attached: string[];
	/** Association ids successfully detached during this pass. */
	detached: string[];
	/** Mutations that failed (logged, never retried in a loop). */
	failed: number;
}

export interface WorkMemoMediaReconcilerOptions {
	list: ListAssociationsFn;
	attach: AttachFn;
	detach: DetachFn;
}

interface ReconcileRequest {
	version: number;
	memoId: string;
	desiredIds: string[];
	desiredKey: string;
	resolve: (result: ReconcileResult) => void;
}

const emptyResult = (skipped: ReconcileSkipReason | null = null): ReconcileResult => ({
	skipped,
	attached: [],
	detached: [],
	failed: 0
});

/**
 * Brings the server's association set back in line with the body's stable
 * `data-media-id` set.
 *
 * Triggers are owned by the caller: initial load of an existing memo, a change
 * of the body's media set, and one recovery pass after a new memo is created.
 * Ordinary typing, status and pin changes never reach this class.
 *
 * Race protection: one worker owns every association mutation. A new request
 * replaces the queued desired state while the current request finishes its
 * single in-flight operation. The worker then re-lists server state and drains
 * only that latest desired state. This prevents overlapping attach/detach calls
 * and prevents a late old mutation from becoming the final server state.
 *
 * Failure policy: attach 409 and detach 404 are equivalent to success; every
 * other failure is logged and dropped. There is no timer, no backoff and no
 * retry loop — the next trigger recovers.
 */
export class WorkMemoMediaReconciler {
	private currentMemoId: string | null = null;
	private generation = 0;
	private lastReconciledKey: string | null = null;
	private workerRunning = false;
	private queuedRequest: ReconcileRequest | null = null;
	private readonly list: ListAssociationsFn;
	private readonly attach: AttachFn;
	private readonly detach: DetachFn;

	constructor(options: WorkMemoMediaReconcilerOptions) {
		this.list = options.list;
		this.attach = options.attach;
		this.detach = options.detach;
	}

	get memoId(): string | null {
		return this.currentMemoId;
	}

	/** Generation of the most recent pass; exposed for diagnostics/tests. */
	get currentGeneration(): number {
		return this.generation;
	}

	/** Media-set key of the last completed pass, or null before any pass. */
	get lastKey(): string | null {
		return this.lastReconciledKey;
	}

	setMemoId(memoId: string): void {
		if (this.currentMemoId === memoId) return;
		this.invalidate();
		this.currentMemoId = memoId;
	}

	/**
	 * Discard any in-flight pass. Its response will be ignored and it will not
	 * mutate anything.
	 */
	invalidate(): void {
		this.generation += 1;
		this.lastReconciledKey = null;
		if (this.queuedRequest) {
			this.queuedRequest.resolve(emptyResult('stale'));
			this.queuedRequest = null;
		}
	}

	/**
	 * Run one reconciliation pass.
	 *
	 * @param desiredIds media ids referenced by the body
	 * @param options.force run even when the media set matches the last pass
	 *                      (used for initial load and post-create recovery)
	 */
	reconcile(
		desiredIds: Iterable<string>,
		options: { force?: boolean } = {}
	): Promise<ReconcileResult> {
		// New memo associations are intentionally deferred to the edit route's
		// initial forced reconciliation. Never mutate against a missing memo id.
		if (!this.currentMemoId) {
			return Promise.resolve(emptyResult('no-memo'));
		}

		const normalizedIds = [...uniqueMediaIds(desiredIds)];
		const desiredKey = mediaSetKey(normalizedIds);
		if (
			!options.force &&
			!this.workerRunning &&
			!this.queuedRequest &&
			desiredKey === this.lastReconciledKey
		) {
			// Ordinary typing does not change the media set: no request at all.
			return Promise.resolve(emptyResult('unchanged'));
		}

		const memoId = this.currentMemoId;
		const version = ++this.generation;
		// Once a pass is needed, no key remains trusted until the latest pass has
		// re-listed state and completed every required mutation successfully.
		this.lastReconciledKey = null;

		return new Promise<ReconcileResult>((resolve) => {
			if (this.queuedRequest) {
				// This queued state never started; only the newest desired state needs
				// to be drained after the active operation settles.
				this.queuedRequest.resolve(emptyResult('stale'));
			}
			this.queuedRequest = { version, memoId, desiredIds: normalizedIds, desiredKey, resolve };
			if (!this.workerRunning) {
				this.workerRunning = true;
				void this.drain();
			}
		});
	}

	private async drain(): Promise<void> {
		try {
			while (this.queuedRequest) {
				const request = this.queuedRequest;
				this.queuedRequest = null;
				let result: ReconcileResult;
				try {
					result = await this.runPass(request);
				} catch (e) {
					// Defensive boundary: endpoint failures are handled in runPass, but
					// a surprising client exception must still settle the caller and keep
					// the reconciler retryable on the next explicit trigger.
					console.error('Unexpected work memo media reconcile failure:', e);
					result = { ...emptyResult('list-failed'), failed: 1 };
				}
				request.resolve(result);
			}
		} finally {
			this.workerRunning = false;
			// JavaScript cannot interleave between the final while check and this
			// assignment, but retain a defensive restart if that ever changes.
			if (this.queuedRequest) {
				this.workerRunning = true;
				void this.drain();
			}
		}
	}

	private async runPass(request: ReconcileRequest): Promise<ReconcileResult> {
		const { memoId, desiredIds, desiredKey, version } = request;
		const isStale = () => this.generation !== version || this.currentMemoId !== memoId;
		const result = emptyResult();

		let associations: WorkMemoMediaAssociation[];
		try {
			associations = await this.list(memoId);
		} catch (e) {
			if (isStale()) return { ...result, skipped: 'stale' };
			// No lastKey is recorded, so the next trigger retries. No loop here.
			console.error('Failed to list work memo media associations:', e);
			return { ...result, skipped: 'list-failed', failed: result.failed + 1 };
		}

		if (isStale()) {
			// A newer pass started while we were waiting. Do not mutate.
			return { ...result, skipped: 'stale' };
		}

		const diff = computeWorkMemoMediaDiff(desiredIds, associations);

		for (const mediaId of diff.attach) {
			if (isStale()) return { ...result, skipped: 'stale' };
			let succeeded = false;
			try {
				await this.attach(memoId, mediaId);
				succeeded = true;
			} catch (e) {
				if (isDuplicateAssociationError(e)) {
					// 409: the association already exists -> final state correct.
					succeeded = true;
				} else {
					result.failed += 1;
					console.error('Failed to attach media during reconcile:', e);
				}
			}
			if (succeeded) result.attached.push(mediaId);
			// A newer desired state may have arrived while this mutation was in
			// flight. Stop this pass immediately; drain() will re-list and repair
			// from the actual post-mutation server state.
			if (isStale()) return { ...result, skipped: 'stale' };
		}

		for (const association of diff.detach) {
			if (isStale()) return { ...result, skipped: 'stale' };
			let succeeded = false;
			try {
				await this.detach(memoId, association.id);
				succeeded = true;
			} catch (e) {
				if (statusOf(e) === 404) {
					// Already gone: equivalent to success.
					succeeded = true;
				} else {
					result.failed += 1;
					console.error('Failed to detach media during reconcile:', e);
				}
			}
			if (succeeded) result.detached.push(association.id);
			if (isStale()) return { ...result, skipped: 'stale' };
		}

		if (isStale()) return { ...result, skipped: 'stale' };
		// Record only a fully successful latest pass. Any unresolved failure
		// leaves the key unset, so the next explicit trigger retries once.
		if (result.failed === 0) this.lastReconciledKey = desiredKey;

		return result;
	}
}
