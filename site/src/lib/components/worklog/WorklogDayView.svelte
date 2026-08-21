<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { isAuthenticated } from '$lib/api/client';
	import {
		formatDisplayDate,
		formatShortDate,
		getPreviousDay,
		getNextDay,
		getToday,
		isToday,
		isValidDate
	} from '$lib/utils/date';
	import {
		listWorkMemosByDate,
		WorkMemoApiError,
		type WorkMemo
	} from '$lib/api/workMemos';
	import WorkMemoList from './WorkMemoList.svelte';

	let date = $derived($page.params.date ?? getToday());
	let memos = $state<WorkMemo[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let displayDate = $derived(formatDisplayDate(date));
	let shortDate = $derived(formatShortDate(date));
	let canGoNext = $derived(!isToday(date));

	let abortController: AbortController | null = null;
	let requestSequence = 0;

	async function loadMemos(targetDate: string) {
		if (!isValidDate(targetDate)) {
			goto('/worklog', { replaceState: true });
			return;
		}

		// Cancel the previous request and start a new one with a fresh sequence.
		abortController?.abort();
		const controller = new AbortController();
		abortController = controller;
		const seq = ++requestSequence;

		loading = true;
		error = null;

		try {
			const result = await listWorkMemosByDate(targetDate, controller.signal);
			if (seq !== requestSequence) return;
			memos = result.memos;
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') {
				return;
			}
			if (err instanceof WorkMemoApiError && err.status === 401) {
				goto('/login');
				return;
			}
			if (seq !== requestSequence) return;
			console.error('Failed to load work memos:', err);
			error = err instanceof Error ? err.message : 'Failed to load work memos';
			memos = [];
		} finally {
			if (seq === requestSequence) {
				loading = false;
				abortController = null;
			}
		}
	}

	function goToPreviousDay() {
		goto(`/worklog/${getPreviousDay(date)}`);
	}

	function goToNextDay() {
		if (!canGoNext) return;
		goto(`/worklog/${getNextDay(date)}`);
	}

	function goToToday() {
		goto(`/worklog/${getToday()}`);
	}

	function openNewMemo() {
		goto(`/worklog/${date}/new`);
	}

	function openEditMemo(memo: WorkMemo) {
		goto(`/worklog/${date}/${memo.id}`);
	}

	function retryLoad() {
		loadMemos(date);
	}

	let previousDate = '';

	onMount(() => {
		if (!$isAuthenticated) {
			goto('/login');
			return;
		}
	});

	$effect(() => {
		if (date && date !== previousDate && typeof window !== 'undefined') {
			previousDate = date;
			loadMemos(date);
		}
	});
</script>

<svelte:head>
	<title>{displayDate} - {$t('worklog.pageTitle')}</title>
</svelte:head>

<div class="min-h-screen bg-background flex flex-col">
	<!-- Top navigation bar -->
	<header class="sticky top-0 z-30 glass border-b border-border/50">
		<div class="mx-auto max-w-3xl px-4">
			<div class="flex h-14 items-center justify-between gap-3">
				<a href="/" class="hidden sm:flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary transition-colors">
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
					</svg>
					<span>{$t('nav.home')}</span>
				</a>
				<div class="flex flex-1 items-center justify-center gap-1 sm:gap-2">
					<button
						type="button"
						class="p-2 rounded-full hover:bg-muted transition-colors text-muted-foreground"
						onclick={goToPreviousDay}
						aria-label={$t('entryNav.previousDay')}
					>
						<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
						</svg>
					</button>
					<div class="text-center min-w-0 px-1">
						<div class="text-sm sm:text-base font-semibold text-foreground truncate">{shortDate}</div>
						<div class="text-[10px] sm:text-xs text-muted-foreground truncate">{displayDate}</div>
					</div>
					<button
						type="button"
						class="p-2 rounded-full hover:bg-muted transition-colors text-muted-foreground disabled:opacity-30 disabled:cursor-not-allowed"
						onclick={goToNextDay}
						disabled={!canGoNext}
						aria-label={$t('entryNav.nextDay')}
					>
						<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
						</svg>
					</button>
				</div>
				<button
					type="button"
					class="px-3 py-1.5 text-xs font-medium rounded-full border border-border/60 text-foreground hover:bg-muted transition-colors"
					onclick={goToToday}
					aria-label={$t('common.today')}
				>
					{$t('common.today')}
				</button>
			</div>
		</div>
	</header>

	<!-- Main list -->
	<main class="flex-1 overflow-y-auto">
		<div class="mx-auto max-w-3xl px-4 py-4 pb-28">
			{#if error}
				<div class="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-center">
					<p class="text-sm text-destructive mb-2">{error}</p>
					<button
						type="button"
						class="text-sm font-medium text-primary hover:underline"
						onclick={retryLoad}
					>
						{$t('common.retry') || 'Retry'}
					</button>
				</div>
			{:else}
				<WorkMemoList {memos} {loading} onEdit={openEditMemo} />
			{/if}
		</div>
	</main>

	<!-- Floating add button -->
	{#if !error}
		<div class="fixed bottom-6 left-1/2 -translate-x-1/2 z-20 sm:bottom-8">
			<button
				type="button"
				class="flex items-center gap-2 px-5 py-3 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 active:scale-95 transition-all"
				onclick={openNewMemo}
				aria-label={$t('worklog.addMemo')}
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
				</svg>
				<span class="text-sm font-medium">{$t('worklog.addMemo')}</span>
			</button>
		</div>
	{/if}
</div>
