import { pb } from './client';
import {
	buildWorkMemoUpdateBody,
	isWorkMemoStatusValue,
	updateWorkMemoStatusRequest,
	workMemoResourcePath,
	type WorkMemoStatusValue
} from './workMemoStatusCore';

export interface WorkMemo {
	id: string;
	owner: string;
	date: string;
	content: string;
	status: 'normal' | 'pending' | 'completed';
	is_pinned: boolean;
	position: number;
	tags: string[];
	created: string;
	updated: string;
}

export interface WorkMemoListResult {
	date: string;
	memos: WorkMemo[];
}

export interface WorkMemoCalendarDay {
	date: string;
	count: number;
}

export interface WorkMemoCalendarResult {
	month: string;
	days: WorkMemoCalendarDay[];
}

/**
 * The three states a Work Memo may hold. Owned by `workMemoStatusCore` (the
 * module the tests can load) and re-exported here so every caller keeps the
 * single import site it already had.
 */
export type WorkMemoStatus = WorkMemoStatusValue;

export { buildWorkMemoStatusBody, isWorkMemoStatusValue, workMemoResourcePath } from './workMemoStatusCore';

export class WorkMemoApiError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
		this.name = 'WorkMemoApiError';
	}
}

function authHeaders(): Record<string, string> {
	return {
		Authorization: `Bearer ${pb.authStore.token}`,
		'Content-Type': 'application/json'
	};
}

function handleResponseError(response: Response): never {
	if (response.status === 401) {
		throw new WorkMemoApiError(401, 'Unauthorized');
	}
	if (response.status === 404) {
		throw new WorkMemoApiError(404, 'Not found');
	}
	if (response.status >= 400 && response.status < 500) {
		throw new WorkMemoApiError(response.status, `Validation error: HTTP ${response.status}`);
	}
	throw new WorkMemoApiError(response.status, `Server error: HTTP ${response.status}`);
}

/**
 * List work memos for a specific date.
 */
export async function listWorkMemosByDate(
	date: string,
	signal?: AbortSignal
): Promise<WorkMemoListResult> {
	const response = await fetch(`/api/v1/work-memos/by-date/${encodeURIComponent(date)}`, {
		headers: { Authorization: `Bearer ${pb.authStore.token}` },
		signal
	});

	if (!response.ok) {
		handleResponseError(response);
	}

	const data = await response.json();
	return {
		date: data.date || date,
		memos: normalizeWorkMemos(data.memos || [])
	};
}

/**
 * Get the per-day work memo counts for one YYYY-MM month.
 */
export async function getWorkMemoCalendar(
	month: string,
	signal?: AbortSignal
): Promise<WorkMemoCalendarResult> {
	const response = await fetch(
		`/api/v1/work-memos/calendar?month=${encodeURIComponent(month)}`,
		{
			headers: { Authorization: `Bearer ${pb.authStore.token}` },
			signal
		}
	);

	if (!response.ok) {
		handleResponseError(response);
	}

	const data = await response.json();
	const days = Array.isArray(data.days)
		? data.days
				.filter(
					(day: unknown): day is { date: string; count: number } =>
						typeof day === 'object' &&
						day !== null &&
						typeof (day as Record<string, unknown>).date === 'string' &&
						typeof (day as Record<string, unknown>).count === 'number'
				)
				.map((day: { date: string; count: number }) => ({
					date: day.date,
					count: day.count
				}))
		: [];

	return {
		month: typeof data.month === 'string' ? data.month : month,
		days
	};
}

/**
 * Get a single work memo by ID.
 */
export async function getWorkMemo(id: string, signal?: AbortSignal): Promise<WorkMemo> {
	const response = await fetch(`/api/v1/work-memos/${encodeURIComponent(id)}`, {
		headers: { Authorization: `Bearer ${pb.authStore.token}` },
		signal
	});

	if (!response.ok) {
		handleResponseError(response);
	}

	const data = await response.json();
	return normalizeWorkMemo(data);
}

