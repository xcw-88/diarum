// @ts-nocheck
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
	DiaryEditorOwnership,
	NEW_EVENT_TARGET,
	memoEventTarget,
	memoIdFromTarget,
	ownersOverlap,
	type DiaryEditorOwner,
	type DiaryEditorSlot
} from './diaryEditorOwnership.ts';

/**
 * Records every `apply` and every flush, so the tests can reason about what the
 * DOM actually saw and in which order.
 */
function createHarness() {
	const applied: DiaryEditorSlot[] = [];
	/** `applied.length` at the moment each flush resolved. */
	const flushedAt: number[] = [];
	const releases: number[] = [];

	const ownership = new DiaryEditorOwnership({
		apply: (slot) => applied.push(slot),
		flush: async () => {
			flushedAt.push(applied.length);
		}
	});

	/** Release that records how many slots had been applied when it ran. */
	const release = async () => {
		releases.push(applied.length);
	};

	/** `applied` rendered as `'none'` / `'event:<target>'` / `'legacy'`. */
	const keys = () => applied.map((slot) => (slot.kind === 'event' ? `event:${slot.target}` : slot.kind));

	return { applied, flushedAt, releases, ownership, release, keys };
}

/** Reflects the same slots the ownership applies, for trigger-replay tests. */
function replayOf(applied: DiaryEditorSlot[]): string[] {
	return applied.map((slot) => (slot.kind === 'event' ? `event:${slot.target}` : slot.kind));
}

const A = memoEventTarget('a');
const B = memoEventTarget('b');
const C = memoEventTarget('c');

