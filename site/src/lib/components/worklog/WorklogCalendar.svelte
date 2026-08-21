<script lang="ts">
	import { locale, t, ta } from '$lib/i18n';
	import { formatDate, getCalendarDays, getToday } from '$lib/utils/date';
	import type { WorkMemoCalendarDay } from '$lib/api/workMemos';

	interface Props {
		year: number;
		month: number;
		days?: WorkMemoCalendarDay[];
		loading?: boolean;
		onPreviousMonth: () => void;
		onNextMonth: () => void;
		onToday: () => void;
		onSelectDate: (date: string) => void;
	}

	let {
		year,
		month,
		days = [],
		loading = false,
		onPreviousMonth,
		onNextMonth,
		onToday,
		onSelectDate
	}: Props = $props();

	let calendarDays = $derived(getCalendarDays(year, month));
	let countByDate = $derived(new Map(days.map((day) => [day.date, day.count])));
	let monthNames = $derived($ta('calendar.months'));
	let weekdays = $derived($ta('calendar.weekdaysShort'));
	let monthLabel = $derived(
		$locale === 'zh'
			? `${year}年${monthNames[month - 1] ?? month}`
			: `${monthNames[month - 1] ?? month} ${year}`
	);
	let today = $derived(getToday());
</script>

<section class="relative overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
	<div class="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-3 sm:px-5">
		<button
			type="button"
			class="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			onclick={onPreviousMonth}
			aria-label={$t('calendar.previousMonth')}
		>
			<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
			</svg>
		</button>

		<div class="min-w-0 text-center">
			<h2 class="truncate text-base font-semibold text-foreground sm:text-lg">{monthLabel}</h2>
			<button
				type="button"
				class="mt-0.5 text-xs font-medium text-primary hover:underline"
				onclick={onToday}
			>
				{$t('common.today')}
			</button>
		</div>

		<button
			type="button"
			class="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			onclick={onNextMonth}
			aria-label={$t('calendar.nextMonth')}
		>
			<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
			</svg>
		</button>
	</div>

	<div class="grid grid-cols-7 border-b border-border/40 bg-muted/20 px-2 py-2 sm:px-4">
		{#each weekdays as weekday}
			<div class="text-center text-[11px] font-medium text-muted-foreground sm:text-xs">{weekday}</div>
		{/each}
	</div>

	<div class="grid grid-cols-7 gap-px bg-border/40 p-px" aria-busy={loading}>
		{#each calendarDays as day}
			{@const date = formatDate(day)}
			{@const count = countByDate.get(date) ?? 0}
			{@const inCurrentMonth = day.getFullYear() === year && day.getMonth() + 1 === month}
			{@const isToday = date === today}
			<button
				type="button"
				class="relative flex min-h-[4.5rem] flex-col items-center bg-card px-0.5 py-2 transition-colors hover:bg-muted/70 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:min-h-24 sm:px-1"
				class:text-muted-foreground={!inCurrentMonth}
				onclick={() => onSelectDate(date)}
				aria-label={count > 0 ? $t('worklog.calendarDayCount', { date, count }) : date}
			>
				<span
					class="flex h-7 w-7 items-center justify-center rounded-full text-sm tabular-nums"
					class:bg-primary={isToday}
					class:text-primary-foreground={isToday}
					class:font-semibold={isToday}
					class:opacity-40={!inCurrentMonth && !isToday}
				>
					{day.getDate()}
				</span>
				{#if count > 0 && inCurrentMonth}
					<span class="mt-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary sm:text-xs">
						{count}
					</span>
				{/if}
			</button>
		{/each}
	</div>

	{#if loading}
		<div class="absolute inset-x-0 bottom-0 top-[7.25rem] flex items-center justify-center bg-card/65 backdrop-blur-[1px]">
			<div class="flex items-center gap-2 rounded-full bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm">
				<span class="h-4 w-4 animate-spin rounded-full border-2 border-primary/25 border-t-primary"></span>
				{$t('common.loading')}
			</div>
		</div>
	{/if}
</section>
