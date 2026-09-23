// @ts-nocheck
/**
 * Unit tests for the Worklog search client core (Worklog Search V1 — Task 2).
 *
 * These exercise the real URL-state model, query serialization, response
 * normalization, error propagation and stale-response guard via an injected
 * `fetch`, so no server or bundler is required
 * (`node --experimental-transform-types --test`).
 *
 * The Svelte page itself has no component-level test infrastructure in this
 * project (and none is introduced here); the page wiring is verified by
 * `npm run check` + `npm run build` plus source review.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
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
	normalizeWorkMemoSearchTags,
	parseWorkMemoSearchState,
	searchStateFromWorkMemoSearchDraft,
	searchWorkMemosRequest
} from './workMemoSearchCore.ts';

class FakeApiError extends Error {
	status: number;
	constructor(status, message) {
		super(message);
		this.status = status;
		this.name = 'FakeApiError';
	}
}

const apiError = (status, message) => new FakeApiError(status, message);

function makeFetch(status, body = {}) {
	const calls = [];
	const fetchFn = async (url, init) => {
		calls.push({ url, init });
		return {
			status,
			ok: status >= 200 && status < 300,
			json: async () => body
		};
	};
	return { fetchFn, calls };
}

function baseState(overrides = {}) {
	return { ...emptyWorkMemoSearchDraft(), page: 1, ...overrides };
}

/**
 * A fetch whose responses are resolved by the test, and which deliberately
 * ignores the abort signal. That is precisely the case the generation guard
 * must survive: correctness may not depend on the abort landing in time.
 */
function makeDeferredFetch() {
	const pending = [];
	const fetchFn = (url, init) => {
		const entry = { url, init };
		entry.promise = new Promise((resolve) => {
			entry.resolve = resolve;
		});
		pending.push(entry);
		return entry.promise;
	};
	return { fetchFn, pending };
}

function okResponse(body) {
	return { status: 200, ok: true, json: async () => body };
}

/**
 * Minimal model of the search page's request wiring
 * (`src/routes/worklog/search/+page.svelte`):
 *
 *   cancel()  -> abort + invalidate          (``cancelActiveSearch``)
 *   load(s)   -> cancel(), then next(), then apply *only* if `isLatest(token)`
 *
 * This project has no Svelte component test harness, so the page's
 * cancellation semantics are pinned down here. The `.svelte` file remains the
 * authority; this model must be kept in sync with it.
 */
function createSearchHarness(fetchFn) {
	const guard = createStaleSearchGuard();
	let abortController = null;
	const view = { response: null, error: null, loading: false };

	function cancel() {
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
		guard.invalidate();
	}

	/**
	 * Mirrors the cancellation sites that drop the result set as well (Clear
	 * with no navigation, teardown): `cancelActiveSearch()` owns the request
	 * lifecycle only, so each site clears the view itself.
	 */
	function cancelAndReset() {
		cancel();
		view.response = null;
		view.error = null;
		view.loading = false;
	}

	async function load(target) {
		// No request is started for this state, so the active one is cancelled
		// with no replacement request to supersede it.
		if (!hasWorkMemoSearchCriteria(target) || !isWorkMemoSearchDateRangeValid(target)) {
			cancel();
			view.response = null;
			view.error = null;
			view.loading = false;
			return;
		}

		// Replacement: cancel (and invalidate) first, then open a new generation.
		cancel();
		const controller = new AbortController();
		abortController = controller;
		const token = guard.next();

		view.loading = true;
		view.error = null;

		try {
			const result = await searchWorkMemosRequest({
				fetchFn,
				apiError,
				token: 't',
				state: target,
				signal: controller.signal
			});
			if (!guard.isLatest(token)) return;
			view.response = result;
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			if (!guard.isLatest(token)) return;
			view.response = null;
			view.error = err.status === 400 ? 'invalidRequest' : 'loadFailed';
		} finally {
			if (guard.isLatest(token)) {
				view.loading = false;
				if (abortController === controller) abortController = null;
			}
		}
	}

	return { view, load, cancel, cancelAndReset };
}

