<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { isAuthenticated } from '$lib/api/client';
	import { getWorkMemo, WorkMemoApiError, type WorkMemo } from '$lib/api/workMemos';
	import WorkMemoEditor from '$lib/components/worklog/WorkMemoEditor.svelte';
	import { getToday, isValidDate } from '$lib/utils/date';

	let date = $derived($page.params.date ?? getToday());
	let id = $derived($page.params.id ?? '');
	let memo = $state<WorkMemo | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let abortController: AbortController | null = null;
	let requestSequence = 0;
	let previousDate = '';
	let previousId = '';

	async function loadMemo(targetDate: string, targetId: string) {
		if (!isValidDate(targetDate)) {
			goto('/worklog', { replaceState: true });
			return;
		}
		if (!targetId) {
			goto(`/worklog/${targetDate}`);
			return;
		}

		// Cancel any in-flight request and bump sequence so stale responses
		// cannot overwrite the latest params' result.
		abortController?.abort();
		const controller = new AbortController();
		abortController = controller;
		const seq = ++requestSequence;

		loading = true;
		error = null;

		try {
			const result = await getWorkMemo(targetId, controller.signal);
			if (seq !== requestSequence) return;

			if (result.date !== targetDate) {
				// Correct the URL to the memo's real date. This replace will
				// trigger this effect again with the new date, which will then
				// load and render the same memo (not create a new one).
				goto(`/worklog/${result.date}/${targetId}`, { replaceState: true });
				return;
			}

			memo = result;
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') {
				return;
			}
			if (seq !== requestSequence) return;

			if (err instanceof WorkMemoApiError && err.status === 401) {
				goto('/login');
				return;
			}
			if (err instanceof WorkMemoApiError && err.status === 404) {
				goto(`/worklog/${targetDate}`);
				return;
			}
			console.error('Failed to load work memo:', err);
			error = err instanceof Error ? err.message : 'Failed to load memo';
		} finally {
			if (seq === requestSequence) {
				loading = false;
				abortController = null;
			}
		}
	}

	onMount(() => {
		if (!$isAuthenticated) {
			goto('/login');
			return;
		}
	});

	$effect(() => {
		if (id && date && (date !== previousDate || id !== previousId) && typeof window !== 'undefined') {
			previousDate = date;
			previousId = id;
			loadMemo(date, id);
		}
	});
</script>

{#if loading}
	<div class="min-h-screen bg-background flex items-center justify-center">
		<svg class="w-6 h-6 animate-spin text-primary" fill="none" viewBox="0 0 24 24">
			<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
			<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
		</svg>
	</div>
{:else if error}
	<div class="min-h-screen bg-background flex flex-col items-center justify-center px-4 gap-4">
		<p class="text-destructive text-sm">{error}</p>
		<button
			type="button"
			class="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
			onclick={() => loadMemo(date, id)}
		>
			Retry
		</button>
	</div>
{:else}
	<WorkMemoEditor {date} {memo} mode="edit" />
{/if}
