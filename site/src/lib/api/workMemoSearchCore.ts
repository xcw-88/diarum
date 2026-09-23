/**
 * Pure core of the Worklog search client (Worklog Search V1 — Task 2).
 *
 * This module intentionally has **no imports** (no `$lib`, no PocketBase, no
 * Svelte) so the URL-state model, the query serialization and the request /
 * response behaviour can be exercised by plain `node:test` without a bundler or
 * a running server. `workMemoSearch.ts` is the thin production wrapper that
 * binds the real `fetch`, the auth token and the project's `WorkMemoApiError`.
 *
 * Backend contract (internal/api/work_memos_search.go), committed in Task 1:
 *   GET /api/v1/work-memos/search?q&tag&status&date_from&date_to&sort&page&page_size
 *     -> 200 { items, page, page_size, total, total_pages }
 *     -> 400 when no criterion is present, or when a parameter is malformed
 *
 * The response items carry `{ id, date, snippet, status, is_pinned, tags,
 * position }`. The endpoint deliberately returns **no content / owner /
 * search_text**, so this client never assumes, reads or reconstructs them, and
 * the snippet is plain text that must be rendered as a text node — never
 * through `{@html}`.
 */

export type WorkMemoSearchStatus = 'normal' | 'pending' | 'completed';

export type WorkMemoSearchSort = 'date_desc' | 'date_asc';

/** The page size the search page uses. V1 does not expose it in the UI. */
export const WORK_MEMO_SEARCH_PAGE_SIZE = 20;

export const WORK_MEMO_SEARCH_DEFAULT_SORT: WorkMemoSearchSort = 'date_desc';

/** One search hit, exactly as the backend returns it (normalized defensively). */
export interface WorkMemoSearchItem {
	id: string;
	date: string;
	snippet: string;
	status: WorkMemoSearchStatus;
	is_pinned: boolean;
	tags: string[];
	position: number;
}

export interface WorkMemoSearchResponse {
	items: WorkMemoSearchItem[];
	page: number;
	page_size: number;
	total: number;
	total_pages: number;
}

/**
 * Normalized search state. This is the shape carried by the URL and by the API
 * request: every field is present, empty strings mean "no such filter".
 */
export interface WorkMemoSearchState {
	q: string;
	tag: string;
	status: WorkMemoSearchStatus | '';
	date_from: string;
	date_to: string;
	sort: WorkMemoSearchSort;
	page: number;
}

/**
 * Loose input accepted by `normalizeWorkMemoSearchState`: a URL, a form or an
 * API payload may carry any string in any field.
 */
export interface WorkMemoSearchStateInput {
	q?: string;
	tag?: string;
	status?: string;
	date_from?: string;
	date_to?: string;
	sort?: string;
	page?: number | string;
}

/**
 * The editable form fields of the search page. Identical to the search state
 * minus the page, because submitting a new search always returns to page 1.
 */
export interface WorkMemoSearchDraft {
	q: string;
	tag: string;
	status: WorkMemoSearchStatus | '';
	date_from: string;
	date_to: string;
	sort: WorkMemoSearchSort;
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
	signal?: AbortSignal;
}

export type HttpClient = (url: string, init: HttpClientInit) => Promise<HttpClientResponse>;

/** Builds the error type thrown for non-2xx responses (project-specific). */
export type ApiErrorFactory = (status: number, message: string) => Error;

export const WORK_MEMO_SEARCH_PATH = '/worklog/search';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidWorkMemoSearchStatus(value: unknown): value is WorkMemoSearchStatus {
	return value === 'normal' || value === 'pending' || value === 'completed';
}

export function isValidWorkMemoSearchSort(value: unknown): value is WorkMemoSearchSort {
	return value === 'date_desc' || value === 'date_asc';
}

/**
 * Validate a `YYYY-MM-DD` string, including that it denotes a real calendar
 * date (so `2026-02-30` is rejected). Mirrors `$lib/utils/date.isValidDate`,
 * duplicated here to keep this module import-free.
 */
export function isWorkMemoSearchDate(value: unknown): value is string {
	if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
	const [year, month, day] = value.split('-').map((part) => parseInt(part, 10));
	const parsed = new Date(`${value}T00:00:00`);
	return (
		!Number.isNaN(parsed.getTime()) &&
		parsed.getFullYear() === year &&
		parsed.getMonth() === month - 1 &&
		parsed.getDate() === day
	);
}

