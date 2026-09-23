<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { isAuthenticated } from '$lib/api/client';
	import { WorkMemoApiError } from '$lib/api/workMemos';
	import { searchWorkMemos } from '$lib/api/workMemoSearch';
	import {
		WORK_MEMO_SEARCH_DEFAULT_SORT,
		WORK_MEMO_SEARCH_PATH,
		buildWorkMemoEditPath,
		buildWorkMemoSearchUrl,
		canGoToNextPage,
		canGoToPreviousPage,
		createStaleSearchGuard,
		draftFromWorkMemoSearchState,
		emptyWorkMemoSearchDraft,
		hasWorkMemoSearchCriteria,
		isWorkMemoSearchDateRangeValid,
		parseWorkMemoSearchState,
		searchStateFromWorkMemoSearchDraft,
		type WorkMemoSearchDraft,
		type WorkMemoSearchItem,
		type WorkMemoSearchResponse,
		type WorkMemoSearchState
	} from '$lib/api/workMemoSearch';
	import WorkMemoSearchResultCard from '$lib/components/worklog/WorkMemoSearchResultCard.svelte';

	// ---------------------------------------------------------------------------
	// URL is the source of truth. The committed search lives in `?q&tag&status&
	// date_from&date_to&sort&page`; the form below is only a draft of the next
	// search. Reload, Back and Forward therefore all restore the same query and
	// the same result set without a second, page-local source of truth.
	// ---------------------------------------------------------------------------
	let searchState = $derived(parseWorkMemoSearchState($page.url.searchParams));
	/** Canonical full URL of the committed state (page included). */
	let stateKey = $derived(buildWorkMemoSearchUrl(searchState));
	/** Canonical URL of the committed *criteria* only (page forced to 1). */
	let criteriaKey = $derived(buildWorkMemoSearchUrl({ ...searchState, page: 1 }));
	let currentUrl = $derived(`${$page.url.pathname}${$page.url.search}`);
	let criteriaPresent = $derived(hasWorkMemoSearchCriteria(searchState));
	let rangeValid = $derived(isWorkMemoSearchDateRangeValid(searchState));

	let response = $state<WorkMemoSearchResponse | null>(null);
	/** Mirrors of the response envelope used by the pagination controls. */
	let resultPage = $derived(response?.page ?? 1);
	let totalPages = $derived(response?.total_pages ?? 0);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let mounted = $state(false);

	let draft = $state<WorkMemoSearchDraft>(emptyWorkMemoSearchDraft());
	let pendingState = $derived(searchStateFromWorkMemoSearchDraft(draft, 1));
	let canSubmit = $derived(
		hasWorkMemoSearchCriteria(pendingState) && isWorkMemoSearchDateRangeValid(pendingState)
	);

	/** The sort is only worth restating in the summary when it is not the default. */
	let nonDefaultSort = $derived(searchState.sort !== WORK_MEMO_SEARCH_DEFAULT_SORT);

	/**
	 * Localized labels for the committed-filter summary.
	 *
	 * The summary describes the *committed* search (the URL), never the draft, so
	 * an edited-but-unsubmitted form can never misrepresent what is on screen.
	 */
	function statusText(status: string): string {
		if (status === 'pending') return $t('worklog.statusPending');
		if (status === 'completed') return $t('worklog.statusCompleted');
		return $t('worklog.statusNormal');
	}

	function sortText(sort: string): string {
		return sort === 'date_asc' ? $t('worklogSearch.sortDateAsc') : $t('worklogSearch.sortDateDesc');
	}

	// Abort avoids wasted work; the generation token makes correctness
	// independent of whether the abort lands before the response is handled.
	const staleGuard = createStaleSearchGuard();
	let abortController: AbortController | null = null;
	let lastLoadedKey: string | null = null;
	let lastSyncedCriteriaKey: string | null = null;

	/**
	 * Abandon the active request *without* starting a replacement request.
	 *
	 * The abort is a best-effort optimization only: a transport may ignore the
	 * signal, or may already hold a response when it arrives. Correctness comes
	 * from `invalidate()`, which stales the abandoned request's token so that
	 * nothing it settles with - result, error or loading state - can be written.
	 *
	 * Ordering rule: call this *before* `staleGuard.next()`, never after it, or
	 * the token that was just issued would be invalidated too.
	 */
	function cancelActiveSearch() {
		abortController?.abort();
		abortController = null;
		staleGuard.invalidate();
	}

	async function load(target: WorkMemoSearchState) {
		// The backend answers 400 for a criterion-less search and for an inverted
		// date range, so neither is ever sent. The page simply stays on its
		// initial state instead - and whatever was still running is cancelled
		// outright, with no replacement request to supersede it.
		if (!hasWorkMemoSearchCriteria(target) || !isWorkMemoSearchDateRangeValid(target)) {
			cancelActiveSearch();
			response = null;
			error = null;
			loading = false;
			return;
		}

		// A replacement request: cancel (and thereby invalidate) the active one
		// first, then open the new generation.
		cancelActiveSearch();
		const controller = new AbortController();
		abortController = controller;
		const token = staleGuard.next();

		loading = true;
		error = null;

		try {
			const result = await searchWorkMemos(target, controller.signal);
			// A stale response must never overwrite the newest result set.
			if (!staleGuard.isLatest(token)) return;
			response = result;
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			if (!staleGuard.isLatest(token)) return;
			if (err instanceof WorkMemoApiError && err.status === 401) {
				goto('/login');
				return;
			}
			console.error('Failed to search work memos:', err);
			response = null;
			// A 400 is a real validation error and is reported as such rather
			// than being folded into a generic failure.
			error =
				err instanceof WorkMemoApiError && err.status === 400
					? $t('worklogSearch.invalidRequest')
					: $t('worklogSearch.loadFailed');
		} finally {
			if (staleGuard.isLatest(token)) {
				loading = false;
				if (abortController === controller) abortController = null;
			}
		}
	}

	/**
	 * Submit the draft: a new search always starts at page 1.
	 *
	 * `canSubmit` already guarantees at least one real criterion and a usable
	 * date range, so an invalid search can never reach the backend from here.
	 */
	function submitSearch() {
		if (!canSubmit) return;
		const next = pendingState;

		if (buildWorkMemoSearchUrl(next) === currentUrl) {
			// Same criteria (e.g. pressing Search again to retry): the URL will
			// not change, so reload explicitly instead of waiting for a
			// navigation that never happens.
			lastLoadedKey = stateKey;
			void load(next);
			return;
		}

		void goto(buildWorkMemoSearchUrl(next), { keepFocus: true });
	}

	function clearSearch() {
		draft = emptyWorkMemoSearchDraft();
		// Clear abandons the active search immediately, whether or not a
		// navigation follows: the results on screen belong to a query the user
		// has just discarded, and a late response must not restore them.
		cancelActiveSearch();
		if (currentUrl === WORK_MEMO_SEARCH_PATH) {
			// Already at the bare search URL: no navigation happens, so no
			// replacement request is ever issued for this cancellation.
			response = null;
			error = null;
			loading = false;
			return;
		}
		void goto(WORK_MEMO_SEARCH_PATH, { keepFocus: true });
	}

	function goToPage(target: number) {
		if (target === searchState.page) return;
		// Pagination applies to the committed result set, so it uses the state
		// from the URL rather than the (possibly edited) draft.
		void goto(buildWorkMemoSearchUrl({ ...searchState, page: target }), { keepFocus: true });
	}

	function openResult(item: WorkMemoSearchItem) {
		void goto(buildWorkMemoEditPath(item));
	}

	onMount(() => {
		if (!$isAuthenticated) {
			goto('/login');
			return;
		}
		mounted = true;
		return () => {
			// Teardown abandons the active search for good: there will never be
			// a replacement request, so the generation must be invalidated or a
			// late response could still write into the destroyed component.
			cancelActiveSearch();
		};
	});

	// Seed the form from the committed criteria whenever they change - this is
	// what makes Back / Forward restore the visible search. A page-only change
	// keeps the draft untouched, so half-typed input is not thrown away while
	// paginating.
	$effect(() => {
		const key = criteriaKey;
		if (!mounted) return;
		if (key === lastSyncedCriteriaKey) return;
		lastSyncedCriteriaKey = key;
		draft = draftFromWorkMemoSearchState(searchState);
	});

	// The committed state drives the request, so every URL change (including
	// Back / Forward and pagination) re-runs the search for that exact query.
	$effect(() => {
		const key = stateKey;
		if (!mounted) return;

		if (!criteriaPresent || !rangeValid) {
			lastLoadedKey = key;
			void load(searchState);
			return;
		}

		if (key === lastLoadedKey) return;
		lastLoadedKey = key;
		void load(searchState);
	});