describe('buildWorkMemoSearchQueryString — params to query string', () => {
	it('serializes every real filter plus explicit sort/page/page_size', () => {
		const query = buildWorkMemoSearchQueryString(
			baseState({
				q: '钢平台',
				tag: '五循',
				status: 'pending',
				date_from: '2026-09-01',
				date_to: '2026-09-30',
				sort: 'date_asc',
				page: 3
			})
		);
		const params = new URLSearchParams(query);

		assert.equal(params.get('q'), '钢平台');
		assert.equal(params.get('tag'), '五循');
		assert.equal(params.get('status'), 'pending');
		assert.equal(params.get('date_from'), '2026-09-01');
		assert.equal(params.get('date_to'), '2026-09-30');
		assert.equal(params.get('sort'), 'date_asc');
		assert.equal(params.get('page'), '3');
		assert.equal(params.get('page_size'), String(WORK_MEMO_SEARCH_PAGE_SIZE));
	});

	it('omits empty filters instead of sending empty parameters', () => {
		const query = buildWorkMemoSearchQueryString(baseState({ q: '管道' }));
		const params = new URLSearchParams(query);

		assert.equal(params.has('q'), true);
		assert.equal(params.has('tag'), false);
		assert.equal(params.has('status'), false);
		assert.equal(params.has('date_from'), false);
		assert.equal(params.has('date_to'), false);
		assert.equal(query.includes('undefined'), false);
		assert.equal(query.includes('null'), false);
	});

	it('keeps multi-term Chinese queries intact and URL-encodes them', () => {
		const query = buildWorkMemoSearchQueryString(baseState({ q: '五循 钢平台' }));
		assert.equal(new URLSearchParams(query).get('q'), '五循 钢平台');
		assert.equal(query.startsWith('q='), true);
	});
});

describe('query string — page and sort serialization', () => {
	it('serializes page 1 explicitly for the API request', () => {
		assert.equal(new URLSearchParams(buildWorkMemoSearchQueryString(baseState())).get('page'), '1');
	});

	it('serializes the two supported sort values', () => {
		assert.equal(
			new URLSearchParams(buildWorkMemoSearchQueryString(baseState({ sort: 'date_desc' }))).get('sort'),
			'date_desc'
		);
		assert.equal(
			new URLSearchParams(buildWorkMemoSearchQueryString(baseState({ sort: 'date_asc' }))).get('sort'),
			'date_asc'
		);
	});
});

describe('parseWorkMemoSearchState — URL to search state', () => {
	it('reads every supported parameter', () => {
		const state = parseWorkMemoSearchState(
			'q=钢平台&tag=五循&status=completed&date_from=2026-09-01&date_to=2026-09-30&sort=date_asc&page=2'
		);

		assert.deepEqual(state, {
			q: '钢平台',
			tag: '五循',
			status: 'completed',
			date_from: '2026-09-01',
			date_to: '2026-09-30',
			sort: 'date_asc',
			page: 2
		});
	});

	it('accepts a leading question mark and a URLSearchParams instance', () => {
		assert.equal(parseWorkMemoSearchState('?q=管道').q, '管道');
		assert.equal(parseWorkMemoSearchState(new URLSearchParams('?q=管道')).q, '管道');
	});

	it('defaults page, sort and every filter when absent', () => {
		assert.deepEqual(parseWorkMemoSearchState(''), {
			q: '',
			tag: '',
			status: '',
			date_from: '',
			date_to: '',
			sort: 'date_desc',
			page: 1
		});
	});

	it('degrades invalid values instead of throwing', () => {
		const state = parseWorkMemoSearchState(
			'q=%20&status=archived&date_from=2026-02-30&date_to=2026-9-1&sort=relevance&page=0'
		);

		assert.equal(state.q, '');
		assert.equal(state.status, '');
		assert.equal(state.date_from, '');
		assert.equal(state.date_to, '');
		assert.equal(state.sort, 'date_desc');
		assert.equal(state.page, 1);
	});

	it('rejects an out-of-range or non-numeric page', () => {
		assert.equal(parseWorkMemoSearchState('page=9999999999').page, 1);
		assert.equal(parseWorkMemoSearchState('page=-3').page, 1);
		assert.equal(parseWorkMemoSearchState('page=abc').page, 1);
		assert.equal(parseWorkMemoSearchState('page=7').page, 7);
	});

	it('detects a criterion-less state', () => {
		assert.equal(hasWorkMemoSearchCriteria(parseWorkMemoSearchState('page=3&sort=date_asc')), false);
		assert.equal(hasWorkMemoSearchCriteria(parseWorkMemoSearchState('q=管道')), true);
		assert.equal(hasWorkMemoSearchCriteria(parseWorkMemoSearchState('tag=五循')), true);
		assert.equal(hasWorkMemoSearchCriteria(parseWorkMemoSearchState('status=pending')), true);
		assert.equal(hasWorkMemoSearchCriteria(parseWorkMemoSearchState('date_from=2026-09-01')), true);
		assert.equal(hasWorkMemoSearchCriteria(parseWorkMemoSearchState('date_to=2026-09-01')), true);
	});
});