function toPage(value: unknown): number {
	const raw = typeof value === 'string' ? value.trim() : value;
	if (typeof raw === 'number') {
		return Number.isInteger(raw) && raw >= 1 ? raw : 1;
	}
	if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return 1;
	const parsed = parseInt(raw, 10);
	return parsed >= 1 ? parsed : 1;
}

function toCount(value: unknown, fallback: number): number {
	const raw = typeof value === 'string' ? value.trim() : value;
	const parsed = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return Math.floor(parsed);
}

/**
 * Coerce arbitrary input (a URL, a form, an API payload) into a normalized
 * search state. Invalid values collapse to their empty/default form instead of
 * throwing: the backend stays the validation owner, and the frontend must be
 * able to render any URL a user types without crashing.
 */
export function normalizeWorkMemoSearchState(
	raw: WorkMemoSearchStateInput | null
): WorkMemoSearchState {
	const source = raw ?? {};
	const status = typeof source.status === 'string' ? source.status.trim() : '';
	const dateFrom = typeof source.date_from === 'string' ? source.date_from.trim() : '';
	const dateTo = typeof source.date_to === 'string' ? source.date_to.trim() : '';

	return {
		q: typeof source.q === 'string' ? source.q.trim() : '',
		tag: typeof source.tag === 'string' ? source.tag.trim() : '',
		status: isValidWorkMemoSearchStatus(status) ? status : '',
		date_from: isWorkMemoSearchDate(dateFrom) ? dateFrom : '',
		date_to: isWorkMemoSearchDate(dateTo) ? dateTo : '',
		sort: isValidWorkMemoSearchSort(source.sort) ? source.sort : WORK_MEMO_SEARCH_DEFAULT_SORT,
		page: toPage(source.page)
	};
}

/**
 * Does the state carry at least one real criterion?
 *
 * The backend rejects a criterion-less search with 400, so the page must not
 * call the API in that case — it renders its initial state instead.
 */
export function hasWorkMemoSearchCriteria(state: WorkMemoSearchState): boolean {
	return Boolean(state.q || state.tag || state.status || state.date_from || state.date_to);
}

/**
 * The date range is only usable when both bounds are absent, or both are valid
 * `YYYY-MM-DD` and ordered. An inverted range is a frontend-side hint; the
 * backend validates it again.
 */
export function isWorkMemoSearchDateRangeValid(state: {
	date_from: string;
	date_to: string;
}): boolean {
	if (!state.date_from || !state.date_to) return true;
	if (!isWorkMemoSearchDate(state.date_from) || !isWorkMemoSearchDate(state.date_to)) {
		return false;
	}
	return state.date_from <= state.date_to;
}

/**
 * Serialize the API request query string.
 *
 * Empty filters are omitted entirely (a present-but-empty parameter is not the
 * same request as an absent one to the backend). `sort`, `page` and `page_size`
 * are always explicit so the request is self-describing. The result carries no
 * leading `?`.
 */
export function buildWorkMemoSearchQueryString(state: WorkMemoSearchState): string {
	const params = new URLSearchParams();
	if (state.q) params.set('q', state.q);
	if (state.tag) params.set('tag', state.tag);
	if (state.status) params.set('status', state.status);
	if (state.date_from) params.set('date_from', state.date_from);
	if (state.date_to) params.set('date_to', state.date_to);
	params.set('sort', state.sort);
	params.set('page', String(state.page));
	params.set('page_size', String(WORK_MEMO_SEARCH_PAGE_SIZE));
	return params.toString();
}

/**
 * Parse the URL query into normalized search state. This is the single reader
 * of the URL, so the URL stays the source of truth for the whole page.
 */
export function parseWorkMemoSearchState(source: URLSearchParams | string): WorkMemoSearchState {
	const params =
		typeof source === 'string' ? new URLSearchParams(source.replace(/^\?/, '')) : source;

	return normalizeWorkMemoSearchState({
		q: params.get('q') ?? '',
		tag: params.get('tag') ?? '',
		status: params.get('status') ?? '',
		date_from: params.get('date_from') ?? '',
		date_to: params.get('date_to') ?? '',
		sort: params.get('sort') ?? '',
		page: params.get('page') ?? ''
	});
}

/**
 * Serialize normalized state into the address-bar URL.
 *
 * Unlike the API query this omits everything that equals the default
 * (`page=1`, `sort=date_desc`, every empty filter) so a shared or bookmarked
 * link stays short while round-tripping to the same state.
 */
