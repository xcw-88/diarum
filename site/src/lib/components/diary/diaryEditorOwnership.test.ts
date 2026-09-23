// @ts-nocheck
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
	DiaryEditorOwnership,
	ownersOverlap,
	type DiaryEditorOwner
} from './diaryEditorOwnership.ts';

/**
 * Records every `apply` and every flush, so the tests can reason about what the
 * DOM actually saw and in which order.
 */
function createHarness() {
	const applied: DiaryEditorOwner[] = [];
	/** `applied.length` at the moment each flush resolved. */
	const flushedAt: number[] = [];

	const ownership = new DiaryEditorOwnership({
		apply: (owner) => applied.push(owner),
		flush: async () => {
			flushedAt.push(applied.length);
		}
	});

	return { applied, flushedAt, ownership };
}

describe('DiaryEditorOwnership', () => {
	test('starts on the legacy editor without applying anything', () => {
		const { applied, ownership } = createHarness();

		assert.equal(ownership.current, 'legacy');
		assert.deepEqual(applied, [], 'the initial owner is the component state, not a transition');
	});

	test('legacy -> event passes through a full flush with no editor mounted', async () => {
		const { applied, flushedAt, ownership } = createHarness();

		await ownership.enterEvent();

		assert.deepEqual(applied, ['none', 'event']);
		// The flush must resolve after 'none' was applied (so the legacy editor
		// has been torn down) and before 'event' was applied (so the event
		// editor has not been mounted yet).
		assert.deepEqual(flushedAt, [1]);
		assert.equal(ownership.current, 'event');
	});

	test('event -> legacy passes through a full flush with no editor mounted', async () => {
		const { applied, flushedAt, ownership } = createHarness();

		await ownership.enterEvent();
		await ownership.exitEvent();

		assert.deepEqual(applied, ['none', 'event', 'none', 'legacy']);
		assert.deepEqual(flushedAt, [1, 3]);
		assert.equal(ownership.current, 'legacy');
	});

	test('repeated requests are no-ops and never re-apply the same owner', async () => {
		const { applied, ownership } = createHarness();

		await ownership.enterEvent();
		await ownership.enterEvent();
		await ownership.enterEvent();
		await ownership.exitEvent();
		await ownership.exitEvent();

		assert.deepEqual(applied, ['none', 'event', 'none', 'legacy']);
		assert.equal(ownership.current, 'legacy');
	});

	test('legacy and event are never applied back to back without none in between', async () => {
		const { applied, ownership } = createHarness();

		await ownership.enterEvent();
		await ownership.exitEvent();
		await ownership.enterEvent();
		await ownership.exitEvent();

		for (let i = 1; i < applied.length; i += 1) {
			assert.ok(
				!ownersOverlap(applied[i - 1], applied[i]),
				`${applied[i - 1]} -> ${applied[i]} would let two editors exist`
			);
		}
		// Every non-'none' run is a single owner, and each change of owner is
		// separated by exactly one 'none'.
		for (let i = 0; i < applied.length; i += 1) {
			if (applied[i] === 'none') continue;
			assert.equal(
				applied[i - 1],
				'none',
				`${applied[i]} was applied without tearing the previous editor down first`
			);
		}
	});

	test('interleaved requests are serialised, so the none phase is never skipped', async () => {
		const { applied, flushedAt, ownership } = createHarness();

		// Fire both without awaiting, as a double click would.
		const first = ownership.enterEvent();
		const second = ownership.exitEvent();
		await Promise.all([first, second]);

		// Whatever order the queue settled on, no editor ever replaced another
		// directly and every change of owner went through its own flush.
		assert.deepEqual(applied, ['none', 'event', 'none', 'legacy']);
		assert.equal(flushedAt.length, 2);
		assert.equal(ownership.current, 'legacy');
	});

	test('a queued request issued during a handoff still waits for the flush boundary', async () => {
		const { applied, ownership } = createHarness();

		const entering = ownership.enterEvent();
		// Issued while phase 1 is still in flight (the queue has not settled).
		const leaving = ownership.exitEvent();
		await Promise.all([entering, leaving]);

		const eventIndex = applied.indexOf('event');
		assert.ok(eventIndex > -1, 'the first handoff still completed');
		// The exit handoff had to tear the event editor down explicitly.
		assert.equal(applied[eventIndex + 1], 'none');
		assert.equal(ownership.current, 'legacy');
	});
});

/**
 * Models the real failure mode: `TiptapEditor` registers its image/gallery
 * handlers in a module-level singleton on mount and clears them
 * **unconditionally** on destroy.
 */
function createTriggerSingleton() {
	let imageTrigger: string | null = null;

	return {
		get imageTrigger() {
			return imageTrigger;
		},
		/** mounts the editor: it registers its own handler */
		mount(id: string) {
			imageTrigger = id;
		},
		/** destroys the editor: blanket clear, as `TiptapEditor.onDestroy` does */
		unmount() {
			imageTrigger = null;
		}
	};
}

/**
 * Replays a sequence of owners against the singleton, assuming the worst case
 * for a single DOM diff: the incoming editor mounts *before* the outgoing one is
 * destroyed.
 */
function replay(owners: DiaryEditorOwner[]) {
	const triggers = createTriggerSingleton();
	let mounted: string | null = null;

	for (const owner of owners) {
		const next = owner === 'none' ? null : owner;
		if (next === mounted) continue;
		if (next) triggers.mount(next);
		if (mounted) triggers.unmount();
		mounted = next;
	}

	return { mounted, imageTrigger: triggers.imageTrigger };
}

