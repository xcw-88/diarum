<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Editor } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Placeholder from '@tiptap/extension-placeholder';
	import { ImageExtension } from './ImageNodeView';
	import Link from '@tiptap/extension-link';
	import Underline from '@tiptap/extension-underline';
	import Highlight from '@tiptap/extension-highlight';
	import TaskList from '@tiptap/extension-task-list';
	import TaskItem from '@tiptap/extension-task-item';
	import CharacterCount from '@tiptap/extension-character-count';
	import Typography from '@tiptap/extension-typography';
	import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
	import Focus from '@tiptap/extension-focus';
	import { common, createLowlight } from 'lowlight';
	import { DOMSerializer } from '@tiptap/pm/model';
	import { uploadImage, getMediaUrl, isCheveretoResult } from '$lib/utils/uploadImage';
	import { extractCommittableMediaId } from '$lib/components/worklog/workMemoMediaAssociation';
	import { SlashCommands } from './SlashCommands';
	import { getSuggestionItems, setImageUploadTrigger, setGalleryPickerTrigger, clearImageUploadTrigger, clearGalleryPickerTrigger } from './commands';
	import { suggestionRenderer, showCommandMenu } from './suggestionRenderer';
	import MediaPicker from './MediaPicker.svelte';
	import { getMediaFileUrl, addMediaDiary } from '$lib/api/media';
	import type { MediaWithDiary } from '$lib/api/media';

	export let content = '';
	export let onChange: (value: string) => void = () => {};
	export let placeholder = 'Start writing...';
	export let commandPlaceholder = 'Type / to browse options';
	export let diaryDate: string | undefined = undefined;
	export let selectedContent: string = '';
	export let emptyStatePrompt: string = '';
	export let emptyStateAlignTop = false;
	export let allowImages = true;
	export let showImageActions = false;
	export let uploadImageLabel = 'Add image';
	export let chooseFromGalleryLabel = 'Choose from library';
	export let onImageUploadStateChange: (state: { pending: number; error: string | null }) => void = () => {};
	// When false, selecting an image from the media library will NOT associate
	// the media with the current Diary. Work Memo editors pass false; the Diary
	// editor keeps the default (true) to preserve original behavior.
	export let associateWithDiary = true;

	let editorElement: HTMLDivElement;
	let editor: Editor | null = null;
	let fileInput: HTMLInputElement;
	let uploadError = '';
	let uploadErrorTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingImageUploads = 0;
	let showMediaPicker = false;
	let isFocused = false;

	// Add button state
	let showAddButton = false;
	let addButtonTop = 0;

	const lowlight = createLowlight(common);

	// Image upload config
	const IMAGE_CONFIG = {
		maxSize: 50 * 1024 * 1024, // 50MB
		allowedTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
	};

	function showUploadError(message: string) {
		uploadError = message;
		if (uploadErrorTimer) clearTimeout(uploadErrorTimer);
		uploadErrorTimer = setTimeout(() => (uploadError = ''), 3000);
	}

	function publishImageUploadState(error: string | null = null) {
		onImageUploadStateChange({ pending: pendingImageUploads, error });
	}

	// Validate image file
	function validateImageFile(file: File): string | null {
		if (!IMAGE_CONFIG.allowedTypes.includes(file.type)) {
			return `Unsupported image format. Please use JPG, PNG, GIF or WebP`;
		}
		if (file.size > IMAGE_CONFIG.maxSize) {
			const maxMB = IMAGE_CONFIG.maxSize / 1024 / 1024;
			return `Image size cannot exceed ${maxMB}MB`;
		}
		return null;
	}

	// Generate unique placeholder ID
	function generatePlaceholderId(): string {
		return `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	}

	// Handle image upload with placeholder
	async function handleImageUploadWithPlaceholder(file: File): Promise<void> {
		if (!editor || editor.isDestroyed) return;

		// Validate file
		const validationError = validateImageFile(file);
		if (validationError) {
			showUploadError(validationError);
			return;
		}

		const placeholderId = generatePlaceholderId();

		// Insert placeholder with preview
		editor.chain().focus().setImagePlaceholder({ id: placeholderId, file }).run();

		uploadError = '';
		pendingImageUploads += 1;
		publishImageUploadState();
		let failureMessage: string | null = null;

		try {
			const result = await uploadImage(file, { diaryDate });
			let url: string;

			if (isCheveretoResult(result)) {
				url = result.cheveretoUrl;
			} else {
				url = getMediaUrl(result);
			}

			// Replace placeholder with the durable URL before allowing navigation
			// or Worklog autosave to continue.
			if (!editor || editor.isDestroyed) return;
			const committedMediaId = extractCommittableMediaId(result);
			const replaced = editor.commands.replacePlaceholderWithImage({
				id: placeholderId,
				src: url,
				alt: file.name,
				mediaId: committedMediaId ?? undefined,
			});
			// The user may delete the placeholder while the upload is in flight.
			// In that case the durable upload is intentionally left unattached and
			// must not be reinserted into the document.
			if (!replaced) return;
		} catch (error) {
			console.error('Image upload failed:', error);
			failureMessage = 'Image upload failed, please try again';
			showUploadError(failureMessage);

			// Remove placeholder on error
			if (editor && !editor.isDestroyed) editor.commands.removePlaceholder(placeholderId);
		} finally {
			pendingImageUploads = Math.max(0, pendingImageUploads - 1);
			publishImageUploadState(failureMessage);
		}
	}

// Handle paste event
function handlePaste(view: any, event: ClipboardEvent) {
	if (!allowImages) return false;
	const items = event.clipboardData?.items;
	if (!items) return false;

	const files: File[] = [];
	for (const item of items) {
		if (item.type.startsWith('image/')) {
			const file = item.getAsFile();
			if (file) files.push(file);
		}
	}
	if (files.length === 0) return false;
	event.preventDefault();
	for (const file of files) void handleImageUploadWithPlaceholder(file);
	return true;
}

// Handle drop event
function handleDrop(view: any, event: DragEvent) {
	if (!allowImages) return false;
	const files = event.dataTransfer?.files;
	if (!files || files.length === 0) return false;

	const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
	if (imageFiles.length === 0) return false;
	event.preventDefault();
	for (const file of imageFiles) void handleImageUploadWithPlaceholder(file);
	return true;
}

	// Handle slash command image trigger
	function handleSlashImage() {
		fileInput?.click();
	}

	// Handle gallery picker trigger
	function handleGalleryPicker() {
		showMediaPicker = true;
	}

	// Handle media selection from gallery
	async function handleMediaSelect(media: MediaWithDiary) {
		if (!editor) return;

		const url = getMediaFileUrl(media);
		const committedMediaId = extractCommittableMediaId(media);
		editor.chain().focus().setImage({ src: url, mediaId: committedMediaId ?? undefined }).run();

		// Associate media with the current Diary only when explicitly enabled.
		// Work Memo editors opt out so picking an image never links it to a Diary.
		if (associateWithDiary && diaryDate && media.id) {
			try {
				const { getOrCreateDiaryId } = await import('$lib/utils/uploadImage');
				const diaryId = await getOrCreateDiaryId(diaryDate);
				if (diaryId) {
					await addMediaDiary(media.id, diaryId);
				}
			} catch (error) {
				console.error('Failed to associate media with diary:', error);
			}
		}
	}

function handleFileSelect(event: Event) {
	if (!allowImages) return;
	const input = event.target as HTMLInputElement;
	const files = Array.from(input.files ?? []);
	for (const file of files) void handleImageUploadWithPlaceholder(file);
	input.value = '';
}

	// Get HTML of current selection
	function getSelectionHtml(): string {
		if (!editor) return '';
		const { from, to, empty } = editor.state.selection;
		if (empty) return '';
		const { schema, doc } = editor.state;
		const slice = doc.slice(from, to);
		const div = document.createElement('div');
		const serializer = DOMSerializer.fromSchema(schema);
		const fragment = serializer.serializeFragment(slice.content);
		div.appendChild(fragment);
		return div.innerHTML;
	}

	// Update add button position based on cursor
	function updateAddButton() {
		if (!editor || !editorElement) {
			showAddButton = false;
			return;
		}

		const { selection } = editor.state;
		const { $from } = selection;
		const node = $from.parent;

		// Show only on empty paragraph
		if (node.type.name === 'paragraph' && node.content.size === 0) {
			const coords = editor.view.coordsAtPos($from.pos);
			const editorRect = editorElement.getBoundingClientRect();
			addButtonTop = coords.top - editorRect.top;
			showAddButton = true;
		} else {
			showAddButton = false;
		}
	}

	// Handle add button click
	let addButtonEl: HTMLButtonElement;
	function handleAddClick() {
		if (!editor || !addButtonEl) return;
		editor.commands.focus();
		showCommandMenu(editor, addButtonEl);
	}

	onMount(() => {
		if (allowImages) {
			// Register image upload trigger for slash commands
			setImageUploadTrigger(handleSlashImage);
			// Register gallery picker trigger for slash commands
			setGalleryPickerTrigger(handleGalleryPicker);
		}

		editor = new Editor({
			element: editorElement,
			extensions: [
				StarterKit.configure({
					codeBlock: false,
				}),
				Placeholder.configure({
					placeholder: ({ node }) => {
						if (node.type.name === 'paragraph') {
							return commandPlaceholder;
						}
						return placeholder;
					},
					showOnlyCurrent: true,
				}),
				ImageExtension.configure({
					inline: false,
					allowBase64: true,
				}),
				Focus.configure({
					className: 'has-focus',
					mode: 'all',
				}),
				Link.configure({
					openOnClick: false,
				}),
				Underline,
				Highlight.configure({
					multicolor: true,
				}),
				TaskList,
				TaskItem.configure({
					nested: true,
				}),
				CharacterCount,
				Typography,
				CodeBlockLowlight.configure({
					lowlight,
				}),
				SlashCommands.configure({
					suggestion: {
						items: ({ query }: { query: string }) => getSuggestionItems(query),
						render: () => suggestionRenderer,
					},
				}),
			],
			content,
			editorProps: {
				handlePaste,
				handleDrop,
				attributes: {
					class: 'tiptap-editor-content',
				},
			},
			onUpdate: ({ editor }) => {
				onChange(editor.getHTML());
			},
			onTransaction: () => {
				editor = editor;
				updateAddButton();
				selectedContent = getSelectionHtml();
			},
			onFocus: () => {
				isFocused = true;
			},
			onBlur: () => {
				isFocused = false;
			},
		});

		// When the user deselects outside the editor, Tiptap's onTransaction
		// doesn't fire, so we rely on the native selectionchange event to clear.
		function handleDocumentSelectionChange() {
			if (!editorElement) return;
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed || !editorElement.contains(sel.anchorNode)) {
				selectedContent = '';
			}
		}
		document.addEventListener('selectionchange', handleDocumentSelectionChange);

		return () => {
			document.removeEventListener('selectionchange', handleDocumentSelectionChange);
		};
	});

	onDestroy(() => {
		// Release the triggers only if this instance still owns them. A blanket
		// `set...(null)` would also clear the handlers of a newer instance that
		// had already replaced ours, leaving that editor with a dead image
		// command. Hosts are still required to keep at most one image-capable
		// editor mounted at a time (see `diary/diaryEditorOwnership`); this is
		// the second line of defence, not a licence to overlap.
		if (allowImages) {
			clearImageUploadTrigger(handleSlashImage);
			clearGalleryPickerTrigger(handleGalleryPicker);
		}
		if (uploadErrorTimer) clearTimeout(uploadErrorTimer);
		editor?.destroy();
	});

	// Watch for external content changes
	$: if (editor) {
		const isSame = editor.getHTML() === content;
		if (!isSame) {
			editor.commands.setContent(content, false);
		}
	}
</script>

<div class="tiptap-editor">
	<div bind:this={editorElement} class="editor-container"></div>
	{#if emptyStatePrompt && !content && !isFocused}
		<button
			type="button"
			class="empty-state-overlay"
			class:align-top={emptyStateAlignTop}
			on:click={() => editor?.commands.focus()}
			aria-label="Focus editor"
		>
			<div class="text-center text-muted-foreground">
				<p class="text-sm">{emptyStatePrompt}</p>
			</div>
		</button>
	{/if}
	{#if showAddButton}
		<button
			bind:this={addButtonEl}
			type="button"
			class="add-button"
			style="top: {addButtonTop}px;"
			on:click={handleAddClick}
		>
			+
		</button>
	{/if}
	<input
		type="file"
		accept="image/*"
		multiple
		bind:this={fileInput}
		on:change={handleFileSelect}
		style="display: none;"
	/>
	{#if allowImages && showImageActions}
		<div class="image-actions" aria-label={uploadImageLabel}>
			<button type="button" class="image-action" on:click={handleSlashImage} aria-label={uploadImageLabel} title={uploadImageLabel}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
					<rect x="3" y="3" width="18" height="18" rx="2" />
					<circle cx="8.5" cy="8.5" r="1.5" />
					<path d="m21 15-5-5L5 21" />
				</svg>
				<span>{uploadImageLabel}</span>
			</button>
			<button type="button" class="image-action icon-only" on:click={handleGalleryPicker} aria-label={chooseFromGalleryLabel} title={chooseFromGalleryLabel}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
					<path d="M18 22H4a2 2 0 0 1-2-2V6" />
					<rect x="6" y="2" width="16" height="16" rx="2" />
					<circle cx="12" cy="8" r="2" />
					<path d="m22 13-2.5-2.5a2 2 0 0 0-2.83 0L12 15" />
				</svg>
			</button>
		</div>
	{/if}
	{#if uploadError}
		<div class="upload-error">{uploadError}</div>
	{/if}
</div>

{#if showMediaPicker}
	<MediaPicker
		onSelect={handleMediaSelect}
		onClose={() => showMediaPicker = false}
	/>
{/if}

<style>
	.tiptap-editor {
		position: relative;
		width: 100%;
		min-height: 500px;
	}

	.editor-container {
		min-height: 500px;
	}

	.add-button {
		position: absolute;
		left: 0;
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: none;
		color: hsl(var(--muted-foreground));
		font-size: 18px;
		font-weight: 300;
		cursor: pointer;
		opacity: 0.4;
		transition: opacity 0.15s ease;
		padding: 0;
	}

	.add-button:hover {
		opacity: 0.8;
	}

	.upload-error {
		position: fixed;
		bottom: 20px;
		right: 20px;
		background: hsl(0 84% 60%);
		color: white;
		padding: 12px 16px;
		border-radius: 8px;
		font-size: 14px;
		z-index: 1000;
		animation: slideIn 0.2s ease;
	}

	.image-actions {
		position: sticky;
		bottom: 0.75rem;
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0 1rem 0.75rem;
		pointer-events: none;
		z-index: 10;
	}

	.image-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		height: 2.5rem;
		padding: 0 0.85rem;
		border: 1px solid hsl(var(--border));
		border-radius: 9999px;
		background: hsl(var(--card));
		color: hsl(var(--foreground));
		box-shadow: 0 4px 14px hsl(var(--foreground) / 0.1);
		font-size: 0.8rem;
		font-weight: 500;
		pointer-events: auto;
	}

	.image-action:hover {
		background: hsl(var(--muted));
	}

	.image-action.icon-only {
		width: 2.5rem;
		padding: 0;
	}

	.image-action svg {
		width: 1rem;
		height: 1rem;
	}

	@keyframes slideIn {
		from {
			transform: translateX(100%);
			opacity: 0;
		}
		to {
			transform: translateX(0);
			opacity: 1;
		}
	}

	.empty-state-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		background: transparent;
		border: 0;
		padding: 0;
		cursor: text;
		pointer-events: auto;
	}

	.empty-state-overlay.align-top {
		align-items: flex-start;
		justify-content: flex-start;
		padding: 1rem;
	}
</style>