export function buildWorkMemoSearchUrl(
	state: WorkMemoSearchState,
	basePath: string = WORK_MEMO_SEARCH_PATH
): string {
	const params = new URLSearchParams();
	if (state.q) params.set('q', state.q);
	if (state.tag) params.set('tag', state.tag);
	if (state.status) params.set('status', state.status);
	if (state.date_from) params.set('date_from', state.date_from);
	if (state.date_to) params.set('date_to', state.date_to);
	if (state.sort !== WORK_MEMO_SEARCH_DEFAULT_SORT) params.set('sort', state.sort);
	if (state.page > 1) params.set('page', String(state.page));

	const query = params.toString();
	return query ? `${basePath}?${query}` : basePath;
}

/** The URL of the existing memo edit route a search result opens. */
export function buildWorkMemoEditPath(item: { id: string; date: string }): string {
	return `/worklog/${encodeURIComponent(item.date)}/${encodeURIComponent(item.id)}`;
}

export function emptyWorkMemoSearchDraft(): WorkMemoSearchDraft {
	return {
		q: '',
		tag: '',
		status: '',
		date_from: '',
		date_to: '',
		sort: WORK_MEMO_SEARCH_DEFAULT_SORT
	};
}

/** Seed the editable form from committed (URL-backed) state. */
export function draftFromWorkMemoSearchState(state: WorkMemoSearchState): WorkMemoSearchDraft {
	return {
		q: state.q,
		tag: state.tag,
		status: state.status,
		date_from: state.date_from,
		date_to: state.date_to,
		sort: state.sort
	};
}

/**
 * Turn the submitted form into search state. The page is always reset to 1: a
 * new query or new filter must not land the user on page 4 of a different
 * result set.
 */
export function searchStateFromWorkMemoSearchDraft(
	draft: WorkMemoSearchDraft,
	page: number = 1
): WorkMemoSearchState {
	return normalizeWorkMemoSearchState({ ...draft, page });
}

/**
 * Normalize the tag list of one search hit: keep only strings, drop duplicates,
 * keep the original first-seen order.
 *
 * The backend may legitimately return the same tag twice, and the result card
 * renders the list with a keyed `{#each item.tags as tag (tag)}` where a
 * duplicate is a duplicate key. Deduplicating here - at the response
 * normalization boundary - fixes the data once for every consumer instead of
 * masking it in the UI with an index-based key. The backend tag model itself is
 * not changed.
 */
export function normalizeWorkMemoSearchTags(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const tags: string[] = [];
	const seen = new Set<string>();
	for (const tag of raw) {
		if (typeof tag !== 'string') continue;
		if (seen.has(tag)) continue;
		seen.add(tag);
		tags.push(tag);
	}
	return tags;
}

/** Coerce one untrusted item payload, or `null` when it cannot be opened. */
export function normalizeWorkMemoSearchItem(raw: unknown): WorkMemoSearchItem | null {
	if (!raw || typeof raw !== 'object') return null;
	const data = raw as Record<string, unknown>;
	// Without an id the result cannot be opened in the editor, and rendering it
	// would only produce a dead card.
	const id = typeof data.id === 'string' ? data.id : '';
	if (!id) return null;

	return {
		id,
		date: typeof data.date === 'string' ? data.date : '',
		snippet: typeof data.snippet === 'string' ? data.snippet : '',
		status: isValidWorkMemoSearchStatus(data.status) ? data.status : 'normal',
		is_pinned: Boolean(data.is_pinned),
		tags: normalizeWorkMemoSearchTags(data.tags),
		position: typeof data.position === 'number' ? data.position : 0
	};
}

/**
 * Coerce the search response envelope. `total` / `total_pages` fall back to a
 * self-consistent derivation when the backend omits or garbles them, so the
 * pagination controls never divide by zero or offer a page that cannot exist.
 */
export function normalizeWorkMemoSearchResponse(raw: unknown): WorkMemoSearchResponse {
	const container = (raw ?? {}) as Record<string, unknown>;
	const rawItems = Array.isArray(container.items) ? container.items : [];
	const items: WorkMemoSearchItem[] = [];
	for (const entry of rawItems) {
		const item = normalizeWorkMemoSearchItem(entry);
		if (item) items.push(item);
	}

	const page = toPage(container.page);
	const pageSize = Math.max(1, toCount(container.page_size, WORK_MEMO_SEARCH_PAGE_SIZE));
	const total = toCount(container.total, items.length);
	const derivedTotalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
	const totalPages = toCount(container.total_pages, derivedTotalPages);

	return { items, page, page_size: pageSize, total, total_pages: totalPages };
}

