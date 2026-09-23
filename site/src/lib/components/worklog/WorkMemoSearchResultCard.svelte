<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatDisplayDate, formatShortDate, getDayOfWeek } from '$lib/utils/date';
	import type { WorkMemoSearchItem } from '$lib/api/workMemoSearch';

	interface Props {
		item: WorkMemoSearchItem;
		onOpen: (item: WorkMemoSearchItem) => void;
	}

	let { item, onOpen }: Props = $props();

	let statusLabel = $derived(
		item.status === 'pending'
			? $t('worklog.statusPending')
			: item.status === 'completed'
				? $t('worklog.statusCompleted')
				: $t('worklog.statusNormal')
	);

	function handleClick() {
		onOpen(item);
	}
</script>

<button
	type="button"
	class="w-full text-left group"
	onclick={handleClick}
	aria-label={$t('worklogSearch.openResult', { date: item.date })}
>
	<div
		class="relative rounded-xl border border-border/50 bg-card p-4 shadow-sm transition-all duration-200 hover:border-primary/30 hover:shadow-md active:scale-[0.99]"
	>
		{#if item.is_pinned}
			<div
				class="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
				aria-hidden="true"
			>
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
					<path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" />
				</svg>
			</div>
		{/if}

		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0 flex-1">
				<div class="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
					<span class="text-xs font-medium text-foreground tabular-nums">
						<span class="hidden sm:inline">{formatDisplayDate(item.date)}</span>
						<span class="sm:hidden">{formatShortDate(item.date)}</span>
					</span>
					<span class="text-[11px] text-muted-foreground">{getDayOfWeek(item.date)}</span>

					{#if item.status === 'pending'}
						<span class="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
							{statusLabel}
						</span>
					{:else if item.status === 'completed'}
						<span class="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
							{statusLabel}
						</span>
					{:else}
						<span class="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
							{statusLabel}
						</span>
					{/if}

					{#if item.is_pinned}
						<span class="inline-flex items-center rounded-full border border-primary/30 px-2 py-0.5 text-[10px] font-medium text-primary">
							{$t('worklog.pinned')}
						</span>
					{/if}
				</div>

				<!--
					The snippet is plain text produced by the backend from indexed
					text. It is rendered as a text node on purpose: no {@html}, so
					markup in stored content can never execute here.
				-->
				<p class="text-sm leading-relaxed text-foreground break-words line-clamp-4">
					{item.snippet || $t('worklog.emptyContent')}
				</p>

				{#if item.tags.length > 0}
					<ul class="mt-2 flex flex-wrap gap-1.5">
						{#each item.tags as tag (tag)}
							<li class="inline-flex max-w-full items-center truncate rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
								#{tag}
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<svg
				class="h-4 w-4 flex-shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				aria-hidden="true"
			>
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
			</svg>
		</div>
	</div>
</button>