describe('DiaryEditorOwnership', () => {
	test('starts on the legacy editor without applying anything', () => {
		const { applied, ownership } = createHarness();

		assert.equal(ownership.current, 'legacy');
		assert.equal(ownership.target, null);
		assert.deepEqual(applied, [], 'the initial owner is the component state, not a transition');
	});

	test('legacy -> event passes through a full flush with no editor mounted', async () => {
		const { keys, flushedAt, ownership } = createHarness();

		await ownership.enterEvent(A);

		assert.deepEqual(keys(), ['none', `event:${A}`]);
		// The flush must resolve after 'none' was applied (so the legacy editor
		// has been torn down) and before 'event' was applied (so the event
		// editor has not been mounted yet).
		assert.deepEqual(flushedAt, [1]);
		assert.equal(ownership.current, 'event');
		assert.equal(ownership.target, A);
	});

	test('event -> legacy passes through a full flush with no editor mounted', async () => {
		const { keys, flushedAt, ownership, release } = createHarness();

		await ownership.enterEvent(A);
		await ownership.exitEvent(release);

		assert.deepEqual(keys(), ['none', `event:${A}`, 'none', 'legacy']);
		assert.deepEqual(flushedAt, [1, 3]);
		assert.equal(ownership.current, 'legacy');
	});

	test('event A -> event B is a real handoff, not a same-kind early return', async () => {
		const { keys, flushedAt, ownership, release } = createHarness();

		await ownership.enterEvent(A, release);
		await ownership.enterEvent(B, release);

		// THE regression this exists for: 'event:A' must never be followed
		// directly by 'event:B'. Two different event targets are two different
		// editors, and swapping them inside one DOM diff is what dropped A's
		// queued autosave.
		assert.deepEqual(keys(), ['none', `event:${A}`, 'none', `event:${B}`]);
		assert.equal(flushedAt.length, 2, 'each handoff gets its own flush boundary');
		assert.equal(ownership.target, B);
	});

	test('the release runs while the outgoing editor is still applied', async () => {
		const { applied, ownership, release, releases } = createHarness();

		await ownership.enterEvent(A, release);
		assert.equal(releases.length, 0, 'no outgoing event editor, nothing to release');

		await ownership.enterEvent(B, release);
		assert.deepEqual(releases, [2], 'released after event:A was applied, before none');

		// The outgoing slot was still the applied one when the release ran.
		assert.equal(applied[releases[0] - 1].target, A);
	});

	test('repeated requests for the same target are no-ops', async () => {
		const { keys, ownership, release, releases } = createHarness();

		await ownership.enterEvent(A, release);
		await ownership.enterEvent(A, release);
		await ownership.enterEvent(A, release);
		await ownership.exitEvent(release);
		await ownership.exitEvent(release);

		assert.deepEqual(keys(), ['none', `event:${A}`, 'none', 'legacy']);
		assert.deepEqual(releases, [2], 'only the one handoff that left an event released');
	});

	test('a failed release changes nothing and rejects the caller', async () => {
		const { keys, ownership, release } = createHarness();
		const failure = new Error('not durable');

		await ownership.enterEvent(A, release);

		await assert.rejects(
			() =>
				ownership.enterEvent(B, async () => {
					await release();
					throw failure;
				}),
			(error) => error === failure
		);

		// Nothing was torn down: A is still the applied slot, so its editor is
		// still mounted, editable and able to show the error.
		assert.deepEqual(keys(), ['none', `event:${A}`]);
		assert.equal(ownership.current, 'event');
		assert.equal(ownership.target, A);
	});

	test('a failed release does not wedge the queue', async () => {
		const { keys, ownership, release } = createHarness();
		let shouldFail = true;

		await ownership.enterEvent(A, release);

		await assert.rejects(() =>
			ownership.enterEvent(B, async () => {
				if (shouldFail) throw new Error('not durable');
				await release();
			})
		);

		shouldFail = false;
		await ownership.enterEvent(B, release);

		assert.deepEqual(keys(), ['none', `event:${A}`, 'none', `event:${B}`]);
		assert.equal(ownership.target, B);
	});

	test('legacy and event are never applied back to back without none in between', async () => {
		const { applied, ownership, release } = createHarness();

		await ownership.enterEvent(A, release);
		await ownership.exitEvent(release);
		await ownership.enterEvent(B, release);
		await ownership.exitEvent(release);

		for (let i = 1; i < applied.length; i += 1) {
			assert.ok(
				!ownersOverlap(applied[i - 1], applied[i]),
				`${JSON.stringify(applied[i - 1])} -> ${JSON.stringify(applied[i])} would let two editors exist`
			);
		}
		for (let i = 0; i < applied.length; i += 1) {
			if (applied[i].kind === 'none') continue;
			assert.equal(
				applied[i - 1].kind,
				'none',
				`${JSON.stringify(applied[i])} was applied without tearing the previous editor down first`
			);
		}
	});

	test('two different event targets DO overlap (that is why none is required)', () => {
		assert.equal(ownersOverlap(A, B), true);
		assert.equal(ownersOverlap({ kind: 'event', target: A }, { kind: 'event', target: A }), false);
		assert.equal(ownersOverlap('none', 'event'), false);
		assert.equal(ownersOverlap('legacy', 'event'), true);
	});

	test('interleaved requests are serialised, so the none phase is never skipped', async () => {
		const { keys, flushedAt, ownership, release } = createHarness();

		// Fire both without awaiting, as a double click would.
		const first = ownership.enterEvent(A, release);
		const second = ownership.exitEvent(release);
		await Promise.all([first, second]);

		assert.deepEqual(keys(), ['none', `event:${A}`, 'none', 'legacy']);
		assert.equal(flushedAt.length, 2);
		assert.equal(ownership.current, 'legacy');
	});

	test('rapid clicks resolve to the last requested target and skip the middle one', async () => {
		const { keys, ownership, release, releases } = createHarness();

		await ownership.enterEvent(A, release);

		// A -> B, then C before the A -> B handoff has finished. The release is
		// serialised: exactly one more release, and B is never applied at all.
		const toB = ownership.enterEvent(B, release);
		const toC = ownership.enterEvent(C, release);
		await Promise.all([toB, toC]);

		assert.deepEqual(keys(), ['none', `event:${A}`, 'none', `event:${C}`]);
		assert.ok(!keys().includes(`event:${B}`), 'the superseded target must never be mounted');
		assert.deepEqual(releases, [2], 'the outgoing editor is released exactly once');
		assert.equal(ownership.target, C);
	});

	test('no two releases ever run in parallel', async () => {
		const { ownership } = createHarness();
		let active = 0;
		let maxActive = 0;
		let started = 0;

		const slowRelease = async () => {
			started += 1;
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active -= 1;
		};

		await ownership.enterEvent(A, slowRelease);
		await Promise.all([
			ownership.enterEvent(B, slowRelease),
			ownership.enterEvent(C, slowRelease),
			ownership.exitEvent(slowRelease)
		]);

		assert.equal(maxActive, 1, 'releases are serialised, never parallel');
		assert.ok(started >= 1, 'the outgoing editor was released at least once');
		assert.equal(ownership.current, 'legacy', 'the last requested intent wins');
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
 * Replays a sequence of applied slots against the singleton, assuming the worst
 * case for a single DOM diff: the incoming editor mounts *before* the outgoing
 * one is destroyed.
 */
function replay(slots: string[]) {
	const triggers = createTriggerSingleton();
	let mounted: string | null = null;

	for (const key of slots) {
		const next = key === 'none' ? null : key;
		if (next === mounted) continue;
		if (next) triggers.mount(next);
		if (mounted) triggers.unmount();
		mounted = next;
	}

	return { mounted, imageTrigger: triggers.imageTrigger };
}

describe('module-level image/gallery trigger singleton', () => {
	test('the two-phase sequence leaves the incoming editor owning the trigger', async () => {
		const { applied, ownership, release } = createHarness();

		await ownership.enterEvent(A, release);
		const result = replay(['legacy', ...replayOf(applied)]);

		assert.equal(result.mounted, `event:${A}`);
		assert.equal(
			result.imageTrigger,
			`event:${A}`,
			'the event editor must still own the module-level trigger'
		);
	});

	test('event A -> event B also leaves the trigger with B', async () => {
		const { applied, ownership, release } = createHarness();

		await ownership.enterEvent(A, release);
		await ownership.enterEvent(B, release);
		const result = replay(['legacy', ...replayOf(applied)]);

		assert.equal(result.mounted, `event:${B}`);
		assert.equal(result.imageTrigger, `event:${B}`);
	});

	test('a single-flush swap would wipe the incoming editor trigger (regression guard)', () => {
		// This is what the fix replaces: swap straight from legacy to event in
		// one DOM diff. The legacy editor mounts nothing new but is destroyed
		// last, so its blanket cleanup nulls the trigger the event editor just
		// registered.
		const result = replay(['legacy', `event:${A}`]);

		assert.equal(result.mounted, `event:${A}`);
		assert.equal(
			result.imageTrigger,
			null,
			'documents the bug the intermediate none-phase exists to prevent'
		);
	});

	test('a single-flush A -> B swap wipes the trigger just as badly', () => {
		// The Controller Review Fix 2 shape of the same bug.
		const result = replay([`event:${A}`, `event:${B}`]);

		assert.equal(result.mounted, `event:${B}`);
		assert.equal(result.imageTrigger, null, 'documents the pre-Fix-2 event switch bug');
	});
});

/**
 * ---------------------------------------------------------------------------
 * Controller Review Fix 2, finding P1-1 — an event switch used to drop the
 * outgoing event's queued autosave, because `openEvent(B)` moved the target
 * straight into the DOM diff while the debounce timer was still pending.
 *
 * The model below is the smallest thing that can actually lose work: an editor
 * with a dirty (typed, not yet persisted) body whose ONLY path to safety is a
 * durable flush.
 * ---------------------------------------------------------------------------
 */
function createEventModel() {
	let mounted = false;
	let dirty = false;
	const persisted: string[] = [];

	return {
		get mounted() {
			return mounted;
		},
		get dirty() {
			return dirty;
		},
		get persisted() {
			return persisted;
		},
		mount() {
			mounted = true;
		},
		type(text: string) {
			if (mounted) dirty = true;
			return text;
		},
		/** durable flush: the only thing that clears `dirty` */
		async flushDurably() {
			if (dirty) {
				persisted.push('flushed');
				dirty = false;
			}
		},
		/** a plain DOM-diff unmount: no flush, whatever was queued is dropped */
		unmount() {
			mounted = false;
		}
	};
}

function createHandoffModel() {
	const models = new Map<string, ReturnType<typeof createEventModel>>();
	const appliedKeys: string[] = [];
	let surface: string | null = 'legacy';

	const model = (id: string) => {
		let found = models.get(id);
		if (!found) {
			found = createEventModel();
			models.set(id, found);
		}
		return found;
	};

	function teardown() {
		if (surface && surface.startsWith('event:')) model(surface.slice(6)).unmount();
		surface = null;
	}

	const ownership = new DiaryEditorOwnership({
		apply: (slot) => {
			const key = slot.kind === 'event' ? `event:${slot.target}` : slot.kind;
			appliedKeys.push(key);
			if (slot.kind === 'legacy') {
				teardown();
				surface = 'legacy';
			} else if (slot.kind === 'none') {
				teardown();
			} else {
				teardown();
				const id = slot.target;
				model(id).mount();
				surface = `event:${id}`;
			}
		},
		flush: async () => {}
	});

	/** The page's release: make whichever editor is mounted durable. */
	async function releaseMountedEditor() {
		if (surface && surface.startsWith('event:')) await model(surface.slice(6)).flushDurably();
	}

	/** The pre-Fix-2 behaviour: swap the target with no release at all. */
	async function releaseNothing() {}

	return { ownership, releaseMountedEditor, releaseNothing, model, appliedKeys, get surface() { return surface; } };
}

describe('event A -> event B durable handoff (P1-1)', () => {
	test('a debounce-pending body in A is persisted before B takes the slot', async () => {
		const harness = createHandoffModel();

		await harness.ownership.enterEvent(A, harness.releaseMountedEditor);
		harness.model(A).type('typed inside the debounce window');
		assert.equal(harness.model(A).dirty, true, 'precondition: A has unsaved input');

		await harness.ownership.enterEvent(B, harness.releaseMountedEditor);

		assert.deepEqual(harness.model(A).persisted, ['flushed'], 'A was made durable');
		assert.equal(harness.model(A).dirty, false, 'nothing of A is left unsaved');
		assert.equal(harness.model(A).mounted, false, 'A was torn down afterwards');
		assert.equal(harness.model(B).mounted, true, 'B took the slot');
		assert.deepEqual(harness.appliedKeys, [
			'none',
			`event:${A}`,
			'none',
			`event:${B}`
		]);
	});

	test('negative control: swapping the target without a release loses A (regression guard)', async () => {
		const harness = createHandoffModel();

		await harness.ownership.enterEvent(A, harness.releaseNothing);
		harness.model(A).type('typed inside the debounce window');

		await harness.ownership.enterEvent(B, harness.releaseNothing);

		// This is exactly the reported bug: the two-phase lifecycle is intact,
		// but nothing asked A to become durable first.
		assert.deepEqual(harness.model(A).persisted, []);
		assert.equal(harness.model(A).dirty, true, 'A\u2019s input was dropped on the floor');
	});

	test('a refused handoff leaves A mounted, dirty-but-alive and open', async () => {
		const harness = createHandoffModel();

		await harness.ownership.enterEvent(A, harness.releaseMountedEditor);
		harness.model(A).type('typed inside the debounce window');

		await assert.rejects(
			() =>
				harness.ownership.enterEvent(B, async () => {
					throw new Error('save failed');
				}),
			/save failed/
		);

		assert.equal(harness.model(A).mounted, true, 'A keeps the slot so the user can retry');
		assert.equal(harness.model(B).mounted, false, 'B must not open');
		assert.equal(harness.surface, `event:${A}`);
		assert.ok(!harness.appliedKeys.includes(`event:${B}`));
	});

	test('A -> B -> C serialises one release and lands on C', async () => {
		const harness = createHandoffModel();

		await harness.ownership.enterEvent(A, harness.releaseMountedEditor);
		harness.model(A).type('dirty');

		await Promise.all([
			harness.ownership.enterEvent(B, harness.releaseMountedEditor),
			harness.ownership.enterEvent(C, harness.releaseMountedEditor)
		]);

		assert.equal(harness.surface, `event:${C}`, 'the last requested target wins');
		assert.deepEqual(harness.model(A).persisted, ['flushed'], 'A was saved exactly once');
		assert.equal(harness.model(B).mounted, false, 'the superseded target never mounted');
		assert.equal(harness.model(C).mounted, true);
		assert.deepEqual(harness.appliedKeys, [
			'none',
			`event:${A}`,
			'none',
			`event:${C}`
		]);
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

	function scriptOf(url: URL): string {
		const source = readFileSync(url, 'utf8');
		const end = source.lastIndexOf('</script>');
		return end === -1 ? '' : source.slice(0, end);
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

	test('the parent owns the slot and passes the identity plus both handoff callbacks down', () => {
		const template = templateOf(classicUrl);
		const usage = template.slice(template.indexOf('<DiaryEvents'));
		const openTag = usage.slice(0, usage.indexOf('/>'));

		assert.match(openTag, /\{editorOwner\}/, 'DiaryEvents must receive the slot kind');
		assert.match(openTag, /\{editorTarget\}/, 'DiaryEvents must receive the slot identity');
		assert.match(openTag, /onEnterEventEditing=/, 'DiaryEvents must be able to request the slot');
		assert.match(openTag, /onExitEventEditing=/, 'DiaryEvents must be able to give the slot back');
	});

	test('the parent applies kind and identity together, in one callback', () => {
		const script = scriptOf(classicUrl);

		assert.match(
			script,
			/apply: \(slot\) => \{[\s\S]*?editorOwner = slot\.kind;[\s\S]*?editorTarget = slot\.target;/,
			'one apply must move both halves of the slot, so they can never disagree'
		);
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

	test('no event editor can be mounted without the event owner AND its own identity', () => {
		const template = templateOf(eventsUrl);
		const script = scriptOf(eventsUrl);

		// Both guards fold in the owner, so a target alone can never mount one.
		assert.match(
			script,
			/editorOwner === 'event' && editorTarget === NEW_EVENT_TARGET/,
			'the new-draft guard must require the event owner'
		);
		assert.match(
			script,
			/editorOwner === 'event' \? memoIdFromTarget\(editorTarget\) : null/,
			'the edit guard must require the event owner'
		);

		const occurrences = [...template.matchAll(/<DiaryEventEditor/g)];
		assert.equal(occurrences.length, 2, 'both the edit and the new-draft surfaces must be gated');

		const guards = ['{#if mountedMemoId === memo.id}', '{#if mountedNewDraft}'];
		for (const occurrence of occurrences) {
			const before = template.slice(0, occurrence.index).trimEnd();
			assert.ok(
				guards.some((guard) => before.endsWith(guard)),
				`unexpected guard before an event editor mount:\n${before.slice(-120)}`
			);
		}
	});

	test('the page hands a lazy release to the ownership, not a captured editor', () => {
		const script = scriptOf(eventsUrl);

		assert.match(
			script,
			/activeEditor\?\.flushDurably\(\) \?\? Promise\.resolve\(\)/,
			'the release must read whichever editor is mounted when it runs'
		);
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

describe('event target identity helpers', () => {
	test('a memo target round-trips and cannot collide with the new-draft target', () => {
		assert.equal(memoEventTarget('abc'), 'memo:abc');
		assert.equal(memoIdFromTarget('memo:abc'), 'abc');
		assert.equal(memoIdFromTarget(NEW_EVENT_TARGET), null);
		assert.equal(memoIdFromTarget(null), null);
		assert.notEqual(memoEventTarget(NEW_EVENT_TARGET), NEW_EVENT_TARGET);
	});

	test('a memo whose id is literally "new" is still unambiguous', () => {
		assert.notEqual(memoEventTarget('new'), NEW_EVENT_TARGET);
		assert.equal(memoIdFromTarget(memoEventTarget('new')), 'new');
	});
});

/** Keeps the unused-import checker honest about the type-only exports. */
const _typecheck: [DiaryEditorOwner, DiaryEditorSlot] = ['legacy', { kind: 'legacy', target: null }];
void _typecheck;
