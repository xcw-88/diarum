<script lang="ts">
	import { t } from '$lib/i18n';
	import type { WorkMemo } from '$lib/api/workMemos';

	interface Props {
		memo: WorkMemo;
		onClick?: (memo: WorkMemo) => void;
	}

	let { memo, onClick }: Props = $props();

	function handleClick() {
		onClick?.(memo);
	}

	function formatTime(isoString: string): string {
		if (!isoString) return '';
		try {
			const date = new Date(isoString);
			return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		} catch {
			return '';
		}
	}

	function extractPlainText(html: string): string {
		if (!html) return '';
		const tmp = html.replace(/<[^>]*>/g, ' ');
		return tmp.replace(/\s+/g, ' ').trim();
	}

	function statusLabel(status: string): string {
		if (status === 'pending') return $t('worklog.statusPending');
		if (status === 'completed') return $t('worklog.statusCompleted');
		return '';
	}
</script>

<button
	type="button"
	class="w-full text-left group"
	onclick={handleClick}
	aria-label={$t('worklog.editMemo')}
>
	<div
		class="relative rounded-xl border border-border/50 bg-card p-4 shadow-sm transition-all duration-200 hover:border-primary/30 hover:shadow-md active:scale-[0.99] {memo.is_pinned ? 'ring-2' : ''}"
		style={memo.is_pinned ? 'box-shadow: 0 0 0 2px hsl(var(--primary) / 0.2);' : ''}
	>
		{#if memo.is_pinned}
			<div class="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" />
				</svg>
			</div>
		{/if}

		<div class="flex items-start justify-between gap-3">
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-2 mb-1.5">
					<span class="text-xs font-medium text-muted-foreground tabular-nums">
						{formatTime(memo.created)}
					</span>
					{#if memo.status === 'pending'}
						<span class="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
							{statusLabel(memo.status)}
						</span>
					{:else if memo.status === 'completed'}
						<span class="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
							{statusLabel(memo.status)}
						</span>
					{/if}
				</div>
				<p class="text-sm text-foreground line-clamp-4 leading-relaxed">
					{extractPlainText(memo.content) || $t('worklog.emptyContent')}
				</p>
			</div>
			<svg class="h-4 w-4 flex-shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
			</svg>
		</div>
	</div>
</button>
