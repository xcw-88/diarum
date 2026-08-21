import { pb } from './client';

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

export type WorkMemoStatus = 'normal' | 'pending' | 'completed';

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
	const body: Record<string, unknown> = {};
	if (input.content !== undefined) body.content = input.content;
	if (input.date !== undefined) body.date = input.date;
	if (input.status !== undefined) body.status = input.status;
	if (input.is_pinned !== undefined) body.is_pinned = input.is_pinned;

	const response = await fetch(`/api/v1/work-memos/${encodeURIComponent(id)}`, {
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
		status: isValidStatus(raw.status) ? raw.status : 'normal',
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

function isValidStatus(status: unknown): status is WorkMemoStatus {
	return status === 'normal' || status === 'pending' || status === 'completed';
}
