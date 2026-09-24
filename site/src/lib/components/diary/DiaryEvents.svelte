<script lang="ts">
	import { goto } from '$app/navigation';
	import { t, getIntlLocale } from '$lib/i18n';
	import { listWorkMemosByDate, updateWorkMemoStatus, WorkMemoApiError, type WorkMemo } from '$lib/api/workMemos';
	import { formatShortDate, isValidDate } from '$lib/utils/date';
	import DiaryRichContent from './DiaryRichContent.svelte';
	import DiaryEventEditor from './DiaryEventEditor.svelte';
	import DiaryTodoControl from './DiaryTodoControl.svelte';
	import {
		diaryTodoFailureKey,
		runDiaryTodoAction,
		type DiaryTodoAction,
		type DiaryTodoApplyResult,
		type DiaryTodoStatus
	} from './diaryTodoStatus';
	import { getEventTimeDisplay } from './diaryEventTime';
	import {
		DiaryTodoAcceptedStatuses,
		DiaryTodoPendingMutations,
		enterEventWhenTodoSettled
	} from './diaryTodoCoordination';
	import {
		NEW_EVENT_TARGET,
		memoEventTarget,
		memoIdFromTarget,
		type DiaryEditorOwner
	} from './diaryEditorOwnership';
	import { durabilityMessageKey, type EditorDurability } from './diaryEventNavigation';

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
	 * editor, and — since Controller Review Fix 2 — no longer decides *which*
	 * one is mounted either. It asks the parent to move the page's slot and
	 * renders whichever surface the committed slot names. That is what turns
	 * "open another event" into a real handoff: the parent releases the outgoing
	 * editor before tearing it down, so its queued autosave cannot be dropped by
	 * a plain DOM diff.
	 *
	 * `editorOwner` is the slot kind (is an editor allowed at all?);
	 * `editorTarget` is the slot identity (`new` or `memo:<id>`, which one?).
	 * Both come from the parent and are applied together, so they can never
	 * disagree about which surface is open.
	 */
	interface Props {
		date: string;
		/** The page's single editor-ownership state, owned by the parent. */
		editorOwner: DiaryEditorOwner;
		/** Committed slot identity: `new`, `memo:<id>`, or null. */
		editorTarget: string | null;
		/**
		 * Requests the slot for an event surface. `release` makes the outgoing
		 * event durable first; the promise rejects when it could not be.
		 */
		onEnterEventEditing: (target: string, release: () => Promise<void>) => Promise<void>;
		/** Gives the slot back, releasing the outgoing event editor first. */
		onExitEventEditing: (release: () => Promise<void>) => Promise<void>;
	}

	let { date, editorOwner, editorTarget, onEnterEventEditing, onExitEventEditing }: Props =
		$props();

	let memos = $state<WorkMemo[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	/**
	 * Shown when a handoff was refused because the outgoing event could not be
	 * made durable. Owned here, not by the outgoing editor, so that clicking the
	 * next event cannot swallow the error the previous one produced.
	 */
	let handoffError = $state<string | null>(null);
	/**
	 * Durability handle of the editor that currently holds the slot. Read lazily
	 * when a release actually runs, so it always names the editor mounted at that
	 * moment rather than the one that was mounted when the click happened.
	 */
	let activeEditor: EditorDurability | null = null;

	let abortController: AbortController | null = null;
	let requestSequence = 0;
	let loadedDate = '';

	/**
	 * Which surface the committed slot names, if any. Both guards fold in
	 * `editorOwner === 'event'`, so an editor can never be mounted for a target
	 * the page has not actually granted, and the slot kind and the slot identity
	 * can never disagree about what is open.
	 */
	let mountedNewDraft = $derived(editorOwner === 'event' && editorTarget === NEW_EVENT_TARGET);
	let mountedMemoId = $derived(editorOwner === 'event' ? memoIdFromTarget(editorTarget) : null);

	const releaseActiveEditor = () => activeEditor?.flushDurably() ?? Promise.resolve();

	function handleDurabilityChange(handle: EditorDurability | null) {
		activeEditor = handle;
	}

	/**
	 * Todo writes in flight, keyed by memo id.
	 *
	 * The registry is the authority — it holds the *promise*, so it answers both
	 * "is this Event busy?" (the guard and the busy state) and "tell me when this
	 * Event has settled" (the entry gate below). Per-Event rather than global:
	 * two cards are two different rows, so a save on one must not silently
	 * swallow a tap on another, and opening another Event must not wait for it.
	 *
	 * `todoPendingIds` is only the render mirror, kept in step by subscription so
	 * the busy state cannot be true in one place and false in another.
	 */
	const todoMutations = new DiaryTodoPendingMutations();
	let todoPendingIds = $state<string[]>(todoMutations.pendingIds);
	let todoErrors = $state<Record<string, string>>({});

	$effect(() => {
		return todoMutations.subscribe(() => {
			todoPendingIds = todoMutations.pendingIds;
		});
	});

	/**
	 * The statuses the backend has already accepted, with the revision that
	 * accepted them (Controller Review Fix 3).
	 *
	 * Not the same question as the registry above: that one is about what is
	 * still in flight, this one is about what this page already knows to be
	 * true. A list response names the whole day, so it can replace a row — a row
	 * a card write has just moved — and this is what keeps a response that was
	 * already on the wire from putting the old status back.
	 */
	const todoAccepted = new DiaryTodoAcceptedStatuses();

	function isTodoPending(id: string): boolean {
		return todoPendingIds.includes(id);
	}

	function todoErrorFor(id: string): string | null {
		return todoErrors[id] ?? null;
	}

	function setTodoError(id: string, message: string | null) {
		const next = { ...todoErrors };
		if (message === null) delete next[id];
		else next[id] = message;
		todoErrors = next;
	}

	/**
	 * The card's write. Never rejects: a refusal is an ordinary outcome the card
	 * renders, and the registry must not turn one into a rejected handle.
	 *
	 * Returns the status the backend accepted, or `null` when it refused. It
	 * deliberately does **not** decide which object that status belongs to —
	 * that is `applyAcceptedCardStatus` below — so this function cannot become
	 * the owner of the live list.
	 *
	 * Only the status is sent, and the card shows it only once the backend
	 * accepted it. The status-only request is what makes this path safe to run
	 * while nothing is being edited: it sends `{ status }` and nothing else, so
	 * it physically cannot carry a stale body.
	 */
	async function persistCardTodoStatus(
		memo: WorkMemo,
		action: DiaryTodoAction
	): Promise<DiaryTodoStatus | null> {
		const result = await runDiaryTodoAction(
			{
				// A rendered card is a stored row with no live body, so the
				// durability barrier has nothing to settle and resolves
				// immediately. The ordering invariant still holds: the status
				// request below cannot be issued before the barrier resolved,
				// and a card holds no draft, upload or association state that
				// a failure could strand.
				isPersisted: () => true,
				isDraftEmpty: () => false,
				getStatus: () => memo.status,
				makeBodyDurable: async () => {},
				commitStatus: async (next) => {
					await updateWorkMemoStatus(memo.id, next);
				}
			},
			action
		);

		if (!result.ok) {
			if (result.error instanceof WorkMemoApiError && result.error.status === 401) {
				goto('/login');
				return null;
			}
			const message = todoFailureMessage(result);
			if (message) setTodoError(memo.id, message);
			return null;
		}

		return result.status;
	}

	/**
	 * Publish a status the backend just accepted, then move the row the page is
	 * rendering.
	 *
	 * Both halves are needed, and neither replaces the other:
	 *
	 *   - the **record** protects this acceptance from a list response that was
	 *     already on the wire when it landed (see `reconcileLoadedMemos`);
	 *   - the **row patch** is what makes the acceptance visible now. The click
	 *     carried an object, but a response applying in between replaces the
	 *     whole list, so the accepted status belongs to the row currently in
	 *     `memos` — not to the object the caller happens to hold.
	 *
	 * The record is taken first so the revision is published before the row
	 * moves. Both steps are synchronous, so no request can start between them
	 * and be mistaken for one that started after the acceptance.
	 */
	function applyAcceptedCardStatus(id: string, status: DiaryTodoStatus) {
		todoAccepted.recordAcceptedStatus(id, status);
		todoAccepted.applyStatusToRows(memos, id, status);
	}

	/**
	 * Change a **stored** Event's todo status from its read-only card.
	 *
	 * This is the one place the diary uses the status-only endpoint, and it is
	 * the right one: a card is not being edited, so there is no live body to
	 * submit and no debounced autosave that could later overwrite the status.
	 *
	 * An Event that IS open in an editor never reaches here — it is rendered by
	 * `DiaryEventEditor` instead of by this card — and goes through the shared
	 * editing session, which is the only writer that can keep a status change and
	 * a pending body save from racing.
	 *
	 * The write is registered before it is awaited, so `openEvent` below can see
	 * it and an editor can never be seeded from a status this write is about to
	 * change (Controller Review Fix 2, P1-2). The registered promise is the one
	 * that also applies the accepted status to the live row, so the gate wakes
	 * up to a model that has already caught up (Fix 3).
	 */
	async function handleCardTodoAction(memo: WorkMemo, action: DiaryTodoAction) {
		// The registry is the guard, not the render mirror: a tap that arrives
		// while this Event's write is in flight is dropped, not queued.
		if (todoMutations.isPending(memo.id)) return;
		setTodoError(memo.id, null);
		await todoMutations.track(
			memo.id,
			(async () => {
				const accepted = await persistCardTodoStatus(memo, action);
				if (accepted !== null) applyAcceptedCardStatus(memo.id, accepted);
			})()
		);
	}

	/**
	 * A refused todo attempt never invents a message — the mapping lives in the
	 * pure `diaryTodoStatus` module, so both surfaces phrase failures alike.
	 */
	function todoFailureMessage(result: DiaryTodoApplyResult): string | null {
		const key = result.failure ? diaryTodoFailureKey(result.failure) : null;
		return key ? $t(key) : null;
	}

	$effect(() => {
		if (!date || date === loadedDate) return;
		loadedDate = date;
		// A draft never follows the reader onto another day — and the slot must
		// be given back, otherwise the body would stay read-only forever. The
		// navigation guard has already made the event durable by this point; the
		// release here is the safety net for any path that bypassed it.
		if (editorTarget !== null) void requestExit();
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

		// Read the revision BEFORE the request goes out: every status accepted
		// from here on is newer than anything this response can have observed,
		// so a response that still carries the old status for an Event is
		// corrected on the way in instead of replacing the row the card just
		// moved (Controller Review Fix 3).
		const loadStartedAtRevision = todoAccepted.getAcceptedRevision();

		try {
			// The backend owns ordering (pinned, then position, then created);
			// the client never re-sorts.
			const result = await listWorkMemosByDate(targetDate, controller.signal);
			if (seq !== requestSequence) return;
			memos = todoAccepted.reconcileLoadedMemos(result.memos, loadStartedAtRevision);
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
	 * Ask the parent to move the slot to `target`.
	 *
	 * Nothing is assigned locally: the outgoing editor is released *before* the
	 * parent applies the new target, and the new target is applied only after the
	 * outgoing editor has been torn down and committed to the DOM. A refusal
	 * leaves the current editor mounted and editable, and surfaces the reason.
	 */
	async function requestEvent(target: string) {
		if (editorOwner === 'event' && editorTarget === target) return;
		handoffError = null;
		try {
			await onEnterEventEditing(target, releaseActiveEditor);
		} catch (err) {
			handoffError = $t(durabilityMessageKey(err));
		}
	}

	function requestExit() {
		handoffError = null;
		void onExitEventEditing(releaseActiveEditor).catch((err) => {
			handoffError = $t(durabilityMessageKey(err));
		});
	}

	/** Claim a slot for a brand new draft. */
	function startNewEvent() {
		// Preserved from the pre-Fix-2 behaviour: a draft or an open event is
		// never replaced by the "add" affordance, so this cannot discard a new
		// draft that has not been persisted yet.
		if (editorTarget !== null) return;
		void requestEvent(NEW_EVENT_TARGET);
	}

	/**
	 * Open an Event in the inline editor.
	 *
	 * Gated on that Event's own card mutation (Controller Review Fix 2, P1-2).
	 * The editor seeds its session from the status it is handed, so opening while
	 * `normal -> pending` is still on the wire would seed it with `normal` — and
	 * its first autosave would then PUT that straight back over the `pending` the
	 * user had already been shown. Waiting here, and re-reading the model
	 * afterwards instead of using the object captured at click time, closes that
	 * race for every entry path rather than only for the button.
	 *
	 * Only the same Event waits (`settleTodo` is keyed by id), so a write in
	 * flight for another Event never delays this one.
	 */
	function openEvent(memo: WorkMemo) {
		void enterEventWhenTodoSettled(memo.id, {
			settleTodo: (id) => todoMutations.settle(id),
			readMemo: (id) => memos.find((candidate) => candidate.id === id) ?? null,
			enter: (fresh) => requestEvent(memoEventTarget(fresh.id))
		});
	}

	function handleEditorDone(result: { persisted: boolean }) {
		requestExit();
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
		{#if memos.length === 0 && editorTarget === null}
			<p class="mb-3 text-sm text-muted-foreground/70">{$t('diaryEvents.empty')}</p>
		{/if}

		{#if handoffError}
			<p class="mb-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
				{handoffError}
			</p>
		{/if}

		{#if memos.length > 0}
			<div class="space-y-4">
				{#each memos as memo (memo.id)}
					{#if mountedMemoId === memo.id}
						<DiaryEventEditor
							{date}
							{memo}
							onDone={handleEditorDone}
							onDurabilityChange={handleDurabilityChange}
						/>
					{:else}
						<article class="group border-l-2 border-border/50 pl-3 sm:pl-4">
							<div class="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
								<time class="min-w-0 text-xs font-medium tabular-nums text-muted-foreground" datetime={memo.created}>
									{formatEventLabel(memo)}
								</time>
								<!-- The todo control belongs to THIS event's header, so
								     it is always unambiguous which Event is being
								     changed. `flex-wrap` is what keeps a long event
								     from producing a horizontal scrollbar. -->
								<DiaryTodoControl
									status={memo.status}
									busy={isTodoPending(memo.id)}
									error={todoErrorFor(memo.id)}
									onAction={(action) => handleCardTodoAction(memo, action)}
								/>
								<button
									type="button"
									class="ml-auto flex-shrink-0 rounded-full p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
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

		{#if editorTarget === NEW_EVENT_TARGET}
			<div class="mt-4">
				{#if mountedNewDraft}
					<DiaryEventEditor {date} onDone={handleEditorDone} onDurabilityChange={handleDurabilityChange} />
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