describe('buildWorkMemoSearchUrl — search state to URL', () => {
	it('builds a criteria-only URL and omits the defaults', () => {
		assert.equal(buildWorkMemoSearchUrl(baseState({ q: '钢平台' })), '/worklog/search?q=%E9%92%A2%E5%B9%B3%E5%8F%B0');
		assert.equal(buildWorkMemoSearchUrl(baseState({ q: '钢平台', page: 2 })), '/worklog/search?q=%E9%92%A2%E5%B9%B3%E5%8F%B0&page=2');
	});

	it('omits page=1 and sort=date_desc but keeps non-default sort', () => {
		assert.equal(buildWorkMemoSearchUrl(baseState({ q: 'a', page: 1 })).includes('page='), false);
		assert.equal(buildWorkMemoSearchUrl(baseState({ q: 'a' })).includes('sort='), false);
		assert.equal(buildWorkMemoSearchUrl(baseState({ q: 'a', sort: 'date_asc' })).endsWith('&sort=date_asc'), true);
	});

	it('returns the bare path when nothing is set', () => {
		assert.equal(buildWorkMemoSearchUrl(baseState()), '/worklog/search');
	});

	it('round-trips state -> URL -> state', () => {
		const state = baseState({
			q: '钢平台',
			tag: '五循',
			status: 'pending',
			date_from: '2026-09-01',
			date_to: '2026-09-30',
			sort: 'date_asc',
			page: 4
		});
		const url = buildWorkMemoSearchUrl(state);
		assert.deepEqual(parseWorkMemoSearchState(url.slice(url.indexOf('?') + 1)), state);
	});
});

describe('draft handling — new criteria reset the page', () => {
	it('resets the page to 1 when a new search is submitted', () => {
		const state = baseState({ q: '钢', page: 5 });
		const draft = draftFromWorkMemoSearchState(state);
		assert.equal(draft.q, '钢');

		const submitted = searchStateFromWorkMemoSearchDraft(draft);
		assert.equal(submitted.page, 1);
	});

	it('resets the page to 1 when a filter changes but the query does not', () => {
		const draft = { ...emptyWorkMemoSearchDraft(), status: 'completed' };
		assert.equal(searchStateFromWorkMemoSearchDraft(draft).page, 1);
	});

	it('normalizes a draft into a state (trim, validate, default)', () => {
		const state = searchStateFromWorkMemoSearchDraft({
			q: '  管道  ',
			tag: '',
			status: 'nonsense',
			date_from: '2026-13-01',
			date_to: '',
			sort: 'relevance'
		});

		assert.equal(state.q, '管道');
		assert.equal(state.status, '');
		assert.equal(state.date_from, '');
		assert.equal(state.sort, 'date_desc');
		assert.equal(state.page, 1);
	});
});

describe('date range validation', () => {
	it('accepts an open range and a well-ordered range', () => {
		assert.equal(isWorkMemoSearchDateRangeValid({ date_from: '', date_to: '' }), true);
		assert.equal(isWorkMemoSearchDateRangeValid({ date_from: '2026-09-01', date_to: '' }), true);
		assert.equal(
			isWorkMemoSearchDateRangeValid({ date_from: '2026-09-01', date_to: '2026-09-30' }),
			true
		);
		assert.equal(
			isWorkMemoSearchDateRangeValid({ date_from: '2026-09-30', date_to: '2026-09-30' }),
			true
		);
	});

	it('rejects an inverted range', () => {
		assert.equal(
			isWorkMemoSearchDateRangeValid({ date_from: '2026-09-30', date_to: '2026-09-01' }),
			false
		);
	});
});

