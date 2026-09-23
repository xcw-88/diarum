<script lang="ts">
	import { goto } from '$app/navigation';
	import { t, getIntlLocale } from '$lib/i18n';
	import { listWorkMemosByDate, WorkMemoApiError, type WorkMemo } from '$lib/api/workMemos';
	import { formatShortDate, isValidDate } from '$lib/utils/date';
	import DiaryRichContent from './DiaryRichContent.svelte';
	import DiaryEventEditor from './DiaryEventEditor.svelte';
	import { getEventTimeDisplay } from './diaryEventTime';
	import type { DiaryEditorOwner } from './diaryEditorOwnership';

	/**
	 * The day's Events, stored as individual `work_memos` rows.
	 *
	 * Only ONE image-capable editor may exist on the page at any moment. The
	 * TipTap editor registers its image/gallery handlers in a module-level
	 * singleton and clears them unconditionally on destroy, so an editor that
	 * unmounts after a newer one has mounted would wipe the newer one's
	 * handlers (see `diaryEditorOwnership`).
	 *
	 * This component therefore does not decide on its own when to mount an
	 * editor. It asks the parent (`ClassicDiaryView`) to hand the slot over and
	 * only renders the editor once `editorOwner` says the handoff completed —
	 * which is strictly after the legacy diary editor was torn down. `editorTarget`
	 * still owns *which* event is being edited; `editorOwner` owns *whether an
	 * editor may exist at all*.
	 */
	interface Props {
		date: string;
		/** The page's single editor-ownership state, owned by the parent. */
		editorOwner: DiaryEditorOwner;
		/** Two-phase handoff: resolves once the legacy editor has been torn down. */
		onEnterEventEditing: () => Promise<void>;
		/** Two-phase handoff: resolves once the event editor has been torn down. */
		onExitEventEditing: () => Promise<void>;
	}

	let { date, editorOwner, onEnterEventEditing, onExitEventEditing }: Props = $props();

	let memos = $state<WorkMemo[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	/** At most one surface: a new draft, one existing event, or nothing. */
	let editorTarget = $state<{ kind: 'new' } | { kind: 'edit'; id: string } | null>(null);

	let abortController: AbortController | null = null;
	let requestSequence = 0;
	let loadedDate = '';

	$effect(() => {
		if (!date || date === loadedDate) return;
		loadedDate = date;
		// A draft never follows the reader onto another day — and the slot must
		// be given back, otherwise the body would stay read-only forever.
		if (editorTarget !== null) {
			editorTarget = null;
			void onExitEventEditing();
		}
		void loadMemos(date);
	});

	async function loadMemos(targetDate: string) {
		if (!isValidDate(targetDate)) return;

		// Cancel the previous request and start a new one with a fresh sequence.
		abortController?.abort();
		const controller = new AbortController();
		abortController = controller;
		const seq = ++requestSequence;

		loading = true;
		error = null;

		try {
			// The backend owns ordering (pinned, then position, then created);
			// the client never re-sorts.
			const result = await listWorkMemosByDate(targetDate, controller.signal);
			if (seq !== requestSequence) return;
			memos = result.memos;
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			if (err instanceof WorkMemoApiError && err.status === 401) {
				goto('/login');
				return;
			}
			if (seq !== requestSequence) return;
			console.error('Failed to load diary events:', err);
			error = $t('diaryEvents.loadFailed');
			memos = [];
		} finally {
			if (seq === requestSequence) {
				loading = false;
				abortController = null;
			}
		}
	}

	/**
	 * `editorTarget` is set first so the slot is reserved in the same flush, but
	 * the editor still cannot mount until `editorOwner === 'event'` — which only
	 * happens after the legacy editor has been torn down.
	 */
	function startNewEvent() {
		if (editorTarget !== null) return;
		editorTarget = { kind: 'new' };
		void onEnterEventEditing();
	}

	function openEvent(memo: WorkMemo) {
		if (editorTarget?.kind === 'edit' && editorTarget.id === memo.id) return;
		editorTarget = { kind: 'edit', id: memo.id };
		void onEnterEventEditing();
	}

	function handleEditorDone(result: { persisted: boolean }) {
		editorTarget = null;
		// Give the slot back: the event editor is torn down first, and only after
		// that flush does the legacy diary editor remount.
		void onExitEventEditing();
		// A draft that never produced content created no row, so there is
		// nothing to refresh.
		if (result.persisted) void loadMemos(date);
	}

	function retryLoad() {
		void loadMemos(date);
	}

	/**
	 * `14:26` for the common case, `补记于 9月23日 14:26` when the entry was
	 * written on a different day than the one it belongs to. The database value
	 * is never rewritten, and the diary date is never shown as a creation time.
	 */
	function formatEventLabel(memo: WorkMemo): string {
		const display = getEventTimeDisplay(date, memo.created);
		if (display.invalid) return '';
		const time = formatClock(display.hours, display.minutes);
		if (!display.backfilled) return time;
		return $t('diaryEvents.backfilledAt', {
			date: formatShortDate(display.createdDate),
			time
		});
	}

	function formatClock(hours: number, minutes: number): string {
		// A fixed local probe date: only the wall-clock components are formatted.
		const probe = new Date(2000, 0, 1, hours, minutes);
		return probe.toLocaleTimeString(getIntlLocale(), { hour: '2-digit', minute: '2-digit' });
	}
</script>

<section class="mt-8 border-t border-border/60 pt-5" aria-labelledby="diary-events-heading">
	<h2
		id="diary-events-heading"
		class="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
	>
		{$t('diaryEvents.heading')}
	</h2>

	{#if error}
		<div class="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-center">
			<p class="mb-2 text-sm text-destructive">{error}</p>
			<button type="button" class="text-sm font-medium text-primary hover:underline" onclick={retryLoad}>
				{$t('common.retry')}
			</button>
		</div>
	{:else if loading}
		<p class="text-sm text-muted-foreground/70">{$t('common.loading')}</p>
	{:else}
		{#if memos.length === 0 && !editorTarget}
			<p class="mb-3 text-sm text-muted-foreground/70">{$t('diaryEvents.empty')}</p>
		{/if}

		{#if memos.length > 0}
			<div class="space-y-4">
				{#each memos as memo (memo.id)}
					{#if editorTarget?.kind === 'edit' && editorTarget.id === memo.id}
						{#if editorOwner === 'event'}
							<DiaryEventEditor {date} {memo} onDone={handleEditorDone} />
						{/if}
					{:else}
						<article class="group border-l-2 border-border/50 pl-3 sm:pl-4">
							<div class="mb-1 flex items-center gap-2">
								<time class="min-w-0 text-xs font-medium tabular-nums text-muted-foreground" datetime={memo.created}>
									{formatEventLabel(memo)}
								</time>
								<button
									type="button"
									class="flex-shrink-0 rounded-full p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
									onclick={() => openEvent(memo)}
									aria-label={$t('diaryEvents.editEvent')}
									title={$t('diaryEvents.editEvent')}
								>
									<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
										<path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
									</svg>
								</button>
							</div>
							<DiaryRichContent html={memo.content} fallback={$t('worklog.emptyContent')} />
						</article>
					{/if}
				{/each}
			</div>
		{/if}

		{#if editorTarget?.kind === 'new'}
			<div class="mt-4">
				{#if editorOwner === 'event'}
					<DiaryEventEditor {date} onDone={handleEditorDone} />
				{/if}
			</div>
		{:else}
			<button
				type="button"
				class="mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
				onclick={startNewEvent}
			>
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
				</svg>
				<span>{$t('diaryEvents.add')}</span>
			</button>
		{/if}
	{/if}
</section>
