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
	import { getPopstateReplayDelta } from '../worklog/replayPopstate';

	interface Props {
		/** The diary day being viewed. Always the memo's date. */
		date: string;
		/** Existing memo to edit; omit to start a brand new event. */
		memo?: WorkMemo | null;
		/** `persisted` is false when the user leaves an empty draft behind. */
		onDone: (result: { persisted: boolean }) => void;
	}

	let { date, memo = null, onDone }: Props = $props();

	const SAVE_DEBOUNCE_MS = 800;

	// Mirrors the session's body. Seeded from the session in `onMount`, which is
	// also where the session is constructed, so the initial body has exactly one
	// source of truth.
	let content = $state('');
	let machineState = $state<SaveMachineState | null>(null);
	let saveError = $state<string | null>(null);
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
		session?.handleContentChange(newContent);
	}

	function handleImageUploadStateChange(state: { pending: number; error: string | null }) {
		session?.handleImageUploadStateChange(state);
	}

	async function handleDone() {
		if (!session) {
			onDone({ persisted: false });
			return;
		}
		try {
			// An empty draft never created anything, so this resolves immediately
			// and the editor closes without touching the database.
			await session.flush();
		} catch {
			// Stay in the editor so the user sees the failure and can retry.
			saveError = $t('diaryEvents.saveFailed');
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
		if (navigation.to?.url.pathname === $page.url.pathname) return;
		// Nothing typed, nothing queued: never interfere with ordinary diary
		// navigation (previous/next day, drawer links).
		if (!session?.hasPendingChanges()) return;

		// Unsaved work is queued or in flight: hold the navigation until it is
		// durable, then replay it.
		navigation.cancel();
		session
			.flush()
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
			.catch(() => {
				// Flush failed: stay on the page so the user sees the error state.
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

	<div class="mt-2 flex items-center justify-between gap-3">
		<span class="min-w-0 truncate text-xs text-muted-foreground">{saveError ?? statusText}</span>
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