describe('normalizeWorkMemoSearchResponse — client success', () => {
	it('normalizes a well-formed payload', () => {
		const result = normalizeWorkMemoSearchResponse({
			items: [
				{
					id: 'memo-1',
					date: '2026-09-22',
					snippet: '五循钢平台安装',
					status: 'pending',
					is_pinned: true,
					tags: ['五循', '钢平台'],
					position: 0
				}
			],
			page: 1,
			page_size: 20,
			total: 1,
			total_pages: 1
		});

		assert.equal(result.items.length, 1);
		assert.deepEqual(result.items[0], {
			id: 'memo-1',
			date: '2026-09-22',
			snippet: '五循钢平台安装',
			status: 'pending',
			is_pinned: true,
			tags: ['五循', '钢平台'],
			position: 0
		});
		assert.equal(result.page, 1);
		assert.equal(result.page_size, 20);
		assert.equal(result.total, 1);
		assert.equal(result.total_pages, 1);
	});

	it('never invents content or owner fields', () => {
		const result = normalizeWorkMemoSearchResponse({
			items: [{ id: 'memo-1', content: '<p>secret</p>', owner: 'user-a' }],
			total: 1
		});

		assert.deepEqual(Object.keys(result.items[0]).sort(), [
			'date',
			'id',
			'is_pinned',
			'position',
			'snippet',
			'status',
			'tags'
		]);
		assert.equal('content' in result.items[0], false);
		assert.equal('owner' in result.items[0], false);
	});

	it('drops unusable items and defends against odd payloads', () => {
		const result = normalizeWorkMemoSearchResponse({
			items: [null, 'x', { snippet: 'no id' }, { id: 'ok' }],
			total: 4
		});

		assert.equal(result.items.length, 1);
		assert.equal(result.items[0].id, 'ok');
		// The item has no status/tags: they coerce to safe defaults.
		assert.equal(result.items[0].status, 'normal');
		assert.deepEqual(result.items[0].tags, []);
		assert.equal(result.items[0].is_pinned, false);
	});

	it('filters non-string tags', () => {
		const result = normalizeWorkMemoSearchResponse({
			items: [{ id: 'a', tags: ['ok', 7, null, 'also'] }],
			total: 1
		});
		assert.deepEqual(result.items[0].tags, ['ok', 'also']);
	});

	it('drops a repeated tag, keeping the first-seen order', () => {
		const result = normalizeWorkMemoSearchResponse({
			items: [{ id: 'a', tags: ['a', 'b', 'a'] }],
			total: 1
		});
		// The result card loops over tags with a value-based key, so a duplicate
		// returned by the backend would be a duplicate keyed-each key.
		assert.deepEqual(result.items[0].tags, ['a', 'b']);
	});

	it('filters and deduplicates in one pass', () => {
		const result = normalizeWorkMemoSearchResponse({
			items: [{ id: 'a', tags: ['a', 7, 'a', null, 'b'] }],
			total: 1
		});
		assert.deepEqual(result.items[0].tags, ['a', 'b']);
	});

	it('deduplicates a realistic repeated tag set', () => {
		const result = normalizeWorkMemoSearchResponse({
			items: [{ id: 'a', tags: ['钢平台', '钢平台', '五循', '钢平台'] }],
			total: 1
		});
		assert.deepEqual(result.items[0].tags, ['钢平台', '五循']);
	});

	it('leaves an already-unique tag list unchanged', () => {
		const result = normalizeWorkMemoSearchResponse({
			items: [{ id: 'a', tags: ['alpha', 'beta'] }],
			total: 1
		});
		assert.deepEqual(result.items[0].tags, ['alpha', 'beta']);
	});

	it('normalizes tags defensively at the item boundary', () => {
		assert.deepEqual(normalizeWorkMemoSearchTags(['a', 'a', 'b']), ['a', 'b']);
		assert.deepEqual(normalizeWorkMemoSearchTags(['a', 7, 'a', null, 'b']), ['a', 'b']);
		assert.deepEqual(normalizeWorkMemoSearchTags([7, null]), []);
		assert.deepEqual(normalizeWorkMemoSearchTags('a'), []);
		assert.deepEqual(normalizeWorkMemoSearchTags(undefined), []);
	});

	it('derives total/total_pages when they are missing or unusable', () => {
		const derived = normalizeWorkMemoSearchResponse({
			items: [{ id: 'a' }],
			page: '2',
			page_size: '20'
		});
		assert.equal(derived.page, 2);
		assert.equal(derived.page_size, 20);
		assert.equal(derived.total, 1);
		assert.equal(derived.total_pages, 1);

		const empty = normalizeWorkMemoSearchResponse({ items: [], total: 0, total_pages: 0 });
		assert.equal(empty.total_pages, 0);
		assert.deepEqual(empty.items, []);
	});

	it('tolerates a completely empty payload', () => {
		const result = normalizeWorkMemoSearchResponse(undefined);
		assert.deepEqual(result.items, []);
		assert.equal(result.page, 1);
		assert.equal(result.page_size, WORK_MEMO_SEARCH_PAGE_SIZE);
		assert.equal(result.total, 0);
		assert.equal(result.total_pages, 0);
	});
});

