const EMBEDDED_MEDIA_PATTERN = /<(img|video|audio|iframe|embed|object|svg|canvas)\b[^>]*>/i;
const PENDING_IMAGE_PATTERN = /<img\b[^>]*\bdata-uploading\s*=\s*(["'])?true\1?[^>]*>/i;
const BLOB_IMAGE_PATTERN = /<img\b[^>]*\bsrc\s*=\s*(["'])blob:[^"']*\1[^>]*>/i;

export function isContentEffectivelyEmpty(html: string): boolean {
	if (!html) return true;
	const normalized = html.replace(/&nbsp;|&#160;/gi, ' ').trim();
	if (!normalized) return true;
	if (EMBEDDED_MEDIA_PATTERN.test(normalized)) return false;
	return normalized.replace(/<[^>]*>/g, '').trim().length === 0;
}

export function containsPendingImageUpload(html: string): boolean {
	return PENDING_IMAGE_PATTERN.test(html) || BLOB_IMAGE_PATTERN.test(html);
}

/**
 * A Work Memo snapshot is stable only after every real upload has settled and
 * no temporary image representation remains in the serialized editor HTML.
 * The numeric upload count is required because a user can delete a placeholder
 * node while its network upload is still in flight.
 */
export function isWorkMemoContentStable(html: string, pendingImageUploadCount: number): boolean {
	return pendingImageUploadCount === 0 && !containsPendingImageUpload(html);
}

/**
 * Whether the current content is safe to persist. While an image upload
 * placeholder (blob URL) is still present, the snapshot must be deferred until
 * the durable image URL arrives. This is the save guard used by every ordinary
 * save entry point in WorkMemoEditor.
 */
export function shouldPersistContent(html: string, pendingImageUploadCount = 0): boolean {
	return isWorkMemoContentStable(html, pendingImageUploadCount);
}

/**
 * Whether the content is a *stable media state* that may be reconciled against
 * the server's Work Memo Media associations.
 *
 * While a blob-backed upload placeholder is still in the body the media set is
 * not final: a node is about to be replaced by the durable image (with its real
 * data-media-id) or removed on upload failure. Reconciliation must wait for that
 * to settle, so it is gated by the same rule as the save guard rather than by a
 * second, independent gate.
 */
export function isMediaSetStable(html: string, pendingImageUploadCount = 0): boolean {
	return isWorkMemoContentStable(html, pendingImageUploadCount);
}

export interface UploadCompletionDrain {
	save: boolean;
	reconcile: boolean;
}

/**
 * Decide whether the transition that completes the final real upload must
 * drain deferred editor work. New memos save their stable body and let the
 * edit route's initial reconciliation create associations; existing memos do
 * both operations immediately.
 */
export function getUploadCompletionDrain(
	previousPending: number,
	currentPending: number,
	html: string,
	hasMemoId: boolean
): UploadCompletionDrain {
	const shouldDrain =
		previousPending > 0 &&
		currentPending === 0 &&
		isWorkMemoContentStable(html, currentPending);
	return {
		save: shouldDrain,
		reconcile: shouldDrain && hasMemoId
	};
}
