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
	import {
		getUploadCompletionDrain,
		isContentEffectivelyEmpty,
		isMediaSetStable,
		shouldPersistContent
	} from './workMemoContent';
	import { WorkMemoImageUploadGate, type ImageUploadState } from './workMemoImageUploadGate';
	import { WorkMemoMediaReconciler, extractDataMediaIds } from './workMemoMediaAssociation';
	import { attachWorkMemoMedia, detachWorkMemoMedia, listWorkMemoMedia } from '$lib/api/workMemoMedia';
	import {
		WorkMemoSaveMachine,
		type SaveMachineState,
		type WorkMemoSnapshot
	} from './workMemoSaveMachine';
	import { getPopstateReplayDelta } from './replayPopstate';

	interface Props {
		memo?: WorkMemo | null;
		date: string;
		mode: 'new' | 'edit';
	}

	let { memo = null, date, mode }: Props = $props();

	let content = $state('');
	let status = $state<WorkMemoStatus>('normal');
	let isPinned = $state(false);

	let machine = $state<WorkMemoSaveMachine | null>(null);
	const imageUploadGate = new WorkMemoImageUploadGate();
	let pendingImageUploadCount = $state(0);
	// Brings the server's association set back in line with the body's stable
	// data-media-id set. Only media-set changes reach it; plain typing, status
	// and pin changes never do.
	const mediaReconciler = new WorkMemoMediaReconciler({
		list: listWorkMemoMedia,
		attach: attachWorkMemoMedia,
		detach: detachWorkMemoMedia
	});

	$effect(() => {
		content = memo?.content || '';
		status = memo?.status || 'normal';
		isPinned = memo?.is_pinned || false;
	});
	let machineState = $state<SaveMachineState | null>(null);
	let showMenu = $state(false);
	let showDeleteConfirm = $state(false);

	// Prevents beforeNavigate from re-flushing a navigation that we initiated.
	let isReplayingNavigation = $state(false);

	const SAVE_DEBOUNCE_MS = 800;

	function buildSnapshot(): WorkMemoSnapshot {
		return { content, status, isPinned };
	}

	function scheduleSave() {
		machine?.schedule(buildSnapshot());
	}

	// Single guarded entry point for every ordinary save. While an image upload
	// placeholder (blob URL) is still in the content, the snapshot must NOT be
	// persisted — the durable URL arrives via a later content update.
	function scheduleSaveWhenContentStable() {
		if (!shouldPersistContent(content, pendingImageUploadCount)) return;
		scheduleSave();
	}

	function handleContentChange(newContent: string) {
		content = newContent;
		scheduleSaveWhenContentStable();
		reconcileMediaAssociations(newContent);
	}

	// Association bookkeeping is driven ONLY by the set of stable data-media-id
	// values in the body. While an upload placeholder is present the media set
	// is not final, so the pass is skipped; the reconciler itself is a no-op
	// when no memo id exists yet and when the media set is unchanged — so
	// ordinary typing issues no request at all.
	function reconcileMediaAssociations(source: string, options: { force?: boolean } = {}) {
		if (!isMediaSetStable(source, pendingImageUploadCount)) return;
		void mediaReconciler.reconcile(extractDataMediaIds(source), options);
	}

	function handleImageUploadStateChange(state: ImageUploadState) {
		const previousPending = pendingImageUploadCount;
		pendingImageUploadCount = Math.max(0, state.pending);
		imageUploadGate.update(state);

		// Replacement/removal on the editor side fires onChange before the
		// upload counter reaches zero, so that update is deliberately blocked.
		// The final >0 -> 0 transition drains the latest stable editor state.
		const drain = getUploadCompletionDrain(
			previousPending,
			pendingImageUploadCount,
			content,
			mediaReconciler.memoId !== null
		);
		if (drain.save) scheduleSaveWhenContentStable();
		if (drain.reconcile) reconcileMediaAssociations(content);
	}

	async function flushEditor(): Promise<void> {
		await imageUploadGate.wait();
		await (machine?.flush() ?? Promise.resolve());
	}

	function handleStatusChange(newStatus: WorkMemoStatus) {
		status = newStatus;
		showMenu = false;
		// Status/pin may still be toggled during an in-flight image upload; we
		// just defer the save until the durable image URL replaces the blob.
		scheduleSaveWhenContentStable();
	}

	function handlePinToggle() {
		isPinned = !isPinned;
		showMenu = false;
		scheduleSaveWhenContentStable();
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
		if (!machine) {
			handleBack();
			return;
		}
		try {
			await imageUploadGate.wait();
		} catch {
			window.alert($t('worklog.imageUploadFailed'));
			return;
		}
		const ok = await machine.delete();
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

		const initialSnapshot: WorkMemoSnapshot = {
			content: memo?.content || '',
			status: memo?.status || 'normal',
			isPinned: memo?.is_pinned || false
		};

		const m = new WorkMemoSaveMachine({
			date,
			memoId: memo?.id ?? null,
			initialSnapshot,
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
			onCreated: (id) => {
				// The old /new component must not mutate associations after it starts
				// navigation. The edit route owns one initial forced reconciliation.
				goto(`/worklog/${date}/${id}`, { replaceState: true });
			},
			onStateChange: (state) => {
				machineState = state;
			},
			debounceMs: SAVE_DEBOUNCE_MS,
			emptyContentPredicate: isContentEffectivelyEmpty
		});

		machine = m;
		machineState = m.getState();

		// Existing memo (including a memo just created on /new): the body is the
		// sole desired-state source and this initial pass repairs associations.
		if (memo?.id) {
			mediaReconciler.setMemoId(memo.id);
			// Initial recovery: the body may reference media whose association was
			// lost by an earlier failed attach, and the server may hold
			// associations the body no longer references. The memo's own content is
			// the source of truth, so this never depends on reactive timing.
			reconcileMediaAssociations(memo.content ?? '', { force: true });
		}

		return () => {
			document.removeEventListener('click', handleClickOutside);
			m.destroy();
		};
	});

	onDestroy(() => {
		mediaReconciler.invalidate();
		machine?.destroy();
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