function requireOk(response: HttpClientResponse, apiError: ApiErrorFactory): void {
	if (response.ok) return;
	if (response.status === 401) throw apiError(401, 'Unauthorized');
	if (response.status >= 400 && response.status < 500) {
		// 400 keeps its own status so the page can distinguish "your filters are
		// wrong" from a transient server failure. Validation errors are never
		// swallowed: they are surfaced to the user.
		throw apiError(response.status, `Validation error: HTTP ${response.status}`);
	}
	throw apiError(response.status, `Server error: HTTP ${response.status}`);
}

export interface WorkMemoSearchRequestOptions {
	fetchFn: HttpClient;
	apiError: ApiErrorFactory;
	/** Auth token; the client never invents or caches its own. */
	token: string;
	state: WorkMemoSearchState;
	signal?: AbortSignal;
}

/**
 * GET /api/v1/work-memos/search with the state's filters.
 *
 * Read-only: no caching, no retry, no result mutation. A non-2xx response
 * rejects with the injected error type carrying the HTTP status; an aborted
 * request rejects with the transport's `AbortError`.
 *
 * A state the backend would reject with 400 (no criterion at all, or an
 * inverted date range) is rejected here too, *without* issuing a request: the
 * page must never turn its initial state into a "list everything" call.
 */
export async function searchWorkMemosRequest(
	options: WorkMemoSearchRequestOptions
): Promise<WorkMemoSearchResponse> {
	const { fetchFn, apiError, token, state, signal } = options;

	if (!hasWorkMemoSearchCriteria(state)) {
		throw apiError(400, 'Validation error: HTTP 400');
	}
	if (!isWorkMemoSearchDateRangeValid(state)) {
		throw apiError(400, 'Validation error: HTTP 400');
	}

	const query = buildWorkMemoSearchQueryString(state);

	const response = await fetchFn(`/api/v1/work-memos/search?${query}`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` },
		signal
	});

	requireOk(response, apiError);
	return normalizeWorkMemoSearchResponse(await response.json());
}

export interface StaleSearchGuard {
	/** Start a request and receive its generation token. */
	next(): number;
	/** True only for the most recently started request. */
	isLatest(token: number): boolean;
	/**
	 * Abandon the current generation *without* starting a replacement request.
	 *
	 * `next()` also stales the previous token, but only in the "a newer request
	 * is taking over" case. Several transitions give up on an active search
	 * without issuing any replacement - the criteria go away, the date range
	 * becomes invalid, Clear is pressed, the component is torn down - and those
	 * must not rely on the `AbortController` landing in time.
	 */
	invalidate(): void;
}

/**
 * Generation-token guard against stale responses overwriting newer results.
 *
 * With `q=钢` (request A) and `q=钢平台` (request B), B can come back first; A's
 * response must then be discarded. The page pairs this guard with an
 * `AbortController` - the abort avoids wasted work, the token makes correctness
 * independent of whether the abort actually lands in time.
 *
 * The two invalidation paths are complementary and both are needed:
 *   - `next()` - a newer request replaced the active one;
 *   - `invalidate()` - the active search was cancelled outright, and no later
 *     request will exist to supersede it.
 * Together they guarantee that an abandoned request can never write its
 * response, its error or its loading state, whenever and however it settles.
 */
export function createStaleSearchGuard(): StaleSearchGuard {
	let current = 0;
	return {
		next(): number {
			current += 1;
			return current;
		},
		isLatest(token: number): boolean {
			return token === current;
		},
		invalidate(): void {
			// Advancing the generation is all it takes: every token handed out
			// so far becomes stale at once. No replacement token is issued, so
			// no in-flight response can claim to be the current one.
			current += 1;
		}
	};
}

export function canGoToPreviousPage(page: number): boolean {
	return Number.isFinite(page) && page > 1;
}

/**
 * A page beyond the last one is not navigable forward. `total_pages === 0`
 * (no results at all) is also not navigable.
 */
export function canGoToNextPage(page: number, totalPages: number): boolean {
	return Number.isFinite(page) && Number.isFinite(totalPages) && totalPages > 0 && page < totalPages;
}
