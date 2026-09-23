<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto, beforeNavigate } from '$app/navigation';
	import { page } from '$app/stores';
	import { t } from '$lib/i18n';
	import TiptapEditor from '$lib/components/editor/TiptapEditor.svelte';
	import {
		createWorkMemo,
		updateWorkMemo,
		deleteWorkMemo,
		type WorkMemo,
		type WorkMemoStatus
	} from '$lib/api/workMemos';
	import { getToday, formatWorklogHeaderDate } from '$lib/utils/date';
	import type { ImageUploadState } from './workMemoImageUploadGate';
	import { attachWorkMemoMedia, detachWorkMemoMedia, listWorkMemoMedia } from '$lib/api/workMemoMedia';
	import type { SaveMachineState } from './workMemoSaveMachine';
	import { WorkMemoEditingSession } from './workMemoEditingSession';
	import { getPopstateReplayDelta } from './replayPopstate';

	interface Props {
		memo?: WorkMemo | null;
		date: string;
		mode: 'new' | 'edit';
	}

	let { memo = null, date, mode }: Props = $props();

	// Display mirrors of the session's snapshot. The session is seeded from the
	// same values in `onMount`; keeping the mirror as an effect rather than as a
	// `$state(...)` initialiser is deliberate, so that a `memo` prop change is
	// still reflected on screen exactly as before.
	let content = $state('');
	let status = $state<WorkMemoStatus>('normal');
	let isPinned = $state(false);

	$effect(() => {
		content = memo?.content || '';
		status = memo?.status || 'normal';
		isPinned = memo?.is_pinned || false;
	});

	let machineState = $state<SaveMachineState | null>(null);
	let showMenu = $state(false);
	let showDeleteConfirm = $state(false);

	/**
	 * The single owner of the autosave / image-upload / media-reconciliation
	 * orchestration, shared with the inline diary event editor so the two do not
	 * fork. It drives `WorkMemoSaveMachine`, `WorkMemoImageUploadGate`,
	 * `WorkMemoMediaReconciler` and the `workMemoContent` guards, which remain
	 * the only behaviour primitives.
	 */
	let session: WorkMemoEditingSession | null = null;

	// Prevents beforeNavigate from re-flushing a navigation that we initiated.
	let isReplayingNavigation = $state(false);

	const SAVE_DEBOUNCE_MS = 800;

	function handleContentChange(newContent: string) {
		content = newContent;
		session?.handleContentChange(newContent);
	}

	function handleImageUploadStateChange(state: ImageUploadState) {
		session?.handleImageUploadStateChange(state);
	}

	async function flushEditor(): Promise<void> {
		await (session?.flush() ?? Promise.resolve());
	}

	function handleStatusChange(newStatus: WorkMemoStatus) {
		status = newStatus;
		showMenu = false;
		// Status/pin may still be toggled during an in-flight image upload; the
		// session defers the save until the durable image URL replaces the blob.
		session?.setStatus(newStatus);
	}

	function handlePinToggle() {
		isPinned = !isPinned;
		showMenu = false;
		session?.setPinned(isPinned);
	}

	function handleBack() {
		const targetDate = date || getToday();
		if (typeof window !== 'undefined' && window.history.length > 1) {
			window.history.back();
		} else {
			goto(`/worklog/${targetDate}`, { replaceState: true });
		}
	}

	function handleDeleteClick() {
		showMenu = false;
		showDeleteConfirm = true;
	}

	async function confirmDelete() {
		showDeleteConfirm = false;
		if (!session) {
			handleBack();
			return;
		}
		try {
			// Only the upload gate, so a failed upload keeps its own message
			// instead of being reported as a failed delete.
			await session.waitForUploads();
		} catch {
			window.alert($t('worklog.imageUploadFailed'));
			return;
		}
		const ok = await session.delete();
		if (!ok) {
			window.alert($t('worklog.deleteFailed'));
			return;
		}
		handleBack();
	}

	function cancelDelete() {
		showDeleteConfirm = false;
	}

	function closeMenu() {
		showMenu = false;
	}

	beforeNavigate((navigation) => {
		if (isReplayingNavigation) {
			isReplayingNavigation = false;
			return;
		}
		if (navigation.to?.url.pathname === $page.url.pathname) return;

		// Single flush entry for all application navigation.
		navigation.cancel();
		const flushPromise = flushEditor();
		flushPromise
			.then(() => {
				isReplayingNavigation = true;
				if (navigation.type === 'popstate') {
					window.history.go(getPopstateReplayDelta(navigation.delta));
				} else {
					goto(navigation.to?.url.pathname ?? `/worklog/${date}`);
				}
			})
			.catch(() => {
				// Flush failed (network/validation). Stay on the editor page so the
				// user sees the error state and can retry. The machine has already
				// set phase to 'error' and error message via onStateChange.
			});
	});

	onMount(() => {
		function handleClickOutside(event: MouseEvent) {
			const target = event.target as HTMLElement;
			if (showMenu && !target.closest('[data-menu]')) {
				showMenu = false;
			}
		}
		document.addEventListener('click', handleClickOutside);

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
			onCreated: (id) => {
				// The /new component must not mutate associations after it starts
				// navigation: this `goto` unmounts it. The edit route owns exactly
				// one initial forced reconciliation, which is why the session must
				// not run its own post-create pass here.
				goto(`/worklog/${date}/${id}`, { replaceState: true });
			},
			reconcileOnCreate: false,
			onStateChange: (state) => {
				machineState = state;
			}
		});

		session = s;
		machineState = s.getState();

		return () => {
			document.removeEventListener('click', handleClickOutside);
		};
	});

	onDestroy(() => {
		session?.destroy();
		session = null;
	});
