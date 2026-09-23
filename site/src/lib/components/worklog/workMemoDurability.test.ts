// @ts-nocheck
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
	ATTACHMENTS_NOT_DURABLE,
	BODY_NOT_DURABLE,
	DURABILITY_ERROR_NAME,
	DURABILITY_SAFE_SKIP_REASONS,
	MediaReconcileTracker,
	WorkMemoDurabilityError,
	classifyReconcileOutcome,
	hasDurabilityWork,
	retryAttachmentsWhenFailed,
	runDurableFlush,
	toDurabilityError
} from './workMemoDurability.ts';
import { WorkMemoMediaReconciler } from './workMemoMediaAssociation.ts';

/**
 * Durability is where "is it safe to destroy this editor?" is answered
 * (Controller Review Fix 2, P1-2 / P2-1). `workMemoDurability` is a zero-import
 * leaf so this file can drive it directly; the wiring that *cannot* be imported
 * — `WorkMemoEditingSession`, `DiaryEventEditor.svelte` — is asserted at the
 * bottom of this file the way this project asserts component wiring.
 */

/** A promise whose settlement the test controls. */
function deferred() {
	let resolve = () => {};
	let reject = (error) => {};
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let every already-queued microtask and one macrotask run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Signals for a body that is saved, reconciled and safe to persist. */
const QUIET = {
	phase: 'saved',
	pendingImageUploads: 0,
	bodyPersistable: true,
	reconcilePending: false
};

/**
 * The pre-Fix-2 definition of "there is work outstanding": the save machine's
 * phase, and nothing else. Used as a negative control throughout so every extra
 * clause below is shown to be load-bearing.
 */
function phaseOnlyPending(signals) {
	const phase = signals.phase;
	return phase === 'scheduled' || phase === 'saving' || phase === 'error';
}

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('WorkMemoDurabilityError', () => {
	test('carries its reason as a value, not as a message to parse', () => {
		const error = new WorkMemoDurabilityError('attachments', 'anything at all');

		assert.equal(error.reason, 'attachments');
		assert.equal(typeof error.message, 'string');
		assert.ok(error instanceof Error);
	});

	test('its name is the constant an import-free module recognises it by', () => {
		assert.equal(new WorkMemoDurabilityError('save', 'x').name, DURABILITY_ERROR_NAME);
	});

	test('a reason is preserved, and a foreign rejection is wrapped', () => {
		const existing = new WorkMemoDurabilityError('body', 'x');
		assert.equal(toDurabilityError('save', existing), existing, 'no double-wrapping');

		const wrapped = toDurabilityError('save', new Error('POST /work-memos 500'));
		assert.equal(wrapped.reason, 'save');
		assert.equal(wrapped.message, 'POST /work-memos 500');
		assert.ok(wrapped instanceof WorkMemoDurabilityError);
	});
});

describe('hasDurabilityWork — nothing at stake', () => {
	test('a saved, reconciled, persistable body is not durability work', () => {
		assert.equal(hasDurabilityWork(QUIET), false);
	});
});

describe('hasDurabilityWork — the clauses the phase check missed (P1-2)', () => {
	test('a debounced or in-flight or failed save is durability work', () => {
		for (const phase of ['scheduled', 'saving', 'error']) {
			assert.equal(hasDurabilityWork({ ...QUIET, phase }), true, phase);
		}
	});

	test('an upload in flight is durability work even while the machine reads saved', () => {
		const signals = { ...QUIET, pendingImageUploads: 1 };

		assert.equal(
			phaseOnlyPending(signals),
			false,
			'negative control: the pre-Fix-2 definition reported "nothing pending" here'
		);
		assert.equal(hasDurabilityWork(signals), true, 'the new clause must catch what the phase missed');
	});

	test('a placeholder that outlives the upload counter is still durability work', () => {
		// The counter reads zero, so the pre-Fix-2 phase check sees nothing — but
		// persisting this body would store a dead `blob:` URL.
		const signals = { ...QUIET, pendingImageUploads: 0, bodyPersistable: false };

		assert.equal(phaseOnlyPending(signals), false, 'negative control');
		assert.equal(hasDurabilityWork(signals), true);
	});

	test('an outstanding association pass is durability work', () => {
		const signals = { ...QUIET, reconcilePending: true };

		assert.equal(phaseOnlyPending(signals), false, 'negative control');
		assert.equal(hasDurabilityWork(signals), true);
	});
});

describe('classifyReconcileOutcome', () => {
	test('a mutation that did not land is a durability failure', () => {
		const error = classifyReconcileOutcome({ skipped: null, failed: 1 });
		assert.ok(error instanceof WorkMemoDurabilityError);
		assert.equal(error.reason, 'attachments');
		assert.equal(error.message, ATTACHMENTS_NOT_DURABLE);
	});

	test('a clean pass is not a failure', () => {
		assert.equal(classifyReconcileOutcome({ skipped: null, failed: 0 }), null);
	});

	test('only the reasons that mean "nothing to do" are complete answers', () => {
		for (const skipped of DURABILITY_SAFE_SKIP_REASONS) {
			assert.equal(
				classifyReconcileOutcome({ skipped, failed: 0 }),
				null,
				`${skipped}: there was provably nothing to reconcile`
			);
		}
		assert.deepEqual(
			[...DURABILITY_SAFE_SKIP_REASONS].sort(),
			['no-memo', 'unchanged'],
			'the safe list is the two early answers, and it is an allowlist'
		);
	});

	test('an offline association list is NOT a complete answer (Fix 2A)', () => {
		// The reason drives this, not the `failed` counter: a reconciler that
		// stopped bumping `failed` on a list failure must not be able to turn
		// "we never read the server" into "durable".
		const error = classifyReconcileOutcome({ skipped: 'list-failed', failed: 0 });
		assert.ok(error instanceof WorkMemoDurabilityError, 'must not be treated as clean');
		assert.equal(error.reason, 'attachments');
		assert.equal(error.message, ATTACHMENTS_NOT_DURABLE);
	});

	test('a superseded pass is not a complete answer either', () => {
		assert.ok(classifyReconcileOutcome({ skipped: 'stale', failed: 0 }));
	});

	test('an unknown skip reason fails closed', () => {
		assert.ok(
			classifyReconcileOutcome({ skipped: 'something-new', failed: 0 }),
			'a future reason must not silently mean "durable"'
		);
	});
});

describe('MediaReconcileTracker — the newest pass owns the outcome (P2-1)', () => {
	test('reports an outstanding pass and resolves once it lands', async () => {
		const tracker = new MediaReconcileTracker();
		const gate = deferred();

		tracker.track(gate.promise);
		assert.equal(tracker.isPending, true);

		let done = false;
		const waiting = tracker.settle().then(() => {
			done = true;
		});

		await settle();
		assert.equal(done, false, 'settle must not resolve while the pass is outstanding');

		gate.resolve({ skipped: null, failed: 0 });
		await waiting;
		assert.equal(tracker.isPending, false);
	});

	test('waits for the LATEST pass, not the one that was running', async () => {
		const tracker = new MediaReconcileTracker();
		const first = deferred();
		const second = deferred();

		tracker.track(first.promise);
		tracker.track(second.promise);

		let done = false;
		const waiting = tracker.settle().then(() => {
			done = true;
		});

		first.resolve({ skipped: 'stale', failed: 0 });
		await settle();
		assert.equal(done, false, 'the superseded pass must not end the wait');
		assert.equal(tracker.isPending, true, 'the newest pass is still outstanding');

		second.resolve({ skipped: null, failed: 0 });
		await waiting;
		assert.equal(done, true);
		assert.equal(tracker.isPending, false);
	});

	test('a superseded failing pass cannot fail the flush it was replaced in', async () => {
		const tracker = new MediaReconcileTracker();
		const first = deferred();
		const second = deferred();

		tracker.track(first.promise);
		tracker.track(second.promise);

		first.reject(new Error('POST /media 500'));
		second.resolve({ skipped: null, failed: 0 });

		await tracker.settle();
		assert.equal(tracker.currentError, null, 'the newest pass succeeded, so the flush succeeded');
	});

	test('a rejected pass rejects the flush, with the attachments reason', async () => {
		const tracker = new MediaReconcileTracker();
		tracker.track(Promise.reject(new Error('GET /media offline')));

		const error = await tracker.settle().then(
			() => null,
			(reason) => reason
		);
		assert.ok(error instanceof WorkMemoDurabilityError);
		assert.equal(error.reason, 'attachments');
		assert.equal(tracker.isPending, false, 'the editor must not be trapped in "pending"');
	});

	test('a failure stands until a newer pass reports clean', async () => {
		const tracker = new MediaReconcileTracker();
		tracker.track(Promise.resolve({ skipped: null, failed: 1 }));
		await assert.rejects(tracker.settle(), (error) => error.reason === 'attachments');

		// Still failing: the association really is still missing, so a second
		// attempt must not quietly report success.
		await assert.rejects(tracker.settle(), (error) => error.reason === 'attachments');

		tracker.track(Promise.resolve({ skipped: null, failed: 0 }));
		await tracker.settle();
		assert.equal(tracker.currentError, null);
	});

	test('settling with no pass at all resolves', async () => {
		await new MediaReconcileTracker().settle();
	});
});

describe('runDurableFlush — the "safe to destroy" contract', () => {
	/** A set of steps that succeed, recording the order in which they ran. */
	function steps(overrides = () => ({})) {
		const order = [];
		const base = {
			isDestroyed: () => false,
			waitForUploads: async () => order.push('uploads'),
			persist: async () => order.push('persist'),
			isBodyPersistable: () => true,
			settleAttachments: async () => order.push('attachments')
		};
		return { order, steps: { ...base, ...overrides(order) } };
	}

	test('orders uploads, then persist, then the associations (P1-2 / P2-1)', async () => {
		const built = steps();
		await runDurableFlush(built.steps);
		assert.deepEqual(built.order, ['uploads', 'persist', 'attachments']);
	});

	test('does not persist a body whose placeholder never resolved', async () => {
		let persisted = false;
		const built = steps(() => ({
			isBodyPersistable: () => false,
			persist: async () => {
				persisted = true;
			}
		}));

		const error = await runDurableFlush(built.steps).then(
			() => null,
			(reason) => reason
		);
		assert.ok(error instanceof WorkMemoDurabilityError);
		assert.equal(error.reason, 'body');
		assert.equal(error.message, BODY_NOT_DURABLE);
		assert.equal(
			persisted,
			true,
			'the save runs first — it is the post-save body check that refuses to call it durable'
		);
	});

	test('an upload failure rejects as "uploads" and never reaches the save', async () => {
		const built = steps(() => ({
			waitForUploads: async () => {
				throw new Error('Upload rejected');
			}
		}));

		const error = await runDurableFlush(built.steps).then(
			() => null,
			(reason) => reason
		);
		assert.equal(error.reason, 'uploads');
		assert.deepEqual(built.order, [], 'nothing may be persisted from a failed upload');
	});

	test('a persistence failure rejects as "save" and never reaches the associations', async () => {
		const built = steps(() => ({
			persist: async () => {
				throw new Error('POST /work-memos 500');
			}
		}));

		const error = await runDurableFlush(built.steps).then(
			() => null,
			(reason) => reason
		);
		assert.equal(error.reason, 'save');
		assert.deepEqual(built.order, ['uploads'], 'the associations are not a save');
	});

	test('an association failure rejects the flush instead of reporting success (P2-1)', async () => {
		const built = steps(() => ({
			settleAttachments: async () => {
				throw new WorkMemoDurabilityError('attachments', ATTACHMENTS_NOT_DURABLE);
			}
		}));

		const error = await runDurableFlush(built.steps).then(
			() => null,
			(reason) => reason
		);
		assert.equal(error.reason, 'attachments', 'the body was saved, the images were not linked');
		assert.deepEqual(built.order, ['uploads', 'persist']);
	});

	test('a session that is already gone cannot be called durable', async () => {
		const built = steps(() => ({ isDestroyed: () => true }));

		const error = await runDurableFlush(built.steps).then(
			() => null,
			(reason) => reason
		);
		assert.equal(error.reason, 'destroyed');
		assert.deepEqual(built.order, []);
	});

	test('a session destroyed mid-flush is not reported as durable either', async () => {
		let destroyed = false;
		const built = steps(() => ({
			isDestroyed: () => destroyed,
			settleAttachments: async () => {
				destroyed = true;
			}
		}));

		const error = await runDurableFlush(built.steps).then(
			() => null,
			(reason) => reason
		);
		assert.equal(error.reason, 'destroyed');
	});

	test('resolves when every step is durable', async () => {
		const built = steps();
		await runDurableFlush(built.steps);
		assert.deepEqual(built.order, ['uploads', 'persist', 'attachments']);
	});

	test('negative control: a save-only flush returns before the associations land', async () => {
		// The pre-Fix-2 contract was `SaveMachine.flush()`, which knows nothing
		// about the association worker. Parking the durable flush on a gate shows
		// that this contract is a real constraint on the sequence and not a
		// tautology of the assertions above.
		const gate = deferred();
		const built = steps((order) => ({
			settleAttachments: async () => {
				await gate.promise;
				order.push('attachments');
			}
		}));

		let durableDone = false;
		const durable = runDurableFlush(built.steps).then(() => {
			durableDone = true;
		});

		await settle();
		assert.deepEqual(built.order, ['uploads', 'persist'], 'parked on the associations');
		assert.equal(
			durableDone,
			false,
			'the old contract would already have returned "done" at this point'
		);

		gate.resolve();
		await durable;
		assert.equal(durableDone, true);
		assert.deepEqual(built.order, ['uploads', 'persist', 'attachments']);
	});
});

describe('work memo session wiring (the session cannot be imported by node)', () => {
	const session = read('./workMemoEditingSession.ts');

	test('hasDurabilityWork delegates the definition instead of re-deriving it', () => {
		assert.match(session, /import\s*\{[^}]*\bhasDurabilityWork\b[^}]*\}\s*from\s*'\.\/workMemoDurability'/s);
		assert.match(session, /hasDurabilityWork\(\{/);
		// The four signals, each read from its own owner.
		assert.match(session, /phase:\s*this\.machine\.getState\(\)\.phase/);
		assert.match(session, /pendingImageUploads:\s*this\.pendingImageUploadCount/);
		assert.match(session, /bodyPersistable:\s*shouldPersistContent\(/);
		assert.match(session, /reconcilePending:\s*this\.tracker\.isPending/);
	});

	test('hasPendingChanges is the alias, not a second weaker answer', () => {
		assert.match(session, /hasPendingChanges\(\):\s*boolean\s*\{[\s\S]*?return this\.hasDurabilityWork\(\);/);
	});

	test('the session keeps no private copy of the reconcile bookkeeping', () => {
		// The field-access form, so the `reconcilePending` *signal key* the
		// session passes to the predicate is not mistaken for a local field.
		for (const field of [
			'this.reconcileTail',
			'this.reconcileSequence',
			'this.reconcilePending',
			'this.reconcileError'
		]) {
			assert.equal(
				session.includes(field),
				false,
				`${field} belongs to MediaReconcileTracker; a second copy is what P2-1 was about`
			);
		}
		assert.match(session, /new MediaReconcileTracker\(\)/);
		assert.match(session, /this\.tracker\.track\(this\.reconciler\.reconcile\(/);
		assert.match(
			session,
			/retryAttachmentsWhenFailed\(this\.tracker, \(\) =>\s*[\s\S]*?this\.reconcileMediaAssociations\(this\.content, \{ force: true \}\)/,
			'a failed pass is re-issued on the explicit attempt instead of re-thrown forever'
		);
	});

	test('flushDurably supplies the five steps and owns no sequence of its own', () => {
		assert.match(session, /runDurableFlush\(\{[\s\S]*?isDestroyed:[\s\S]*?waitForUploads:[\s\S]*?persist:[\s\S]*?isBodyPersistable:[\s\S]*?settleAttachments:/);
		assert.match(session, /async flushDurably\(\): Promise<void> \{\s*return runDurableFlush\(/);
	});

	test('the legacy vocabulary is re-exported so hosts keep one import site', () => {
		assert.match(session, /export\s*\{[\s\S]*?ATTACHMENTS_NOT_DURABLE,[\s\S]*?BODY_NOT_DURABLE,[\s\S]*?WorkMemoDurabilityError[\s\S]*?\}\s*from\s*'\.\/workMemoDurability'/);
	});

	test('both hosts publish the same durability handle rather than own logic', () => {
		const eventEditor = read('../diary/DiaryEventEditor.svelte');
		assert.match(eventEditor, /hasDurabilityWork:\s*\(\)\s*=>\s*\w+\.hasDurabilityWork\(\)/);
		assert.match(eventEditor, /flushDurably:\s*\(\)\s*=>\s*\w+\.flushDurably\(\)/);
		assert.match(eventEditor, /await session\.flushDurably\(\)/);
	});
});

describe('full-page worklog host regression (the shared session surface is unchanged)', () => {
	const session = read('./workMemoEditingSession.ts');
	const fullPage = read('./WorkMemoEditor.svelte');

	test('flush() still means "wait for uploads, then persist", as the host expects', () => {
		assert.match(
			session,
			/async flush\(\): Promise<void> \{[\s\S]*?await this\.waitForUploads\(\);[\s\S]*?await this\.persistBody\(\);[\s\S]*?\}/
		);
		assert.match(
			session,
			/private async persistBody\(\): Promise<void> \{[\s\S]*?await this\.machine\.flush\(\);[\s\S]*?toDurabilityError\('save', error\)/
		);
	});

	test('the default is to own the post-create pass, and the full-page host opts out', () => {
		assert.match(session, /this\.reconcileOnCreate = options\.reconcileOnCreate \?\? true;/);
		assert.match(
			session,
			/handleCreated\(id: string\): void \{[\s\S]*?if \(this\.reconcileOnCreate\) \{[\s\S]*?this\.reconcileMediaAssociations\(this\.content, \{ force: true \}\)/
		);
		assert.match(fullPage, /reconcileOnCreate: false/);
	});

	test('every session method the full-page host calls still exists', () => {
		for (const call of [
			'session?.handleContentChange(',
			'session?.handleImageUploadStateChange(',
			'await session.waitForUploads()',
			'await session.delete()',
			'session?.setStatus(',
			'session?.setPinned(',
			'session?.flush()',
			'session?.destroy()'
		]) {
			assert.ok(fullPage.includes(call), `${call} is part of the shared contract`);
		}
		assert.match(session, /async delete\(\): Promise<boolean> \{\s*return this\.machine\.delete\(\);/);
		assert.match(session, /destroy\(\): void \{[\s\S]*?this\.reconciler\.invalidate\(\);[\s\S]*?this\.machine\.destroy\(\);/);
	});

	test('a create that owns no post-create pass leaves the flush nothing to wait for', async () => {
		// The full-page host hands the one forced pass to the edit route, so on
		// this path the tracker has never seen a pass and must settle at once.
		const tracker = new MediaReconcileTracker();
		const order = [];

		await runDurableFlush({
			isDestroyed: () => false,
			waitForUploads: async () => order.push('uploads'),
			persist: async () => order.push('persist'),
			isBodyPersistable: () => true,
			settleAttachments: () => tracker.settle().then(() => order.push('attachments'))
		});

		assert.deepEqual(order, ['uploads', 'persist', 'attachments']);
		assert.equal(tracker.isPending, false);
	});
});

/**
 * The controller's scenario, driven through the *real* reconciler rather than a
 * stub result: a newly created event that holds an image, whose association list
 * comes back offline. The create is what makes an association possible at all,
 * so a list failure there means the attach the saved body needs never ran.
 */
describe('an offline association list is neither durable nor a dead end (Fix 2A)', () => {
	/** The reconciler logs its failure by design; keep the test output readable. */
	async function mutingConsoleError(run) {
		const original = console.error;
		console.error = () => {};
		try {
			return await run();
		} finally {
			console.error = original;
		}
	}

	function createAssociationHarness() {
		const state = { attached: [], listFails: true, listCalls: 0 };

		const reconciler = new WorkMemoMediaReconciler({
			list: async () => {
				state.listCalls += 1;
				if (state.listFails) throw new Error('GET /work-memos/m1/media offline');
				return [];
			},
			attach: async (_memoId, mediaId) => {
				state.attached.push(mediaId);
			},
			detach: async () => {}
		});
		reconciler.setMemoId('m1');

		const tracker = new MediaReconcileTracker();
		/**
		 * The session's own entry point, including its forced post-create pass.
		 * The pass promise is returned so a test can await it and keep the
		 * ordering of "the pass that failed" and "the flush that retried it"
		 * deterministic rather than racing microtasks.
		 */
		const issue = () => {
			const pass = reconciler.reconcile(['img1'], { force: true });
			tracker.track(pass);
			return pass;
		};

		return { state, tracker, issue };
	}

	/** `runDurableFlush` carrying the session's step 4, retry included. */
	function flushWith({ tracker, issue }) {
		return runDurableFlush({
			isDestroyed: () => false,
			waitForUploads: async () => {},
			persist: async () => {},
			isBodyPersistable: () => true,
			settleAttachments: () => retryAttachmentsWhenFailed(tracker, issue)
		});
	}

	test('A: a new image event whose list fails is not durable', async () => {
		const harness = createAssociationHarness();
		// The post-create pass the session owns, settled before the flush runs.
		// The reconciler encodes a list failure in the result instead of
		// rejecting, so this resolves — with a reason the flush must not accept.
		const postCreate = await mutingConsoleError(() => harness.issue());
		assert.equal(postCreate.skipped, 'list-failed');
		assert.ok(classifyReconcileOutcome(postCreate), 'the pass itself is already unproven');

		const error = await mutingConsoleError(() =>
			flushWith(harness).then(
				() => null,
				(reason) => reason
			)
		);

		assert.ok(error instanceof WorkMemoDurabilityError, 'the flush must not report success');
		assert.equal(error.reason, 'attachments');
		assert.deepEqual(
			harness.state.attached,
			[],
			'the attach the saved body needs never ran, which is why this cannot be "durable"'
		);
		assert.equal(harness.tracker.isPending, false, 'the editor must not be stuck reading "pending"');
	});

	test('B: the next explicit attempt recovers once the list works', async () => {
		const harness = createAssociationHarness();

		assert.equal((await mutingConsoleError(() => harness.issue())).skipped, 'list-failed');
		await mutingConsoleError(() =>
			assert.rejects(flushWith(harness), (error) => error.reason === 'attachments')
		);
		assert.deepEqual(harness.state.attached, []);

		// The user tries to leave again, and the server is reachable this time.
		harness.state.listFails = false;
		await mutingConsoleError(() => flushWith(harness));

		assert.deepEqual(
			harness.state.attached,
			['img1'],
			'the retry is what makes the editor leavable at all'
		);
		assert.equal(harness.tracker.currentError, null);
		assert.equal(harness.tracker.isPending, false);
		assert.equal(
			harness.state.listCalls,
			3,
			'the failed post-create pass, the retry that also failed, then the one that worked'
		);
	});

	test('C: list-failed is not misclassified as clean, even with failed === 0', async () => {
		// The reconciler happens to bump `failed` on a list failure today. The
		// classification must not depend on that: only the reason may decide.
		const outcome = { skipped: 'list-failed', failed: 0 };
		assert.ok(classifyReconcileOutcome(outcome), 'clean it is not');
		assert.equal(classifyReconcileOutcome(outcome).reason, 'attachments');
		assert.equal(DURABILITY_SAFE_SKIP_REASONS.includes('list-failed'), false);
	});

	test('D: a genuine no-op still succeeds, and does not re-issue anything', async () => {
		let listCalls = 0;
		const reconciler = new WorkMemoMediaReconciler({
			list: async () => {
				listCalls += 1;
				// The first pass must read the server; an unchanged *second*
				// answer must not, which is what "nothing to do" means.
				if (listCalls > 1) throw new Error('an unchanged media set must not reach the network');
				return [];
			},
			attach: async () => {},
			detach: async () => {}
		});
		reconciler.setMemoId('m1');

		const tracker = new MediaReconcileTracker();
		tracker.track(reconciler.reconcile([]));
		await retryAttachmentsWhenFailed(tracker, () => {
			throw new Error('a clean pass must not be re-issued');
		});

		const unchanged = await reconciler.reconcile([]);
		assert.equal(unchanged.skipped, 'unchanged');
		assert.equal(classifyReconcileOutcome(unchanged), null);
		assert.equal(listCalls, 1, 'the unchanged answer came from the recorded key, not the network');

		const fresh = new WorkMemoMediaReconciler({
			list: async () => [],
			attach: async () => {},
			detach: async () => {}
		});
		const noMemo = await fresh.reconcile(['img1']);
		assert.equal(noMemo.skipped, 'no-memo');
		assert.equal(classifyReconcileOutcome(noMemo), null);

		// A tracker that has never failed resolves without re-issuing, so the
		// reissue callback above throwing is itself the assertion.
		const quiet = new MediaReconcileTracker();
		await runDurableFlush({
			isDestroyed: () => false,
			waitForUploads: async () => {},
			persist: async () => {},
			isBodyPersistable: () => true,
			settleAttachments: () =>
				retryAttachmentsWhenFailed(quiet, () => {
					throw new Error('nothing to retry');
				})
		});
	});

	test('negative control: waiting without re-issuing can never recover', async () => {
		// This is the pre-Fix-2A step 4 — `settle()` alone. Once the server is
		// reachable again nothing asks it anything, so the recorded failure is
		// permanent and the attach still has not run. That is why the retry is
		// part of the contract and not an optimisation.
		const harness = createAssociationHarness();
		assert.equal((await mutingConsoleError(() => harness.issue())).skipped, 'list-failed');

		await mutingConsoleError(() =>
			assert.rejects(harness.tracker.settle(), (error) => error.reason === 'attachments')
		);

		harness.state.listFails = false;
		await mutingConsoleError(() =>
			assert.rejects(
				harness.tracker.settle(),
				(error) => error.reason === 'attachments',
				'the same failure is still on record: nothing re-issued a pass'
			)
		);

		assert.equal(
			harness.state.listCalls,
			1,
			'nothing re-issued a pass, so the server was never asked again'
		);
		assert.deepEqual(harness.state.attached, [], 'so the body keeps promising an image it never linked');
	});
});