describe('module-level image/gallery trigger singleton', () => {
	test('the two-phase sequence leaves the incoming editor owning the trigger', async () => {
		const { applied, ownership } = createHarness();

		await ownership.enterEvent();
		const result = replay(['legacy', ...applied]);

		assert.equal(result.mounted, 'event');
		assert.equal(
			result.imageTrigger,
			'event',
			'the event editor must still own the module-level trigger'
		);
	});

	test('a single-flush swap would wipe the incoming editor trigger (regression guard)', () => {
		// This is what the fix replaces: swap straight from legacy to event in
		// one DOM diff. The legacy editor mounts nothing new but is destroyed
		// last, so its blanket cleanup nulls the trigger the event editor just
		// registered.
		const result = replay(['legacy', 'event']);

		assert.equal(result.mounted, 'event');
		assert.equal(
			result.imageTrigger,
			null,
			'documents the bug the intermediate none-phase exists to prevent'
		);
	});

	test('the reverse handoff also leaves the trigger with the surviving editor', async () => {
		const { applied, ownership } = createHarness();

		await ownership.enterEvent();
		await ownership.exitEvent();
		const result = replay(['legacy', ...applied]);

		assert.equal(result.mounted, 'legacy');
		assert.equal(result.imageTrigger, 'legacy');
	});
});

/**
 * Component wiring. There is no component test framework in this project, so —
 * as with the existing `production component wiring` suite — these assertions
 * read the `.svelte` sources. They are intentionally written against structure
 * that carries meaning (which `{#if}` guards which mount), not against exact
 * whitespace or ordering.
 */
describe('diary editor ownership wiring', () => {
	function templateOf(url: URL): string {
		const source = readFileSync(url, 'utf8');
		const end = source.lastIndexOf('</script>');
		return end === -1 ? source : source.slice(end);
	}

	const classicUrl = new URL('./ClassicDiaryView.svelte', import.meta.url);
	const eventsUrl = new URL('./DiaryEvents.svelte', import.meta.url);
	const editorUrl = new URL('../editor/TiptapEditor.svelte', import.meta.url);

	test('the legacy editor is mounted only for the legacy owner', () => {
		const template = templateOf(classicUrl);

		const legacyMount = template.indexOf('<TiptapEditor');
		assert.ok(legacyMount > -1, 'ClassicDiaryView must render the legacy editor');
		assert.ok(
			template.slice(0, legacyMount).trimEnd().endsWith("{#if editorOwner === 'legacy'}"),
			'the legacy editor must sit behind `{#if editorOwner === \'legacy\'}`, so it cannot ' +
				'stay mounted while an event editor holds the slot'
		);
		assert.equal(
			template.indexOf('<TiptapEditor', legacyMount + 1),
			-1,
			'there must be exactly one legacy TipTap mount on the page'
		);
	});

	test('the parent owns the slot and passes both handoff callbacks down', () => {
		const template = templateOf(classicUrl);
		const usage = template.slice(template.indexOf('<DiaryEvents'));
		const openTag = usage.slice(0, usage.indexOf('/>'));

		assert.match(openTag, /\{editorOwner\}/, 'DiaryEvents must receive editorOwner');
		assert.match(openTag, /onEnterEventEditing=/, 'DiaryEvents must be able to request the slot');
		assert.match(openTag, /onExitEventEditing=/, 'DiaryEvents must be able to give the slot back');
	});

	test('the old post-render ownership reporting is gone', () => {
		// The removed mechanism reported ownership from a `$effect` that ran
		// after the child had already mounted its editor — one frame too late.
		for (const url of [classicUrl, eventsUrl]) {
			const source = readFileSync(url, 'utf8');
			assert.ok(
				!source.includes('onEditorActiveChange'),
				`${url.pathname} must not go back to after-render ownership reporting`
			);
		}
	});

	test('no event editor can be mounted without the event owner', () => {
		const template = templateOf(eventsUrl);
		const occurrences = [...template.matchAll(/<DiaryEventEditor/g)];

		assert.ok(occurrences.length >= 2, 'both the edit and the new-draft surfaces must be gated');
		for (const occurrence of occurrences) {
			const before = template.slice(0, occurrence.index).trimEnd();
			assert.ok(
				before.endsWith("{#if editorOwner === 'event'}"),
				'every DiaryEventEditor mount must be guarded by `editorOwner === \'event\'`'
			);
		}
	});

	test('TiptapEditor releases its triggers ownership-aware, never blanket', () => {
		const source = readFileSync(editorUrl, 'utf8');
		const teardown = source.slice(source.indexOf('onDestroy(() => {'));

		assert.match(
			teardown,
			/clearImageUploadTrigger\(handleSlashImage\)/,
			'the image trigger must only be cleared if this instance still owns it'
		);
		assert.match(
			teardown,
			/clearGalleryPickerTrigger\(handleGalleryPicker\)/,
			'the gallery trigger must only be cleared if this instance still owns it'
		);
		assert.ok(
			!/setImageUploadTrigger\(null\)|setGalleryPickerTrigger\(null\)/.test(teardown),
			'a blanket clear would wipe a newer instance\u2019s handlers'
		);
	});
});