export interface CreateWorkMemoInput {
	date: string;
	content: string;
	status?: WorkMemoStatus;
	is_pinned?: boolean;
}

/**
 * Create a new work memo. Position is always assigned by the backend.
 */
export async function createWorkMemo(
	input: CreateWorkMemoInput,
	signal?: AbortSignal
): Promise<WorkMemo> {
	const response = await fetch('/api/v1/work-memos', {
		method: 'POST',
		headers: authHeaders(),
		body: JSON.stringify({
			date: input.date,
			content: input.content,
			status: input.status || 'normal',
			is_pinned: input.is_pinned || false,
			tags: []
		}),
		signal
	});

	if (!response.ok) {
		handleResponseError(response);
	}

	const data = await response.json();
	return normalizeWorkMemo(data);
}

export interface UpdateWorkMemoInput {
	content?: string;
	date?: string;
	status?: WorkMemoStatus;
	is_pinned?: boolean;
}

/**
 * Update an existing work memo. Only provided fields are sent to the backend.
 */
export async function updateWorkMemo(
	id: string,
	input: UpdateWorkMemoInput,
	signal?: AbortSignal
): Promise<WorkMemo> {
	const body = buildWorkMemoUpdateBody(input);

	const response = await fetch(workMemoResourcePath(id), {
		method: 'PUT',
		headers: authHeaders(),
		body: JSON.stringify(body),
		signal
	});

	if (!response.ok) {
		handleResponseError(response);
	}

	const data = await response.json();
	return normalizeWorkMemo(data);
}

/**
 * Change only a work memo's todo status (Diary Multi-Event V1 — Task 2).
 *
 * `PUT /api/v1/work-memos/:id` with the body `{ status }` and nothing else.
 *
 * This is the read-only card's write path: an Event that is not open in an
 * editor has no live body to submit, so reusing `updateWorkMemo` with a full
 * snapshot would be a stale write waiting to happen. The body is built by
 * `buildWorkMemoStatusBody`, whose signature cannot carry content, date,
 * position, tags or `is_pinned`. created/updated are the backend's business.
 *
 * An Event that IS open in an editor must not use this — it changes status
 * through the shared editing session instead, so the save machine's single
 * snapshot owns both the body and the status and neither can overwrite the
 * other. See `DiaryEventEditor.svelte`.
 *
 * There is no offline queue and no retry: a failure rejects, and the caller
 * must restore the previous status and say so.
 */
export async function updateWorkMemoStatus(
	id: string,
	status: WorkMemoStatus,
	signal?: AbortSignal
): Promise<WorkMemo> {
	const data = await updateWorkMemoStatusRequest({
		fetchFn: (url, init) => fetch(url, init),
		apiError: handleResponseError,
		token: pb.authStore.token,
		id,
		status,
		signal
	});
	return normalizeWorkMemo(data);
}

/**
 * Delete a work memo.
 */
export async function deleteWorkMemo(id: string, signal?: AbortSignal): Promise<void> {
	const response = await fetch(`/api/v1/work-memos/${encodeURIComponent(id)}`, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${pb.authStore.token}` },
		signal
	});

	if (!response.ok) {
		handleResponseError(response);
	}
}

function normalizeWorkMemo(raw: any): WorkMemo {
	return {
		id: raw.id || '',
		owner: raw.owner || '',
		date: raw.date || '',
		content: raw.content || '',
		status: isWorkMemoStatusValue(raw.status) ? raw.status : 'normal',
		is_pinned: Boolean(raw.is_pinned),
		position: typeof raw.position === 'number' ? raw.position : 0,
		tags: Array.isArray(raw.tags) ? raw.tags : [],
		created: raw.created || '',
		updated: raw.updated || ''
	};
}

function normalizeWorkMemos(raws: any[]): WorkMemo[] {
	return raws.map(normalizeWorkMemo);
}