describe('searchWorkMemosRequest — request construction and success', () => {
	it('issues a GET with the bearer token and the serialized filters', async () => {
		const { fetchFn, calls } = makeFetch(200, { items: [], total: 0, total_pages: 0 });
		await searchWorkMemosRequest({
			fetchFn,
			apiError,
			token: 'token-1',
			state: baseState({ q: '钢平台', page: 2 })
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0].init.method, 'GET');
		assert.equal(calls[0].init.headers.Authorization, 'Bearer token-1');
		assert.equal(calls[0].url.startsWith('/api/v1/work-memos/search?'), true);
		assert.equal(new URLSearchParams(calls[0].url.split('?')[1]).get('q'), '钢平台');
		assert.equal(new URLSearchParams(calls[0].url.split('?')[1]).get('page'), '2');
	});

	it('passes the abort signal through to the transport', async () => {
		const { fetchFn, calls } = makeFetch(200, {});
		const controller = new AbortController();
		await searchWorkMemosRequest({
			fetchFn,
			apiError,
			token: 't',
			state: baseState({ q: 'a' }),
			signal: controller.signal
		});
		assert.equal(calls[0].init.signal, controller.signal);
	});

	it('does not send a request when there is no criterion', async () => {
		const { fetchFn, calls } = makeFetch(200, {});
		await assert.rejects(
			() => searchWorkMemosRequest({ fetchFn, apiError, token: 't', state: baseState() }),
			(err) => {
				assert.equal(err.status, 400);
				return true;
			}
		);
		assert.equal(calls.length, 0);
	});

	it('does not send a request when the date range is inverted', async () => {
		const { fetchFn, calls } = makeFetch(200, {});
		await assert.rejects(
			() =>
				searchWorkMemosRequest({
					fetchFn,
					apiError,
					token: 't',
					state: baseState({ date_from: '2026-09-30', date_to: '2026-09-01' })
				}),
			(err) => {
				assert.equal(err.status, 400);
				return true;
			}
		);
		assert.equal(calls.length, 0);
	});
});

describe('searchWorkMemosRequest — backend error propagation', () => {
	it('propagates a 400 validation error with its status', async () => {
		const { fetchFn } = makeFetch(400, { message: 'bad request' });
		await assert.rejects(
			() => searchWorkMemosRequest({ fetchFn, apiError, token: 't', state: baseState({ q: 'a' }) }),
			(err) => {
				assert.equal(err.status, 400);
				assert.equal(err.name, 'FakeApiError');
				return true;
			}
		);
	});

	it('propagates a 401 so the caller can redirect to login', async () => {
		const { fetchFn } = makeFetch(401, {});
		await assert.rejects(
			() => searchWorkMemosRequest({ fetchFn, apiError, token: 't', state: baseState({ q: 'a' }) }),
			(err) => {
				assert.equal(err.status, 401);
				return true;
			}
		);
	});

	it('propagates a 500 as a server error', async () => {
		const { fetchFn } = makeFetch(503, {});
		await assert.rejects(
			() => searchWorkMemosRequest({ fetchFn, apiError, token: 't', state: baseState({ q: 'a' }) }),
			(err) => {
				assert.equal(err.status, 503);
				assert.match(err.message, /Server error/);
				return true;
			}
		);
	});

	it('propagates a transport failure unchanged', async () => {
		const fetchFn = async () => {
			throw new TypeError('Failed to fetch');
		};
		await assert.rejects(
			() => searchWorkMemosRequest({ fetchFn, apiError, token: 't', state: baseState({ q: 'a' }) }),
			(err) => {
				assert.equal(err.name, 'TypeError');
				return true;
			}
		);
	});
});

