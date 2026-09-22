// @ts-nocheck
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	containsPendingImageUpload,
	getUploadCompletionDrain,
	isContentEffectivelyEmpty,
	isMediaSetStable,
	isWorkMemoContentStable,
	shouldPersistContent
} from './workMemoContent.ts';

describe('work memo content helpers', () => {
	it('treats blank HTML and non-breaking whitespace as empty', () => {
		assert.equal(isContentEffectivelyEmpty(''), true);
		assert.equal(isContentEffectivelyEmpty('<p> </p>'), true);
		assert.equal(isContentEffectivelyEmpty('<p>&nbsp;&#160;</p>'), true);
	});

	it('treats an image-only memo as meaningful content', () => {
		assert.equal(isContentEffectivelyEmpty('<img src="/api/v1/files/media/1/photo.png">'), false);
	});

	it('detects upload placeholders without flagging completed images', () => {
		assert.equal(
			containsPendingImageUpload('<img src="blob:test" data-uploading="true" data-placeholder-id="one">'),
			true
		);
		assert.equal(containsPendingImageUpload("<img data-uploading='true' src='blob:test'>"), true);
		assert.equal(containsPendingImageUpload('<img src="/api/v1/files/media/1/photo.png">'), false);
	});

	it('detects markerless blob images with double or single quoted src attributes', () => {
		assert.equal(containsPendingImageUpload('<img src="blob:https://example.test/one">'), true);
		assert.equal(containsPendingImageUpload("<img alt='x' src='blob:https://example.test/two'>"), true);
	});

	it('does not mistake blob text outside an image src for an upload', () => {
		assert.equal(containsPendingImageUpload('<p>blob:https://example.test/not-an-image</p>'), false);
		assert.equal(containsPendingImageUpload('<img alt="blob:test" src="/durable.png">'), false);
	});
});

describe('shouldPersistContent (save guard)', () => {
	it('blocks persistence while a blob upload placeholder is present', () => {
		// This is the R1 guard: pending images must never be saved as snapshots.
		assert.equal(
			shouldPersistContent('<img src="blob:test" data-uploading="true" data-placeholder-id="one">'),
			false
		);
	});

	it('allows persistence once the image URL is durable', () => {
		assert.equal(shouldPersistContent('<img src="/api/v1/files/media/1/photo.png">'), true);
		assert.equal(shouldPersistContent('<p>hello</p>'), true);
	});

	it('blocks persistence from the real upload count after a placeholder was deleted', () => {
		assert.equal(shouldPersistContent('<p>still editing</p>', 1), false);
		assert.equal(isWorkMemoContentStable('<p>still editing</p>', 1), false);
	});

	it('blocks markerless blob snapshots', () => {
		assert.equal(shouldPersistContent('<img src="blob:test">', 0), false);
		assert.equal(shouldPersistContent("<img src='blob:test'>", 0), false);
		assert.equal(shouldPersistContent('<img alt="x" src="blob:test">', 0), false);
	});
});

describe('isMediaSetStable (reconciliation guard)', () => {
	it('blocks association reconciliation while an upload placeholder is pending', () => {
		assert.equal(
			isMediaSetStable('<img src="blob:test" data-uploading="true" data-placeholder-id="one">'),
			false
		);
	});

	it('allows reconciliation for stable media and plain text', () => {
		assert.equal(isMediaSetStable('<img data-media-id="m1" src="/api/v1/files/media/1/p.png">'), true);
		assert.equal(isMediaSetStable('<p>ordinary typing</p>'), true);
		assert.equal(isMediaSetStable(''), true);
	});

	it('uses the same upload-count and markerless-blob guard as persistence', () => {
		assert.equal(isMediaSetStable('<p>marker deleted</p>', 1), false);
		assert.equal(isMediaSetStable('<img src="blob:test">', 0), false);
	});
});

describe('getUploadCompletionDrain', () => {
	it('drains save and reconciliation for an existing memo on the final upload completion', () => {
		assert.deepEqual(
			getUploadCompletionDrain(
				1,
				0,
				'<img data-media-id="m1" src="/api/v1/files/media/m1/photo.png">',
				true
			),
			{ save: true, reconcile: true }
		);
	});

	it('drains only save for a new memo and leaves associations to the edit route', () => {
		assert.deepEqual(getUploadCompletionDrain(1, 0, '<p>new memo</p>', false), {
			save: true,
			reconcile: false
		});
	});

	it('does not drain early, twice, or while the final HTML is still unstable', () => {
		assert.deepEqual(getUploadCompletionDrain(2, 1, '<p>one upload remains</p>', true), {
			save: false,
			reconcile: false
		});
		assert.deepEqual(getUploadCompletionDrain(0, 0, '<p>already drained</p>', true), {
			save: false,
			reconcile: false
		});
		assert.deepEqual(getUploadCompletionDrain(1, 0, '<img src="blob:test">', true), {
			save: false,
			reconcile: false
		});
	});

	it('allows the deferred status/pin snapshot once the same guard becomes stable', () => {
		assert.equal(shouldPersistContent('<p>body unchanged</p>', 1), false);
		const drain = getUploadCompletionDrain(1, 0, '<p>body unchanged</p>', true);
		assert.equal(drain.save, true);
	});
});
