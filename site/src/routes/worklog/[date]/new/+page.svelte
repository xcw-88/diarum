<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { isAuthenticated } from '$lib/api/client';
	import WorkMemoEditor from '$lib/components/worklog/WorkMemoEditor.svelte';
	import { getToday, isValidDate } from '$lib/utils/date';

	let date = $derived($page.params.date ?? getToday());

	onMount(() => {
		if (!$isAuthenticated) {
			goto('/login');
			return;
		}
		if (!isValidDate(date)) {
			goto('/worklog', { replaceState: true });
		}
	});
</script>

{#if isValidDate(date)}
	<WorkMemoEditor {date} mode="new" />
{/if}
