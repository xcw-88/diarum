/**
 * Pure core of the Work Memo <-> Media association client.
 *
 * This module intentionally has **no imports** (no `$lib`, no PocketBase, no
 * Svelte) so the request/response behaviour can be exercised by plain
 * `node:test` without a bundler or a running server. `workMemoMedia.ts` is the
 * thin production wrapper that binds the real `fetch`, the auth token and the
 * project's `WorkMemoApiError`.
 *
 * Backend contract (internal/api/work_memo_media.go):
 *   POST   /api/v1/work-memos/:id/media                  -> 201 { id, memo_id, media_id, position, created }
 *   GET    /api/v1/work-memos/:id/media                  -> 200 { media: [ ...same shape... ] }
 *   DELETE /api/v1/work-memos/:id/media/:associationId   -> 200 { success: true }
 *
 * These endpoints only manage the association row. They never upload, create or
 * delete media records or files.
 *
 * Worklog Frontend Image Integration V1 — Task 1 (attach) + Task 2 (list/detach).
 */

export interface WorkMemoMedia {
	id: string;
	memo_id: string;
	media_id: string;
	position: number;
	created: string;
}

/** Minimal structural shape of the parts of `Response` we consume. */
export interface HttpClientResponse {
	status: number;
	ok: boolean;
	json: () => Promise<unknown>;
}

export interface HttpClientInit {
	method: string;
	headers: Record<string, string>;
	/** Omitted entirely for bodyless GET/DELETE requests. */
	body?: string;
}

export type HttpClient = (url: string, init: HttpClientInit) => Promise<HttpClientResponse>;

/** Builds the error type thrown for non-2xx responses (project-specific). */
export type ApiErrorFactory = (status: number, message: string) => Error;

/** Shared transport options for every association endpoint. */
export interface AssociationRequestOptions {
	fetchFn: HttpClient;
	apiError: ApiErrorFactory;
	/** Auth token; the client never invents or caches its own. */
	token: string;
	memoId: string;
}

export interface AttachRequestOptions extends AssociationRequestOptions {
	mediaId: string;
}

export interface DetachRequestOptions extends AssociationRequestOptions {
	associationId: string;
}

function mediaCollectionUrl(memoId: string): string {
	return `/api/v1/work-memos/${encodeURIComponent(memoId)}/media`;
}

/** Coerce an untrusted API payload into a `WorkMemoMedia`. */
export function normalizeWorkMemoMedia(raw: unknown): WorkMemoMedia {
	const data = (raw ?? {}) as Record<string, unknown>;
	return {
		id: typeof data.id === 'string' ? data.id : '',
		memo_id: typeof data.memo_id === 'string' ? data.memo_id : '',
		media_id: typeof data.media_id === 'string' ? data.media_id : '',
		position: typeof data.position === 'number' ? data.position : 0,
		created: typeof data.created === 'string' ? data.created : ''
	};
}

/**
 * Coerce the `{ media: [...] }` list payload into associations.
 *
 * Rows carrying no usable `id` (needed to detach) or no `media_id` (needed to
 * match the body) are dropped: they cannot take part in reconciliation, and
 * keeping them would make them look "stale" and trigger a destructive detach of
 * a row we do not actually understand.
 */
export function normalizeWorkMemoMediaList(raw: unknown): WorkMemoMedia[] {
	const container = (raw ?? {}) as Record<string, unknown>;
	const items = Array.isArray(container.media) ? container.media : [];
	const out: WorkMemoMedia[] = [];
	for (const item of items) {
		if (!item || typeof item !== 'object') continue;
		const association = normalizeWorkMemoMedia(item);
		if (!association.id || !association.media_id) continue;
		out.push(association);
	}
	return out;
}

function requireOk(
	response: HttpClientResponse,
	apiError: ApiErrorFactory,
	notFoundMessage: string
): void {
	if (response.ok) return;
	if (response.status === 401) throw apiError(401, 'Unauthorized');
	if (response.status === 404) throw apiError(404, notFoundMessage);
	if (response.status >= 400 && response.status < 500) {
		throw apiError(response.status, `Validation error: HTTP ${response.status}`);
	}
	throw apiError(response.status, `Server error: HTTP ${response.status}`);
}

/**
 * POST /api/v1/work-memos/:id/media with `{ media_id }`.
 *
 * A 409 means "already associated" and is surfaced as an error carrying
 * `status = 409`; callers (see `WorkMemoMediaReconciler`) treat that as
 * success. Every other non-2xx is surfaced with its HTTP status.
 */
export async function attachWorkMemoMediaRequest(
	options: AttachRequestOptions
): Promise<WorkMemoMedia> {
	const { fetchFn, apiError, token, memoId, mediaId } = options;

	const response = await fetchFn(mediaCollectionUrl(memoId), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ media_id: mediaId })
	});

	if (response.status === 409) {
		// Duplicate association: the backend already links this media to the
		// memo. Callers should treat this as success.
		throw apiError(409, 'Media already attached to this work memo');
	}
	requireOk(response, apiError, 'Work memo or media not found');

	const data = await response.json();
	return normalizeWorkMemoMedia(data);
}

/**
 * GET /api/v1/work-memos/:id/media.
 *
 * Returns the memo's current associations. The backend returns no media URL
 * here, and this client never derives a media id from a URL.
 */
export async function listWorkMemoMediaRequest(
	options: AssociationRequestOptions
): Promise<WorkMemoMedia[]> {
	const { fetchFn, apiError, token, memoId } = options;

	const response = await fetchFn(mediaCollectionUrl(memoId), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	requireOk(response, apiError, 'Work memo not found');

	const data = await response.json();
	return normalizeWorkMemoMediaList(data);
}

/**
 * DELETE /api/v1/work-memos/:id/media/:associationId.
 *
 * Removes ONLY the association row. A missing association (404) is surfaced as
 * an error carrying `status = 404`; callers treat it as "already gone".
 */
export async function detachWorkMemoMediaRequest(
	options: DetachRequestOptions
): Promise<void> {
	const { fetchFn, apiError, token, memoId, associationId } = options;

	const response = await fetchFn(
		`${mediaCollectionUrl(memoId)}/${encodeURIComponent(associationId)}`,
		{
			method: 'DELETE',
			headers: { Authorization: `Bearer ${token}` }
		}
	);
	requireOk(response, apiError, 'Work memo media association not found');
}