describe('createStaleSearchGuard — stale response protection', () => {
	it('treats only the newest generation as current', () => {
		const guard = createStaleSearchGuard();
		const first = guard.next();
		assert.equal(guard.isLatest(first), true);
		const second = guard.next();
		assert.equal(guard.isLatest(first), false);
		assert.equal(guard.isLatest(second), true);
	});

	it('keeps the newest result when two requests come back out of order', async () => {
		const guard = createStaleSearchGuard();
		const applied = [];

		const run = async (q, delay) => {
			const token = guard.next();
			await new Promise((resolve) => setTimeout(resolve, delay));
			if (!guard.isLatest(token)) return 'discarded';
			applied.push(q);
			return 'applied';
		};

		// A (q=钢) starts first but resolves last; B (q=钢平台) resolves first.
		const a = run('钢', 25);
		const b = run('钢平台', 1);

		assert.equal(await b, 'applied');
		assert.equal(await a, 'discarded');
		assert.deepEqual(applied, ['钢平台']);
	});
});

describe('createStaleSearchGuard — explicit invalidation', () => {
	it('invalidates the current token without issuing a replacement', () => {
		const guard = createStaleSearchGuard();
		const tokenA = guard.next();
		assert.equal(guard.isLatest(tokenA), true);

		guard.invalidate();

		assert.equal(guard.isLatest(tokenA), false);
	});

	it('stales every previously issued token, repeatedly', () => {
		const guard = createStaleSearchGuard();
		const tokenA = guard.next();
		const tokenB = guard.next();

		guard.invalidate();
		assert.equal(guard.isLatest(tokenA), false);
		assert.equal(guard.isLatest(tokenB), false);

		guard.invalidate();
		assert.equal(guard.isLatest(tokenA), false);
		assert.equal(guard.isLatest(tokenB), false);
	});

	it('never reuses a token after invalidation', () => {
		const guard = createStaleSearchGuard();
		const tokenA = guard.next();

		guard.invalidate();
		const tokenB = guard.next();

		assert.notEqual(tokenA, tokenB);
		assert.equal(guard.isLatest(tokenA), false);
		assert.equal(guard.isLatest(tokenB), true);
	});

	it('does not stale a token issued after the cancellation (ordering rule)', () => {
		// The page must call `cancelActiveSearch()` *before* `staleGuard.next()`:
		// cancelling after opening the new generation would invalidate the
		// replacement's own token and discard a perfectly fresh response.
		const guard = createStaleSearchGuard();
		const tokenA = guard.next();

		guard.invalidate(); // cancel the active request...
		const tokenB = guard.next(); // ...then open the replacement

		assert.equal(guard.isLatest(tokenA), false);
		assert.equal(guard.isLatest(tokenB), true);
	});
});

describe('cancel without replacement — abandoned request cannot write state', () => {
	it('discards a response that arrives after the criteria are cleared', async () => {
		const { fetchFn, pending } = makeDeferredFetch();
		const harness = createSearchHarness(fetchFn);

		// Request A starts.
		const first = harness.load(baseState({ q: '钢' }));
		assert.equal(harness.view.loading, true);
		assert.equal(pending.length, 1);

		// The committed state loses its criteria, so no replacement request is
		// ever issued - the transition cancels A outright.
		await harness.load(baseState());
		assert.equal(harness.view.response, null);
		assert.equal(harness.view.loading, false);

		// A now resolves, and its transport ignored the abort.
		pending[0].resolve(okResponse({ items: [{ id: 'stale' }], total: 1, total_pages: 1 }));
		await first;

		assert.equal(harness.view.response, null);
		assert.equal(harness.view.error, null);
		assert.equal(harness.view.loading, false);
	});

	it('discards an error that arrives after a cancel without replacement', async () => {
		const { fetchFn, pending } = makeDeferredFetch();
		const harness = createSearchHarness(fetchFn);

		const first = harness.load(baseState({ q: '钢' }));

		// Clear with no navigation, or teardown: the same cancellation, no
		// replacement request.
		harness.cancel();
		harness.view.response = null;
		harness.view.error = null;
		harness.view.loading = false;

		pending[0].resolve({ status: 500, ok: false, json: async () => ({}) });
		await first;

		assert.equal(harness.view.response, null);
		assert.equal(harness.view.error, null);
		assert.equal(harness.view.loading, false);
	});

	it('abandons the active request even when the abort is never honoured', async () => {
		const { fetchFn, pending } = makeDeferredFetch();
		const harness = createSearchHarness(fetchFn);

		const inFlight = harness.load(baseState({ q: '钢' }));
		const controllerSignal = pending[0].init.signal;
		assert.equal(controllerSignal.aborted, false);

		harness.cancelAndReset();
		// The real signal is aborted, but the transport below ignores it - the
		// discard must hold regardless of whether the abort is ever honoured.
		assert.equal(controllerSignal.aborted, true);

		pending[0].resolve(okResponse({ items: [{ id: 'stale' }], total: 1, total_pages: 1 }));
		await inFlight;

		assert.equal(harness.view.response, null);
		assert.equal(harness.view.loading, false);
	});
});

