// @ts-nocheck
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	durabilityFailureReason,
	durabilityMessageKey,
	shouldHoldNavigation
} from './diaryEventNavigation.ts';
import { WorkMemoDurabilityError } from '../worklog/workMemoDurability.ts';

describe('shouldHoldNavigation', () => {
	test('lets a navigation through when nothing is at stake', () => {
		assert.equal(
			shouldHoldNavigation({
				fromPathname: '/diary/2026-09-23',
				toPathname: '/diary/2026-09-22',
				hasDurabilityWork: false
			}),
			false
		);
	});

	test('holds a navigation that leaves the page while work is outstanding', () => {
		assert.equal(
			shouldHoldNavigation({
				fromPathname: '/diary/2026-09-23',
				toPathname: '/diary/2026-09-22',
				hasDurabilityWork: true
			}),
			true
		);
	});

	test('a same-path query or hash change is not held: it cannot unmount the editor', () => {
		for (const toPathname of ['/diary/2026-09-23', '/diary/2026-09-23']) {
			assert.equal(
				shouldHoldNavigation({
					fromPathname: '/diary/2026-09-23',
					toPathname,
					hasDurabilityWork: true
				}),
				false,
				'in-page anchors and query-only updates keep the route component mounted'
			);
		}
	});

	test('an unknown destination is held whenever work is outstanding', () => {
		assert.equal(
			shouldHoldNavigation({
				fromPathname: '/diary/2026-09-23',
				toPathname: null,
				hasDurabilityWork: true
			}),
			true,
			'the conservative answer when the router cannot say where we are going'
		);
		assert.equal(
			shouldHoldNavigation({
				fromPathname: '/diary/2026-09-23',
				toPathname: null,
				hasDurabilityWork: false
			}),
			false
		);
	});
});

describe('durability failure to message mapping', () => {
	test('an upload or placeholder failure is reported as an upload problem', () => {
		assert.equal(
			durabilityMessageKey(new WorkMemoDurabilityError('uploads', 'x')),
			'diaryEvents.uploadFailed'
		);
		assert.equal(
			durabilityMessageKey(new WorkMemoDurabilityError('body', 'x')),
			'diaryEvents.uploadFailed'
		);
	});

	test('an association failure is reported as an attachment problem, not a save problem', () => {
		assert.equal(
			durabilityMessageKey(new WorkMemoDurabilityError('attachments', 'x')),
			'diaryEvents.attachmentsFailed',
			'the body was saved, so telling the user "could not save" would be wrong'
		);
	});

	test('a persistence failure and a destroyed session fall back to the save message', () => {
		assert.equal(
			durabilityMessageKey(new WorkMemoDurabilityError('save', 'x')),
			'diaryEvents.saveFailed'
		);
		assert.equal(
			durabilityMessageKey(new WorkMemoDurabilityError('destroyed', 'x')),
			'diaryEvents.saveFailed'
		);
	});

	test('an unrecognised error still produces a usable message', () => {
		assert.equal(durabilityMessageKey(new Error('boom')), 'diaryEvents.saveFailed');
		assert.equal(durabilityMessageKey(undefined), 'diaryEvents.saveFailed');
		assert.equal(durabilityMessageKey('a string'), 'diaryEvents.saveFailed');
	});

	test('the reason is exposed without parsing the message', () => {
		assert.equal(durabilityFailureReason(new WorkMemoDurabilityError('attachments', 'x')), 'attachments');
		assert.equal(durabilityFailureReason(new Error('x')), null);
		assert.equal(durabilityFailureReason(null), null);
	});

	// This module recognises a durability failure by `name` rather than by
	// `instanceof`, because a type-only import is what keeps it loadable by
	// `node:test`. These two cases pin that contract down.
	test('the real error class is recognised by name', () => {
		for (const reason of ['uploads', 'body', 'attachments', 'save', 'destroyed']) {
			assert.equal(
				durabilityFailureReason(new WorkMemoDurabilityError(reason, 'x')),
				reason,
				'the class and DURABILITY_ERROR_NAME must stay in step'
			);
		}
	});

	test('an unrelated object claiming a reason is not mistaken for one', () => {
		assert.equal(durabilityFailureReason({ reason: 'attachments' }), null, 'no name');
		assert.equal(
			durabilityFailureReason({ name: 'Error', reason: 'attachments' }),
			null,
			'a wrong name'
		);
		assert.equal(
			durabilityMessageKey({ name: 'WorkMemoDurabilityError', reason: 'not-a-real-reason' }),
			'diaryEvents.saveFailed',
			'an unknown reason falls back to the generic message instead of printing undefined'
		);
	});
});
