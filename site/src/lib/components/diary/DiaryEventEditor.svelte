<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { t } from '$lib/i18n';
	import TiptapEditor from '$lib/components/editor/TiptapEditor.svelte';
	import {
		createWorkMemo,
		updateWorkMemo,
		deleteWorkMemo,
		type WorkMemo
	} from '$lib/api/workMemos';
	import {
		attachWorkMemoMedia,
		detachWorkMemoMedia,
		listWorkMemoMedia
	} from '$lib/api/workMemoMedia';
	import type { SaveMachineState } from '../worklog/workMemoSaveMachine';
	import { WorkMemoEditingSession } from '../worklog/workMemoEditingSession';
	import { isContentEffectivelyEmpty } from '../worklog/workMemoContent';
	import { getPopstateReplayDelta } from '../worklog/replayPopstate';
	import DiaryTodoControl from './DiaryTodoControl.svelte';
	import {
		createSessionStatusCommit,
		diaryTodoFailureKey,
		runDiaryTodoAction,
		type DiaryTodoAction,
		type DiaryTodoApplyResult,
		type DiaryTodoStatus
	} from './diaryTodoStatus';
	import { durabilityMessageKey, shouldHoldNavigation, type EditorDurability } from './diaryEventNavigation';

	interface Props {
		/** The diary day being viewed. Always the memo's date. */
		date: string;
		/** Existing memo to edit; omit to start a brand new event. */
		memo?: WorkMemo | null;
		/** `persisted` is false when the user leaves an empty draft behind. */
		onDone: (result: { persisted: boolean }) => void;
		/**
		 * Publishes this editor's durability handle to the page, so the page can
		 * make this editor durable before it hands the slot to another event.
		 * Must be cleared on destroy.
		 */
		onDurabilityChange?: (handle: EditorDurability | null) => void;
	}

	let { date, memo = null, onDone, onDurabilityChange }: Props = $props();

	const SAVE_DEBOUNCE_MS = 800;

	// Mirrors the session's body. Seeded from the session in `onMount`, which is
	// also where the session is constructed, so the initial body has exactly one
	// source of truth.
	let content = $state('');
	let machineState = $state<SaveMachineState | null>(null);
	let saveError = $state<string | null>(null);
	/**
	 * The todo status this editor renders. Like `content` above, it starts from
	 * a constant and is seeded from the session in `onMount`, so there is exactly
	 * one source of truth (the session) and no copy of the prop is captured here.
	 * It is then committed only after a write the backend accepted, which is what
	 * stops the control showing a state the database rejected.
	 */
	let todoStatus = $state<DiaryTodoStatus>('normal');
	let todoBusy = $state(false);
	let todoError = $state<string | null>(null);
	let session: WorkMemoEditingSession | null = null;
	let wrapperEl: HTMLDivElement | undefined = $state();

	// Prevents beforeNavigate from re-flushing a navigation we initiated.
	let isReplayingNavigation = false;

	let statusText = $derived.by(() => {
		const phase = machineState?.phase;
		if (phase === 'saving') return $t('diaryEvents.saving');
		if (phase === 'saved') return $t('diaryEvents.saved');
		if (phase === 'error') return $t('diaryEvents.saveFailed');
		return '';
	});

	function focusEditor() {
		if (!wrapperEl) return;
		const editable = wrapperEl.querySelector<HTMLElement>('[contenteditable="true"]');
		editable?.focus();
	}

	function handleContentChange(newContent: string) {
		content = newContent;
		saveError = null;
		session?.handleContentChange(newContent);
	}

	function handleImageUploadStateChange(state: { pending: number; error: string | null }) {
		session?.handleImageUploadStateChange(state);
	}

	/**
	 * Change this Event's todo status without risking the body being edited.
	 *
	 * The write goes through the shared `WorkMemoEditingSession`, never through
	 * the status-only API. The save machine owns ONE snapshot of
	 * `{ content, status, isPinned }`, so a debounced autosave can never land
	 * afterwards and put the old status back; two independent writers would be
	 * exactly that race. Nothing here is a second save guard — the delete /
	 * single-flight / debounce policy stays in `WorkMemoSaveMachine`.
	 *
	 * `createSessionStatusCommit` owns the ORDER, and the order is the guarantee:
	 * the durability barrier runs FIRST, while the session still holds the old
	 * status (Controller Review Fix 1). A barrier that fails at its association
	 * step — a real, already-tested outcome — therefore cannot leave `pending` on
	 * the server behind a "todo failed" message.
	 *
	 * The commit that follows it waits for the **status revision only** (Fix 2):
	 * it uses `flushThroughStatus`, so a body generation the user produces while
	 * the status request is on the wire cannot fail and turn a status write that
	 * already landed into a reported failure plus a rollback. That later failure
	 * stays an ordinary autosave error, and the todo stays as the user set it.
	 *
	 * `runDiaryTodoAction` adds the §5 rules: an empty draft is refused rather
	 * than turned into a blank row just to hold a checkbox state, and a brand new
	 * Event is made durable — row created, images linked — before its status is
	 * written.
	 */
	async function handleTodoAction(action: DiaryTodoAction) {
		if (!session || todoBusy) return;
		const s = session;
		todoBusy = true;
		todoError = null;
		try {
			const result = await runDiaryTodoAction(
				{
					isPersisted: () => s.memoId !== null,
					isDraftEmpty: () => isContentEffectivelyEmpty(s.currentContent),
					...createSessionStatusCommit(s)
				},
				action
			);

			if (!result.ok) {
				todoError = todoFailureMessage(result);
				return;
			}
			todoStatus = result.status;
		} finally {
			todoBusy = false;
		}
	}

	/**
	 * A failed todo attempt never invents a message: a durability rejection
	 * already has a specific one in `diaryEventNavigation`, and everything else
	 * maps through the pure `diaryTodoFailureKey`.
	 */
	function todoFailureMessage(result: DiaryTodoApplyResult): string | null {
		if (result.error !== undefined) return $t(durabilityMessageKey(result.error));
		const key = result.failure ? diaryTodoFailureKey(result.failure) : null;
		return key ? $t(key) : null;
	}

	async function handleDone() {
		if (!session) {
			onDone({ persisted: false });
			return;
		}
		try {
			// The shared durability contract: uploads settled, body saved, memo
			// created if needed, associations reconciled. An empty draft never
			// created anything, so this resolves without touching the database.
			await session.flushDurably();
		} catch (error) {
			// Stay in the editor so the user sees the failure and can retry.
			saveError = $t(durabilityMessageKey(error));
			return;
		}
		onDone({ persisted: session.memoId !== null });
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		// Only claim Escape while the user is actually inside this editor, so no
		// other overlay on the diary page loses its own Escape handling.
		const active = document.activeElement;
		if (!wrapperEl || !active || !wrapperEl.contains(active)) return;
		event.preventDefault();
		void handleDone();
	}

	beforeNavigate((navigation) => {
		if (isReplayingNavigation) {
			isReplayingNavigation = false;
			return;
		}
		if (!session) return;

		// The session owns the definition of "something is at stake"; the pure
		// helper owns the decision of which navigations can lose it. Neither one
		// looks at a single save-machine phase, which is what let an in-flight
		// image upload slip through before.
		const mustHold = shouldHoldNavigation({
			fromPathname: $page.url.pathname,
			toPathname: navigation.to?.url.pathname ?? null,
			hasDurabilityWork: session.hasDurabilityWork()
		});
		if (!mustHold) return;

		// Unsaved or unlinked work is queued or in flight: hold the navigation
		// until everything is durable, then replay it.
		navigation.cancel();
		session
			.flushDurably()
			.then(() => {
				isReplayingNavigation = true;
				const target = navigation.to;
				if (navigation.type === 'popstate') {
					window.history.go(getPopstateReplayDelta(navigation.delta));
				} else {
					goto(
						target
							? `${target.url.pathname}${target.url.search}${target.url.hash}`
							: `/diary/${date}`
					);
				}
			})
			.catch((error) => {
				// Flush failed: stay on the page so the user sees the error state.
				saveError = $t(durabilityMessageKey(error));
			});
	});

	onMount(() => {
		const s = new WorkMemoEditingSession({
			date,
			memoId: memo?.id ?? null,
			initialContent: memo?.content ?? '',
			initialStatus: memo?.status ?? 'normal',
			initialIsPinned: memo?.is_pinned ?? false,
			debounceMs: SAVE_DEBOUNCE_MS,
			create: async (targetDate, snapshot) => {
				const created = await createWorkMemo({
					date: targetDate,
					content: snapshot.content,
					status: snapshot.status,
					is_pinned: snapshot.isPinned
				});
				return created.id;
			},
			update: async (id, snapshot) => {
				await updateWorkMemo(id, {
					content: snapshot.content,
					status: snapshot.status,
					is_pinned: snapshot.isPinned
				});
			},
			remove: async (id) => {
				await deleteWorkMemo(id);
			},
			listMedia: listWorkMemoMedia,
			attachMedia: attachWorkMemoMedia,
			detachMedia: detachWorkMemoMedia,
			onStateChange: (state) => {
				machineState = state;
			}
		});
		session = s;
		content = s.currentContent;
		machineState = s.getState();
		// The session is the authority for the todo status, so the render mirror
		// is seeded from it rather than from the prop alone.
		todoStatus = s.getSnapshot().status;

		// Publish the durability handle so the page can release this editor
		// before it hands the slot to another event.
		onDurabilityChange?.({
			hasDurabilityWork: () => s.hasDurabilityWork(),
			flushDurably: () => s.flushDurably()
		});

		// §11: a brand new entry gets the caret immediately.
		focusEditor();
		const raf = requestAnimationFrame(focusEditor);
		window.addEventListener('keydown', handleKeydown);

		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('keydown', handleKeydown);
		};
	});

	onDestroy(() => {
		// Clear first: from here on this editor must never be asked to release.
		onDurabilityChange?.(null);
		session?.destroy();
		session = null;
	});