describe('replacement request — newest result still wins', () => {
	it('keeps the newest response when the abandoned one resolves later', async () => {
		const { fetchFn, pending } = makeDeferredFetch();
		const harness = createSearchHarness(fetchFn);

		// A (q=钢) starts, then B (q=钢平台) replaces it.
		const a = harness.load(baseState({ q: '钢' }));
		const b = harness.load(baseState({ q: '钢平台' }));
		assert.equal(pending.length, 2);

		// B resolves first, A resolves last.
		pending[1].resolve(okResponse({ items: [{ id: 'b' }], total: 1, total_pages: 1 }));
		await b;
		assert.equal(harness.view.response.items[0].id, 'b');
		assert.equal(harness.view.loading, false);

		pending[0].resolve(okResponse({ items: [{ id: 'a' }], total: 1, total_pages: 1 }));
		await a;

		assert.equal(harness.view.response.items[0].id, 'b');
		assert.equal(harness.view.loading, false);
	});
});

describe('buildWorkMemoEditPath — result navigation', () => {
	it('builds the existing memo edit route', () => {
		assert.equal(buildWorkMemoEditPath({ id: 'memo-1', date: '2026-09-22' }), '/worklog/2026-09-22/memo-1');
	});

	it('encodes both path segments', () => {
		assert.equal(
			buildWorkMemoEditPath({ id: 'a/b?c', date: '2026-09-22' }),
			'/worklog/2026-09-22/a%2Fb%3Fc'
		);
	});
});

describe('pagination bounds', () => {
	it('disables Previous on the first page', () => {
		assert.equal(canGoToPreviousPage(1), false);
		assert.equal(canGoToPreviousPage(2), true);
		assert.equal(canGoToPreviousPage(0), false);
	});

	it('disables Next on the last page and when there are no pages', () => {
		assert.equal(canGoToNextPage(1, 1), false);
		assert.equal(canGoToNextPage(1, 3), true);
		assert.equal(canGoToNextPage(3, 3), false);
		assert.equal(canGoToNextPage(1, 0), false);
	});

	it('stays bounded when the backend serves an empty page beyond the last one', () => {
		// page 5 with only 2 pages: empty items, Previous enabled, Next disabled.
		assert.equal(canGoToPreviousPage(5), true);
		assert.equal(canGoToNextPage(5, 2), false);
		const result = normalizeWorkMemoSearchResponse({
			items: [],
			page: 5,
			page_size: 20,
			total: 21,
			total_pages: 2
		});
		assert.deepEqual(result.items, []);
		assert.equal(result.page, 5);
		assert.equal(result.total_pages, 2);
	});
});

describe('normalizeWorkMemoSearchState', () => {
	it('is stable when applied twice', () => {
		const once = normalizeWorkMemoSearchState({ q: ' a ', page: '2' });
		assert.deepEqual(normalizeWorkMemoSearchState(once), once);
	});

	it('rejects real-looking but impossible dates', () => {
		assert.equal(normalizeWorkMemoSearchState({ date_from: '2026-02-30' }).date_from, '');
		assert.equal(normalizeWorkMemoSearchState({ date_from: '2026-02-28' }).date_from, '2026-02-28');
		assert.equal(normalizeWorkMemoSearchState({ date_to: '26-09-01' }).date_to, '');
	});
});
