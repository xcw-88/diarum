<script lang="ts">
	import { t } from '$lib/i18n';
	import type { WorkMemo } from '$lib/api/workMemos';
	import WorkMemoCard from './WorkMemoCard.svelte';

	interface Props {
		memos: WorkMemo[];
		loading?: boolean;
		onEdit?: (memo: WorkMemo) => void;
	}

	let { memos, loading = false, onEdit }: Props = $props();

	function handleEdit(memo: WorkMemo) {
		onEdit?.(memo);
	}
</script>

{#if loading}
	<div class="flex flex-col items-center justify-center py-12 gap-3">
		<svg class="w-6 h-6 animate-spin text-primary" fill="none" viewBox="0 0 24 24">
			<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
			<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
		</svg>
		<div class="text-muted-foreground text-sm">{$t('common.loading')}</div>
	</div>
{:else if memos.length === 0}
	<div class="flex flex-col items-center justify-center py-16 px-4 text-center">
		<div class="w-16 h-16 mb-4 rounded-full bg-muted/60 flex items-center justify-center">
			<svg class="w-8 h-8 text-muted-foreground/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
			</svg>
		</div>
		<p class="text-muted-foreground text-sm max-w-[16rem]">{$t('worklog.emptyState')}</p>
	</div>
{:else}
	<div class="space-y-3">
		{#each memos as memo (memo.id)}
			<WorkMemoCard {memo} onClick={handleEdit} />
		{/each}
	</div>
{/if}
