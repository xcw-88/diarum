import { pb } from './client';
import { WorkMemoApiError } from './workMemos';
import {
	searchWorkMemosRequest,
	type WorkMemoSearchResponse,
	type WorkMemoSearchState
} from './workMemoSearchCore';

export type {
	WorkMemoSearchDraft,
	WorkMemoSearchItem,
	WorkMemoSearchResponse,
	WorkMemoSearchSort,
	WorkMemoSearchState,
	WorkMemoSearchStatus
} from './workMemoSearchCore';

/**
 * The URL-state model is pure logic and is re-exported so the search page has a
 * single import site for everything it needs (the request client plus the state
 * helpers), mirroring how `workMemoMedia.ts` re-exports its association core.
 */
export {
	WORK_MEMO_SEARCH_PATH,
	WORK_MEMO_SEARCH_PAGE_SIZE,
	buildWorkMemoEditPath,
	buildWorkMemoSearchQueryString,
	buildWorkMemoSearchUrl,
	canGoToNextPage,
	canGoToPreviousPage,
	createStaleSearchGuard,
	draftFromWorkMemoSearchState,
	emptyWorkMemoSearchDraft,
	hasWorkMemoSearchCriteria,
	isWorkMemoSearchDateRangeValid,
	normalizeWorkMemoSearchResponse,
	normalizeWorkMemoSearchState,
	parseWorkMemoSearchState,
	searchStateFromWorkMemoSearchDraft
} from './workMemoSearchCore';

/**
 * Binds the pure search core to the project's real transport, auth store and
 * error type. Nothing here invents a filter, caches a response, or retries.
 *
 * GET /api/v1/work-memos/search
 *
 * The endpoint is the one committed in Worklog Search V1 — Task 1. It returns
 * `{ items, page, page_size, total, total_pages }` where each item is
 * `{ id, date, snippet, status, is_pinned, tags, position }`; there is no
 * `content`, no `owner` and no `search_text` to read.
 *
 * Non-2xx responses reject with a `WorkMemoApiError` carrying the HTTP status
 * (a 400 is a real validation error and is never swallowed). Network failures
 * reject with the underlying error. Passing a `signal` aborts the request.
 */
export function searchWorkMemos(
	state: WorkMemoSearchState,
	signal?: AbortSignal
): Promise<WorkMemoSearchResponse> {
	return searchWorkMemosRequest({
		fetchFn: (url, init) => fetch(url, init),
		apiError: (status, message) => new WorkMemoApiError(status, message),
		token: pb.authStore.token,
		state,
		signal
	});
}
