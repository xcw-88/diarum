<script lang="ts">
	/**
	 * Read-only rendering of a stored TipTap body.
	 *
	 * The body is HTML produced by this app's own editor and is rendered with the
	 * same `tiptap-editor-content` class the Book view uses, so paragraphs,
	 * headings, lists, task lists, images, links, underline/highlight and code
	 * blocks all keep their existing styling. This is the project's established
	 * read-only path (`PageFace.svelte`) — no new HTML execution route is added.
	 */
	interface Props {
		html: string;
		/** Rendered when there is no content at all. */
		fallback?: string;
	}

	let { html, fallback = '' }: Props = $props();
</script>

{#if html}
	<div class="tiptap-editor-content">{@html html}</div>
{:else if fallback}
	<p class="text-sm text-muted-foreground/70">{fallback}</p>
{/if}