</script>

<svelte:head>
	<title>{mode === 'new' ? $t('worklog.newTitle') : $t('worklog.editTitle')} - {$t('worklog.pageTitle')}</title>
</svelte:head>

<div class="min-h-screen bg-background flex flex-col">
	<!-- Top navigation bar -->
	<header class="sticky top-0 z-30 glass border-b border-border/50">
		<div class="mx-auto max-w-3xl px-4">
			<div class="relative flex h-14 items-center justify-between gap-3">
				<button
					type="button"
					class="flex items-center gap-1 p-2 -ml-2 rounded-lg text-foreground hover:bg-muted transition-colors"
					onclick={handleBack}
					aria-label={$t('worklog.back')}
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
					</svg>
					<span class="text-sm font-medium">{$t('worklog.back')}</span>
				</button>

				<div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-sm font-semibold text-foreground pointer-events-none">
					{formatWorklogHeaderDate(date)}
				</div>

				<div class="flex items-center gap-2">
					<!-- Save status -->
					<span class="text-xs text-muted-foreground tabular-nums min-w-[3.5rem] text-right">
						{#if machineState?.phase === 'saving'}
							{$t('worklog.saving')}
						{:else if machineState?.phase === 'saved'}
							{$t('worklog.saved')}
						{:else if machineState?.phase === 'error'}
							{$t('worklog.saveFailedShort')}
						{/if}
					</span>

					<!-- More menu -->
					<div class="relative" data-menu>
						<button
							type="button"
							class="p-2 rounded-full hover:bg-muted transition-colors text-foreground"
							onclick={() => showMenu = !showMenu}
							aria-haspopup="true"
							aria-expanded={showMenu}
							aria-label={$t('worklog.more')}
						>
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
							</svg>
						</button>

						{#if showMenu}
							<div class="absolute right-0 top-full mt-1 w-48 rounded-xl border border-border/50 bg-card shadow-lg py-1 z-50 animate-fade-in">
								<div class="px-3 py-2 text-xs font-medium text-muted-foreground">{$t('worklog.statusLabel')}</div>
								<button
									type="button"
									class="w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-muted transition-colors"
									onclick={() => handleStatusChange('normal')}
								>
									<span>{$t('worklog.statusNormal')}</span>
									{#if status === 'normal'}
										<svg class="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
									{/if}
								</button>
								<button
									type="button"
									class="w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-muted transition-colors"
									onclick={() => handleStatusChange('pending')}
								>
									<span>{$t('worklog.statusPending')}</span>
									{#if status === 'pending'}
										<svg class="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
									{/if}
								</button>
								<button
									type="button"
									class="w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-muted transition-colors"
									onclick={() => handleStatusChange('completed')}
								>
									<span>{$t('worklog.statusCompleted')}</span>
									{#if status === 'completed'}
										<svg class="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
									{/if}
								</button>

								<div class="my-1 border-t border-border/50"></div>

								<button
									type="button"
									class="w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-muted transition-colors"
									onclick={handlePinToggle}
								>
									<span>{isPinned ? $t('worklog.unpin') : $t('worklog.pin')}</span>
									{#if isPinned}
										<svg class="h-4 w-4 text-primary" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" /></svg>
									{/if}
								</button>

								{#if mode === 'edit' || machineState?.memoId}
									<div class="my-1 border-t border-border/50"></div>
									<button
										type="button"
										class="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
										onclick={handleDeleteClick}
									>
										{$t('worklog.delete')}
									</button>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>
	</header>

	<!-- Editor -->
	<main class="flex-1 flex flex-col overflow-hidden">
		<div class="flex-1 overflow-y-auto">
			<div class="mx-auto max-w-3xl h-full">
				<TiptapEditor
					{content}
					onChange={handleContentChange}
					placeholder={$t('worklog.editorPlaceholder')}
					commandPlaceholder={$t('worklog.editorPlaceholder')}
					emptyStatePrompt={$t('worklog.editorEmptyPrompt')}
					emptyStateAlignTop={true}
					allowImages={true}
					showImageActions={true}
					uploadImageLabel={$t('worklog.addImage')}
					chooseFromGalleryLabel={$t('worklog.chooseFromGallery')}
					onImageUploadStateChange={handleImageUploadStateChange}
					associateWithDiary={false}
				/>
			</div>
		</div>
	</main>
</div>

{#if showDeleteConfirm}
	<div class="fixed inset-0 z-[60] flex items-center justify-center px-4" role="alertdialog" aria-modal="true" aria-labelledby="worklog-delete-title">
		<button
			type="button"
			class="absolute inset-0 bg-black/50 backdrop-blur-sm"
			onclick={cancelDelete}
			aria-label={$t('common.cancel')}
		></button>
		<div class="relative w-full max-w-sm bg-card rounded-2xl shadow-2xl p-5 animate-fade-in">
			<h3 id="worklog-delete-title" class="text-base font-semibold text-foreground mb-2">{$t('worklog.deleteConfirmTitle')}</h3>
			<p class="text-sm text-muted-foreground mb-5">{$t('worklog.deleteConfirmBody')}</p>
			<div class="flex items-center justify-end gap-2">
				<button
					type="button"
					class="px-4 py-2 text-sm font-medium rounded-lg text-muted-foreground hover:bg-muted transition-colors"
					onclick={cancelDelete}
				>
					{$t('common.cancel')}
				</button>
				<button
					type="button"
					class="px-4 py-2 text-sm font-medium rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
					onclick={confirmDelete}
				>
					{$t('worklog.delete')}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	:global(.tiptap-editor) {
		min-height: calc(100vh - 3.5rem) !important;
		border: none !important;
		background: transparent !important;
	}

	:global(.editor-container) {
		min-height: calc(100vh - 3.5rem) !important;
		padding: 1rem;
	}

	@keyframes fade-in {
		from { opacity: 0; transform: scale(0.98); }
		to { opacity: 1; transform: scale(1); }
	}

	.animate-fade-in {
		animation: fade-in 0.15s ease-out;
	}
</style>