</script>

<svelte:head>
	<title>{$t('worklogSearch.pageTitle')} - {$t('worklog.pageTitle')}</title>
</svelte:head>

<div class="min-h-screen bg-background">
	<header class="sticky top-0 z-20 border-b border-border/50 glass">
		<div class="relative mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
			<a
				href="/worklog"
				class="flex items-center gap-2 text-sm font-medium text-foreground transition-colors hover:text-primary"
				aria-label={$t('worklog.backToCalendar')}
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
				</svg>
				<span class="hidden sm:inline">{$t('worklog.calendar')}</span>
			</a>
			<h1 class="pointer-events-none absolute left-1/2 -translate-x-1/2 text-base font-semibold text-foreground">
				{$t('worklogSearch.pageTitle')}
			</h1>
			<div class="w-9 sm:w-16" aria-hidden="true"></div>
		</div>
	</header>

	<main class="mx-auto max-w-3xl px-3 py-4 sm:px-4 sm:py-6">
		<h2 class="text-lg font-semibold text-foreground sm:text-xl">{$t('worklogSearch.heading')}</h2>
		<p class="mt-1 text-sm text-muted-foreground">{$t('worklogSearch.subtitle')}</p>

		<form class="mt-4" onsubmit={(event) => { event.preventDefault(); submitSearch(); }}>
			<label class="block text-xs font-medium text-muted-foreground" for="worklog-search-q">
				{$t('worklogSearch.queryLabel')}
			</label>
			<div class="mt-1.5">
				<input
					id="worklog-search-q"
					type="search"
					bind:value={draft.q}
					placeholder={$t('worklogSearch.placeholder')}
					autocomplete="off"
					class="w-full rounded-xl border border-border/60 bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring/50"
				/>
			</div>

			<fieldset class="mt-4 rounded-2xl border border-border/60 bg-card p-3 sm:p-4">
				<legend class="px-1 text-xs font-medium text-muted-foreground">
					{$t('worklogSearch.filters')}
				</legend>

				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<div>
						<label class="block text-xs font-medium text-muted-foreground" for="worklog-search-from">
							{$t('worklogSearch.dateFrom')}
						</label>
						<input
							id="worklog-search-from"
							type="date"
							bind:value={draft.date_from}
							class="mt-1.5 w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring/50"
						/>
					</div>
					<div>
						<label class="block text-xs font-medium text-muted-foreground" for="worklog-search-to">
							{$t('worklogSearch.dateTo')}
						</label>
						<input
							id="worklog-search-to"
							type="date"
							bind:value={draft.date_to}
							class="mt-1.5 w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring/50"
						/>
					</div>
					<div>
						<label class="block text-xs font-medium text-muted-foreground" for="worklog-search-tag">
							{$t('worklogSearch.tag')}
						</label>
						<input
							id="worklog-search-tag"
							type="text"
							bind:value={draft.tag}
							placeholder={$t('worklogSearch.tagPlaceholder')}
							autocomplete="off"
							class="mt-1.5 w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring/50"
						/>
					</div>
					<div>
						<label class="block text-xs font-medium text-muted-foreground" for="worklog-search-status">
							{$t('worklogSearch.status')}
						</label>
						<select
							id="worklog-search-status"
							bind:value={draft.status}
							class="mt-1.5 w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring/50"
						>
							<option value="">{$t('worklogSearch.statusAny')}</option>
							<option value="normal">{$t('worklog.statusNormal')}</option>
							<option value="pending">{$t('worklog.statusPending')}</option>
							<option value="completed">{$t('worklog.statusCompleted')}</option>
						</select>
					</div>
					<div class="sm:col-span-2">
						<label class="block text-xs font-medium text-muted-foreground" for="worklog-search-sort">
							{$t('worklogSearch.sort')}
						</label>
						<select
							id="worklog-search-sort"
							bind:value={draft.sort}
							class="mt-1.5 w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring/50"
						>
							<option value="date_desc">{$t('worklogSearch.sortDateDesc')}</option>
							<option value="date_asc">{$t('worklogSearch.sortDateAsc')}</option>
						</select>
					</div>
				</div>

				{#if !isWorkMemoSearchDateRangeValid(pendingState)}
					<p class="mt-3 text-xs text-destructive" role="alert">{$t('worklogSearch.invalidRange')}</p>
				{/if}

				<div class="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
					<button
						type="button"
						class="rounded-xl border border-border/60 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:py-2"
						onclick={clearSearch}
					>
						{$t('worklogSearch.clear')}
					</button>
					<button
						type="submit"
						disabled={!canSubmit}
						class="rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 sm:py-2"
					>
						{$t('worklogSearch.search')}
					</button>
				</div>
			</fieldset>
		</form>

		<section class="mt-6">
			<!--
				What the committed URL is actually searching for. Rendered from the
				URL-backed state - never from the form draft - so the results below
				can never be misread as belonging to a half-edited form.
			-->
			{#if criteriaPresent}
				<div class="mb-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
					<p class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<span class="font-medium text-foreground">{$t('worklogSearch.activeFilters')}</span>
						{#if searchState.q}
							<span class="min-w-0 break-words">{$t('worklogSearch.activeQuery', { value: searchState.q })}</span>
						{/if}
						{#if searchState.tag}
							<span class="min-w-0 break-words">{$t('worklogSearch.activeTag', { value: searchState.tag })}</span>
						{/if}
						{#if searchState.status}
							<span class="min-w-0 break-words">{$t('worklogSearch.activeStatus', { value: statusText(searchState.status) })}</span>
						{/if}
						{#if searchState.date_from}
							<span class="min-w-0 break-words">{$t('worklogSearch.activeDateFrom', { value: searchState.date_from })}</span>
						{/if}
						{#if searchState.date_to}
							<span class="min-w-0 break-words">{$t('worklogSearch.activeDateTo', { value: searchState.date_to })}</span>
						{/if}
						{#if nonDefaultSort}
							<span class="min-w-0 break-words">{$t('worklogSearch.activeSort', { value: sortText(searchState.sort) })}</span>
						{/if}
					</p>
				</div>
			{/if}

			{#if loading}
				<div class="flex flex-col items-center justify-center gap-3 py-12">
					<span class="h-6 w-6 animate-spin rounded-full border-2 border-primary/25 border-t-primary"></span>
					<div class="text-sm text-muted-foreground">{$t('worklogSearch.searching')}</div>
				</div>
			{:else if error}
				<div class="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-center">
					<p class="text-sm text-destructive">{error}</p>
					{#if criteriaPresent && rangeValid}
						<button
							type="button"
							class="mt-2 text-sm font-medium text-primary hover:underline"
							onclick={() => void load(searchState)}
						>
							{$t('common.retry')}
						</button>
					{/if}
				</div>
			{:else if !criteriaPresent}
				<div class="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/60 px-4 py-12 text-center">
					<div class="flex h-16 w-16 items-center justify-center rounded-full bg-muted/50">
						<svg class="h-8 w-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
						</svg>
					</div>
					<div>
						<p class="text-sm font-medium text-foreground">{$t('worklogSearch.initialTitle')}</p>
						<p class="mt-1 text-xs text-muted-foreground">{$t('worklogSearch.initialHint')}</p>
					</div>
				</div>
			{:else if response}
				<div class="mb-3 text-sm text-muted-foreground" aria-live="polite">
					{#if response.total === 1}
						{$t('worklogSearch.resultsCountOne', { count: response.total })}
					{:else}
						{$t('worklogSearch.resultsCount', { count: response.total })}
					{/if}
				</div>

				{#if response.items.length === 0}
					<div class="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/60 px-4 py-12 text-center">
						<div class="flex h-16 w-16 items-center justify-center rounded-full bg-muted/50">
							<svg class="h-8 w-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
							</svg>
						</div>
						<div>
							<p class="text-sm font-medium text-foreground">{$t('worklogSearch.emptyTitle')}</p>
							<p class="mt-1 text-xs text-muted-foreground">{$t('worklogSearch.emptyHint')}</p>
						</div>
					</div>
				{:else}
					<div class="space-y-3">
						{#each response.items as item (item.id)}
							<WorkMemoSearchResultCard {item} onOpen={openResult} />
						{/each}
					</div>
				{/if}

				{#if totalPages > 1}
					<nav class="mt-6 flex items-center justify-between gap-3" aria-label={$t('worklogSearch.paginationLabel')}>
						<button
							type="button"
							disabled={!canGoToPreviousPage(resultPage)}
							onclick={() => goToPage(resultPage - 1)}
							class="rounded-xl border border-border/60 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
						>
							{$t('worklogSearch.previous')}
						</button>
						<span class="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
							{$t('worklogSearch.pageOf', { page: resultPage, total: totalPages })}
						</span>
						<button
							type="button"
							disabled={!canGoToNextPage(resultPage, totalPages)}
							onclick={() => goToPage(resultPage + 1)}
							class="rounded-xl border border-border/60 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
						>
							{$t('worklogSearch.next')}
						</button>
					</nav>
				{/if}
			{/if}
		</section>
	</main>
</div>
