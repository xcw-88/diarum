import { pb } from './client';
import { WorkMemoApiError } from './workMemos';
import {
	attachWorkMemoMediaRequest,
	listWorkMemoMediaRequest,
	detachWorkMemoMediaRequest,
	normalizeWorkMemoMedia,
	normalizeWorkMemoMediaList,
	type AssociationRequestOptions,
	type WorkMemoMedia
} from './workMemoMediaCore';

export type { WorkMemoMedia };
export { normalizeWorkMemoMedia, normalizeWorkMemoMediaList };

/**
 * Binds the pure request core to the project's real transport, auth store and
 * error type. Nothing here invents a media id, caches a response, or retries.
 */
function baseOptions(memoId: string): Omit<AssociationRequestOptions, 'memoId'> & { memoId: string } {
	return {
		fetchFn: (url, init) => fetch(url, init),
		apiError: (status, message) => new WorkMemoApiError(status, message),
		token: pb.authStore.token,
		memoId
	};
}

/**
 * Associate an existing Diarum Media record with a Work Memo.
 *
 * POST /api/v1/work-memos/:id/media
 * body: { media_id }
 *
 * Resolves with the created association. A backend 409 (already associated)
 * rejects with a `WorkMemoApiError` carrying `status = 409` so callers can treat
 * it as success. All other non-2xx responses reject with a `WorkMemoApiError`
 * carrying the HTTP status. Network failures reject with the underlying error.
 */
export function attachWorkMemoMedia(memoId: string, mediaId: string): Promise<WorkMemoMedia> {
	return attachWorkMemoMediaRequest({ ...baseOptions(memoId), mediaId });
}

/**
 * List the memo's current media associations.
 *
 * GET /api/v1/work-memos/:id/media -> { media: [...] }
 *
 * Returns the association rows only. The response carries no media URL, and no
 * media id is ever derived from a URL.
 */
export function listWorkMemoMedia(memoId: string): Promise<WorkMemoMedia[]> {
	return listWorkMemoMediaRequest(baseOptions(memoId));
}

/**
 * Detach one media association from a Work Memo.
 *
 * DELETE /api/v1/work-memos/:id/media/:associationId
 *
 * Removes only the association row: it never deletes the media record, the
 * local file, any S3 object, or another memo's association to the same media.
 * A 404 (already gone) rejects with `status = 404`; callers treat it as
 * equivalent to success.
 */
export function detachWorkMemoMedia(memoId: string, associationId: string): Promise<void> {
	return detachWorkMemoMediaRequest({ ...baseOptions(memoId), associationId });
}
