<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { isAuthenticated } from '$lib/api/client';
	import {
		getWorkMemoCalendar,
		WorkMemoApiError,
		type WorkMemoCalendarDay
	} from '$lib/api/workMemos';
	import WorklogCalendar from '$lib/components/worklog/WorklogCalendar.svelte';

	const initialDate = new Date();
	let currentYear = $state(initialDate.getFullYear());
	let currentMonth = $state(initialDate.getMonth() + 1);
	let days = $state<WorkMemoCalendarDay[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let mounted = $state(false);
	let abortController: AbortController | null = null;
	let requestSequence = 0;
	let monthKey = $derived(`${currentYear}-${String(currentMonth).padStart(2, '0')}`);

	async function loadMonth(targetMonth: string) {
		abortController?.abort();
		const controller = new AbortController();
		abortController = controller;
		const seq = ++requestSequence;

		loading = true;
		error = null;
		try {
			const result = await getWorkMemoCalendar(targetMonth, controller.signal);
			if (seq !== requestSequence) return;
			days = result.days;
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			if (seq !== requestSequence) return;
			if (err instanceof WorkMemoApiError && err.status === 401) {
				goto('/login');
				return;
			}
			console.error('Failed to load work memo calendar:', err);
			error = err instanceof Error ? err.message : $t('worklog.calendarLoadFailed');
			days = [];
		} finally {
			if (seq === requestSequence) {
				loading = false;
				if (abortController === controller) abortController = null;
			}
		}
	}

	function shiftMonth(delta: number) {
		const target = new Date(currentYear, currentMonth - 1 + delta, 1);
		currentYear = target.getFullYear();
		currentMonth = target.getMonth() + 1;
	}

	function goToToday() {
		const today = new Date();
		currentYear = today.getFullYear();
		currentMonth = today.getMonth() + 1;
	}

	function openDate(date: string) {
		goto(`/worklog/${date}`);
	}

	onMount(() => {
		if (!$isAuthenticated) {
			goto('/login');
			return;
		}
		mounted = true;
		return () => abortController?.abort();
	});

	$effect(() => {
		if (mounted) void loadMonth(monthKey);
	});
</script>

<svelte:head>
	<title>{$t('worklog.calendarTitle')} - {$t('worklog.pageTitle')}</title>
</svelte:head>

<div class="min-h-screen bg-background">
	<header class="sticky top-0 z-20 border-b border-border/50 glass">
		<div class="relative mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
			<a href="/" class="flex items-center gap-2 text-sm font-medium text-foreground transition-colors hover:text-primary">
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
				</svg>
				<span class="hidden sm:inline">{$t('nav.home')}</span>
			</a>
			<h1 class="pointer-events-none absolute left-1/2 -translate-x-1/2 text-base font-semibold text-foreground">{$t('worklog.calendarTitle')}</h1>
			<div class="w-9 sm:w-16" aria-hidden="true"></div>
		</div>
	</header>

	<main class="mx-auto max-w-3xl px-3 py-4 sm:px-4 sm:py-6">
		{#if error}
			<div class="mb-3 flex items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3">
				<p class="text-sm text-destructive">{$t('worklog.calendarLoadFailed')}</p>
				<button type="button" class="text-sm font-medium text-primary hover:underline" onclick={() => loadMonth(monthKey)}>
					{$t('common.retry')}
				</button>
			</div>
		{/if}

		<WorklogCalendar
			year={currentYear}
			month={currentMonth}
			{days}
			{loading}
			onPreviousMonth={() => shiftMonth(-1)}
			onNextMonth={() => shiftMonth(1)}
			onToday={goToToday}
			onSelectDate={openDate}
		/>

		<p class="mt-4 text-center text-xs text-muted-foreground">
			{$t('worklog.calendarHint')}
		</p>
	</main>
</div>