</script>

<div class="diary-event-editor" bind:this={wrapperEl}>
	<div class="rounded-lg border border-primary/35 bg-background/70 px-2 py-1">
		<TiptapEditor
			{content}
			onChange={handleContentChange}
			placeholder={$t('diaryEvents.editorPlaceholder')}
			commandPlaceholder={$t('diaryEvents.editorPlaceholder')}
			emptyStatePrompt={$t('diaryEvents.editorEmptyPrompt')}
			emptyStateAlignTop={true}
			allowImages={true}
			showImageActions={true}
			uploadImageLabel={$t('worklog.addImage')}
			chooseFromGalleryLabel={$t('worklog.chooseFromGallery')}
			onImageUploadStateChange={handleImageUploadStateChange}
			associateWithDiary={false}
		/>
	</div>

	<!-- The Event's own action row: todo state, save feedback, Done. `flex-wrap`
	     keeps all three reachable on a phone and never widens the page. -->
	<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
		<DiaryTodoControl
			status={todoStatus}
			busy={todoBusy}
			error={todoError}
			onAction={handleTodoAction}
		/>
		<span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{saveError ?? statusText}</span>
		<button
			type="button"
			class="flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 transition-colors"
			onclick={handleDone}
		>
			{$t('diaryEvents.done')}
		</button>
	</div>
</div>

<style>
	/* The shared TipTap surface is sized for a full-page editor (500px). Inline
	   inside the diary page it needs a much shorter default. The compound
	   selector raises specificity above the editor component's own scoped rule
	   without leaking a global style onto the legacy diary editor. */
	.diary-event-editor :global(.tiptap-editor),
	.diary-event-editor :global(.editor-container) {
		min-height: 7rem;
	}
</style>
