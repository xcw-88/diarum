/**
 * Pure request core for a Work Memo **status-only** update.
 *
 * Why this file exists (Diary Multi-Event V1 — Task 2)
 * ----------------------------------------------------
 * Marking a diary Event as a todo changes `work_memos.status` and nothing else.
 * The tempting shortcut — reuse the editor's snapshot and `PUT` it back — is a
 * stale-write hazard: the snapshot may hold a body the user has since edited, so
 * a Todo toggle could roll the text back. `buildWorkMemoStatusBody` therefore has
 * a signature with **no parameter** through which content, date, position, tags
 * or `is_pinned` could travel. A status change cannot carry a stale body because
 * there is nowhere to put one.
 *
 * Zero runtime imports on purpose: the project's only frontend test mechanism is
 * `node --experimental-transform-types --test`, and Node's ESM resolver does not
 * guess an extension for a TypeScript specifier, so a module a test imports must
 * not pull in a sibling module at runtime. Everything here is injected by the
 * thin binding in `workMemos.ts` (transport, auth token, error type) — the same
 * two-layer shape as `workMemoMediaCore` / `workMemoMedia`.
 */

/** The three states a Work Memo may hold. Mirrors the backend's enum. */
export type WorkMemoStatusValue = 'normal' | 'pending' | 'completed';

const WORK_MEMO_STATUS_VALUES: readonly WorkMemoStatusValue[] = ['normal', 'pending', 'completed'];

/** Whether an untrusted value is one of the three persisted statuses. */
export function isWorkMemoStatusValue(value: unknown): value is WorkMemoStatusValue {
	return (
		typeof value === 'string' && (WORK_MEMO_STATUS_VALUES as readonly string[]).includes(value)
	);
}

/**
 * The fields a partial Work Memo update may carry.
 *
 * `position` and `tags` are deliberately absent: position is assigned by the
 * backend on create and on a cross-date move, and tags have no UI in this round.
 */
export interface WorkMemoUpdateDraft {
	content?: string;
	date?: string;
	status?: WorkMemoStatusValue;
	is_pinned?: boolean;
}

/**
 * The PUT body for a partial update: exactly the keys the caller supplied.
 *
 * An omitted key is **absent** from the body rather than sent as `null`, which
 * is what makes the backend leave that column alone (`UpdateWorkMemo` only adds
 * a `SET` clause for a non-nil input field).
 */
export function buildWorkMemoUpdateBody(input: WorkMemoUpdateDraft): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	if (input.content !== undefined) body.content = input.content;
	if (input.date !== undefined) body.date = input.date;
	if (input.status !== undefined) body.status = input.status;
	if (input.is_pinned !== undefined) body.is_pinned = input.is_pinned;
	return body;
}

/**
 * The body of a status-only update.
 *
 * Its signature is the guarantee: `status` is the only thing that can reach the
 * wire. Adding a second field here would mean writing the stale-body bug into
 * the type system instead of relying on a reviewer to notice.
 */
export function buildWorkMemoStatusBody(status: WorkMemoStatusValue): {
	status: WorkMemoStatusValue;
} {
	return { status };
}

/** The absolute path of the single Work Memo resource endpoint. */
export function workMemoResourcePath(id: string): string {
	return `/api/v1/work-memos/${encodeURIComponent(id)}`;
}

export interface WorkMemoStatusRequestOptions {
	fetchFn: (url: string, init: RequestInit) => Promise<Response>;
	/**
	 * Builds the project's API error for a non-2xx response.
	 *
	 * The core **throws whatever this returns**, so an implementation may either
	 * throw directly (as `handleResponseError` does) or return the error object.
	 * Neither shape can be silently ignored, which is the failure mode a bare
	 * `options.apiError(response);` statement would have.
	 */
	apiError: (response: Response) => Error;
	token: string;
	id: string;
	status: WorkMemoStatusValue;
	signal?: AbortSignal;
}

/**
 * PUT /api/v1/work-memos/:id with a status-only body.
 *
 * Resolves with the raw updated Work Memo payload (the binding normalizes it).
 * Rejects through the injected `apiError` for any non-2xx response, and with the
 * underlying error for a transport failure. There is no retry and no offline
 * queue: the caller must be able to tell the user the truth.
 */
export async function updateWorkMemoStatusRequest(
	options: WorkMemoStatusRequestOptions
): Promise<unknown> {
	const response = await options.fetchFn(workMemoResourcePath(options.id), {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${options.token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(buildWorkMemoStatusBody(options.status)),
		signal: options.signal
	});

	if (!response.ok) {
		throw options.apiError(response);
	}

	return await response.json();
}
