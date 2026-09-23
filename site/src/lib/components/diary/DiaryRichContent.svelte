<script lang="ts">
	/**
	 * Read-only rendering of a stored rich body.
	 *
	 * The body is HTML this app's editor produced, but the API accepts any
	 * string, so "the editor produced it" is a client-side assumption and not a
	 * trust boundary. Every body is therefore run through
	 * `sanitizeDiaryRichContent` immediately before `{@html}`: script, style,
	 * iframe, svg, object and embed elements, `on*` handlers, dangerous URIs and
	 * any unauthorised `style` are removed, while everything the editor really
	 * emits — paragraphs, headings, lists, task lists, links, images with their
	 * `data-media-id`, highlights and code blocks — is preserved byte for byte.
	 *
	 * The sanitizer is purely subtractive and the stored body is never written
	 * back, so no migration is needed and no row can be reformatted by a read.
	 * This component is the single execution boundary, which is why the call
	 * lives here rather than on the way in.
	 *
	 * The rendered markup keeps the `tiptap-editor-content` class the Book view
	 * uses, so all existing styling applies unchanged.
	 */
	import { sanitizeDiaryRichContent } from './diaryRichContentSanitizer';

	interface Props {
		html: string;
		/** Rendered when there is no content at all. */
		fallback?: string;
	}

	let { html, fallback = '' }: Props = $props();

	const safeHtml = $derived(sanitizeDiaryRichContent(html));
</script>

{#if html}
	<div class="tiptap-editor-content">{@html safeHtml}</div>
{:else if fallback}
	<p class="text-sm text-muted-foreground/70">{fallback}</p>
{/if}
