// @ts-nocheck
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	WorkMemoMediaReconciler,
	computeWorkMemoMediaDiff,
	extractCommittableMediaId,
	extractDataMediaIds,
	mediaSetKey,
	uniqueMediaIds
} from './workMemoMediaAssociation.ts';
import { isMediaSetStable } from './workMemoContent.ts';

describe('extractCommittableMediaId', () => {
	it('returns the Diarum media id for a local upload result', () => {
		assert.equal(extractCommittableMediaId({ id: 'm1' }), 'm1');
	});

	it('returns null for a Chevereto (external) result', () => {
		assert.equal(extractCommittableMediaId({ cheveretoUrl: 'https://x/y.png' }), null);
	});

	it('returns null when the id is missing', () => {
		assert.equal(extractCommittableMediaId({ id: '' }), null);
		assert.equal(extractCommittableMediaId({}), null);
	});
});

describe('extractDataMediaIds', () => {
	it('extracts every data-media-id from image tags', () => {
		const html =
			'<img src="/a.png" data-media-id="m1"><p>x</p><img src="/b.png" data-media-id="m2">';
		assert.deepEqual(extractDataMediaIds(html), ['m1', 'm2']);
	});

	it('returns an empty list when none present', () => {
		assert.deepEqual(extractDataMediaIds('<img src="/a.png">'), []);
	});

	it('ignores images without data-media-id (Chevereto, URL-only, blob, placeholder)', () => {
		const html = [
			'<img src="https://chevereto.example/x.png">',
			'<img src="/api/v1/files/media/1/photo.png">',
			'<img src="blob:http://localhost/123" data-uploading="true" data-placeholder-id="p1">',
			'<img src="/b.png" data-media-id="m1">'
		].join('');
		assert.deepEqual(extractDataMediaIds(html), ['m1']);
	});
});

describe('uniqueMediaIds / mediaSetKey', () => {
	it('collapses duplicate ids and drops empties', () => {
		assert.deepEqual([...uniqueMediaIds(['m1', 'm1', '', 'm2'])].sort(), ['m1', 'm2']);
	});

	it('produces an order-independent key', () => {
		assert.equal(mediaSetKey(['m2', 'm1']), mediaSetKey(['m1', 'm2', 'm1']));
	});

	it('produces different keys for different sets', () => {
		assert.notEqual(mediaSetKey(['m1']), mediaSetKey(['m1', 'm2']));
		assert.equal(mediaSetKey([]), mediaSetKey(['']));
	});
});

describe('computeWorkMemoMediaDiff', () => {
	function assoc(id, mediaId, position = 0) {
		return {
			id,
			memo_id: 'memo1',
			media_id: mediaId,
			position,
			created: ''
		};
	}

	it('does nothing when the sets match', () => {
		const diff = computeWorkMemoMediaDiff(['m1', 'm2'], [assoc('a1', 'm1'), assoc('a2', 'm2')]);
		assert.deepEqual(diff, { attach: [], detach: [] });
	});

	it('attaches a media the body references but the server does not', () => {
		const diff = computeWorkMemoMediaDiff(['m1', 'm2'], [assoc('a1', 'm1')]);
		assert.deepEqual(diff.attach, ['m2']);
		assert.deepEqual(diff.detach, []);
	});

	it('detaches an association the body no longer references', () => {
		const diff = computeWorkMemoMediaDiff(['m1'], [assoc('a1', 'm1'), assoc('a2', 'm2')]);
		assert.deepEqual(diff.attach, []);
		assert.deepEqual(
			diff.detach.map((a) => a.id),
			['a2']
		);
	});

	it('handles several attaches and detaches at once', () => {
		const diff = computeWorkMemoMediaDiff(
			['m1', 'm3'],
			[assoc('a1', 'm1'), assoc('a2', 'm2'), assoc('a4', 'm4')]
		);
		assert.deepEqual(diff.attach, ['m3']);
		assert.deepEqual(diff.detach.map((a) => a.id).sort(), ['a2', 'a4']);
	});

	it('collapses a media referenced by several nodes into one desired id', () => {
		const html =
			'<img data-media-id="m1"><p>x</p><img data-media-id="m1"><img data-media-id="m1">';
		const desired = extractDataMediaIds(html);
		assert.deepEqual(desired, ['m1', 'm1', 'm1']);

		// Two nodes removed, one still referencing m1 -> keep the association.
		const diff = computeWorkMemoMediaDiff(desired.slice(0, 1), [assoc('a1', 'm1')]);
		assert.deepEqual(diff, { attach: [], detach: [] });
	});

	it('keeps the association while any node still references the media', () => {
		const afterDeletingOneNode = ['m1'];
		const diff = computeWorkMemoMediaDiff(afterDeletingOneNode, [assoc('a1', 'm1')]);
		assert.deepEqual(diff.detach, []);
	});

	it('detaches once the last node referencing the media is gone', () => {
		const diff = computeWorkMemoMediaDiff(extractDataMediaIds('<p>no images</p>'), [
			assoc('a1', 'm1')
		]);
		assert.deepEqual(diff.attach, []);
		assert.deepEqual(
			diff.detach.map((a) => a.id),
			['a1']
		);
	});

	it('ignores malformed association rows', () => {
		const diff = computeWorkMemoMediaDiff(['m1'], [
			{ id: '', media_id: 'm1', position: 0 },
			{ id: 'a2', media_id: '', position: 1 },
			null
		]);
		assert.deepEqual(diff.attach, ['m1']);
		assert.deepEqual(diff.detach, []);
	});

	it('collapses duplicate server rows for one media, keeping the lowest position', () => {
		const diff = computeWorkMemoMediaDiff(
			['m1'],
			[assoc('a2', 'm1', 5), assoc('a1', 'm1', 1)]
		);
		assert.deepEqual(diff.attach, []);
		assert.deepEqual(
			diff.detach.map((a) => a.id),
			['a2']
		);
	});

	it('never rewrites position and never orders by it', () => {
		const associations = [assoc('a2', 'm2', 9), assoc('a1', 'm1', 0)];
		const diff = computeWorkMemoMediaDiff(['m1', 'm2'], associations);
		assert.deepEqual(diff, { attach: [], detach: [] });
		assert.deepEqual(associations.map((a) => a.position), [9, 0]);
	});

	it('attaches in body order for a deterministic request sequence', () => {
		const desired = extractDataMediaIds(
			'<img data-media-id="m3"><img data-media-id="m1"><img data-media-id="m2">'
		);
		const diff = computeWorkMemoMediaDiff(desired, []);
		assert.deepEqual(diff.attach, ['m3', 'm1', 'm2']);
	});
});

describe('WorkMemoMediaReconciler', () => {
	/**
	 * A tiny stateful stand-in for the association endpoints: attach/detach
	 * really mutate the list, so a later reconcile sees what earlier passes did
	 * (exactly like the real server). `attach`/`detach` options inject a failure
	 * or custom behaviour instead of the stateful default.
	 */
	function makeHarness(options = {}) {
		const calls = { list: [], attach: [], detach: [] };
		const server = [...(options.associations ?? [])];
		let listOverride = null;
		const attachOverride = options.attach ?? null;
		const detachOverride = options.detach ?? null;
		let nextId = 1;

		const reconciler = new WorkMemoMediaReconciler({
			list: async (memoId) => {
				calls.list.push(memoId);
				if (listOverride) return listOverride(memoId);
				return server.map((a) => ({ ...a }));
			},
			attach: async (memoId, mediaId) => {
				calls.attach.push({ memoId, mediaId });
				if (attachOverride) return attachOverride(memoId, mediaId);
				if (server.some((a) => a.media_id === mediaId)) throw { status: 409 };
				const row = {
					id: `a${nextId++}`,
					memo_id: memoId,
					media_id: mediaId,
					position: server.length,
					created: ''
				};
				server.push(row);
				return row;
			},
			detach: async (memoId, associationId) => {
				calls.detach.push({ memoId, associationId });
				if (detachOverride) return detachOverride(memoId, associationId);
				const index = server.findIndex((a) => a.id === associationId);
				if (index === -1) throw { status: 404 };
				server.splice(index, 1);
			}
		});

		return {
			reconciler,
			calls,
			get server() {
				return server;
			},
			setListImpl: (fn) => {
				listOverride = fn;
			}
		};
	}

	const assoc = (id, mediaId) => ({
		id,
		memo_id: 'memo1',
		media_id: mediaId,
		position: 0,
		created: ''
	});

	it('does not list or attach before a memo id is known', async () => {
		const h = makeHarness();
		const result = await h.reconciler.reconcile(['m1']);
		assert.equal(result.skipped, 'no-memo');
		assert.equal(h.calls.list.length, 0);
		assert.equal(h.calls.attach.length, 0);
		assert.equal(h.calls.detach.length, 0);
	});

	it('runs one recovery pass on initial load of an existing memo', async () => {
		const h = makeHarness({ associations: [assoc('a2', 'm2')] });
		h.reconciler.setMemoId('memo1');

		const result = await h.reconciler.reconcile(['m1'], { force: true });

		assert.equal(result.skipped, null);
		assert.deepEqual(h.calls.list, ['memo1']);
		assert.deepEqual(h.calls.attach, [{ memoId: 'memo1', mediaId: 'm1' }]);
		assert.deepEqual(h.calls.detach, [{ memoId: 'memo1', associationId: 'a2' }]);
	});

	it('re-attaches a media whose Task 1 attach failed', async () => {
		// Body references m1, server has nothing -> the missing association is
		// rebuilt from data-media-id.
		const h = makeHarness({ associations: [] });
		h.reconciler.setMemoId('memo1');
		await h.reconciler.reconcile(['m1'], { force: true });
		assert.deepEqual(h.calls.attach, [{ memoId: 'memo1', mediaId: 'm1' }]);
	});

	it('skips without any request when the media set did not change', async () => {
		const h = makeHarness();
		h.reconciler.setMemoId('memo1');
		await h.reconciler.reconcile(['m1'], { force: true });
		assert.equal(h.calls.list.length, 1);

		// Ordinary typing: same media set, so no list/attach/detach at all.
		for (const _ of [1, 2, 3]) {
			const result = await h.reconciler.reconcile(['m1']);
			assert.equal(result.skipped, 'unchanged');
		}
		assert.equal(h.calls.list.length, 1);
		assert.equal(h.calls.attach.length, 1);
		assert.equal(h.calls.detach.length, 0);
	});

	it('re-runs when the media set changes', async () => {
		const h = makeHarness({ associations: [] });
		h.reconciler.setMemoId('memo1');
		await h.reconciler.reconcile(['m1'], { force: true });
		await h.reconciler.reconcile(['m1', 'm2']);
		assert.equal(h.calls.list.length, 2);
		assert.deepEqual(h.calls.attach.map((c) => c.mediaId), ['m1', 'm2']);
	});

	it('is order-independent: reordering images triggers no request', async () => {
		const h = makeHarness({ associations: [assoc('a1', 'm1'), assoc('a2', 'm2')] });
		h.reconciler.setMemoId('memo1');
		await h.reconciler.reconcile(['m1', 'm2'], { force: true });
		const result = await h.reconciler.reconcile(['m2', 'm1']);
		assert.equal(result.skipped, 'unchanged');
		assert.equal(h.calls.list.length, 1);
	});

	it('treats attach 409 as success (association already present)', async () => {
		const h = makeHarness({
			associations: [],
			attach: async () => {
				throw { status: 409 };
			}
		});
		h.reconciler.setMemoId('memo1');
		const result = await h.reconciler.reconcile(['m1'], { force: true });
		assert.deepEqual(result.attached, ['m1']);
		assert.equal(result.failed, 0);
		assert.equal(h.calls.attach.length, 1); // no retry
	});

	it('treats detach 404 as success (association already gone)', async () => {
		const h = makeHarness({
			associations: [assoc('a1', 'm1')],
			detach: async () => {
				throw { status: 404 };
			}
		});
		h.reconciler.setMemoId('memo1');
		const result = await h.reconciler.reconcile([], { force: true });
		assert.deepEqual(result.detached, ['a1']);
		assert.equal(result.failed, 0);
		assert.equal(h.calls.detach.length, 1); // no retry
	});

	it('records attach network/5xx failure once and never retries in a loop', async () => {
		const h = makeHarness({
			associations: [],
			attach: async () => {
				throw { status: 500 };
			}
		});
		h.reconciler.setMemoId('memo1');
		const result = await h.reconciler.reconcile(['m1'], { force: true });
		assert.equal(result.failed, 1);
		assert.deepEqual(result.attached, []);
		assert.equal(h.calls.attach.length, 1);

		// A failed pass must not record the key, so the next explicit trigger
		// retries; but nothing retries on its own.
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(h.calls.attach.length, 1);
		assert.equal(h.reconciler.lastKey, null);
	});

	it('retries the same desired set on the next explicit trigger after a mutation failure', async () => {
		let shouldFail = true;
		const h = makeHarness({
			associations: [],
			attach: async (memoId, mediaId) => {
				if (shouldFail) throw { status: 500 };
				return { id: 'a1', memo_id: memoId, media_id: mediaId, position: 0, created: '' };
			}
		});
		h.reconciler.setMemoId('memo1');

		const failed = await h.reconciler.reconcile(['m1'], { force: true });
		assert.equal(failed.failed, 1);
		assert.equal(h.reconciler.lastKey, null);
		shouldFail = false;

		const retried = await h.reconciler.reconcile(['m1']);
		assert.equal(retried.failed, 0);
		assert.deepEqual(retried.attached, ['m1']);
		assert.equal(h.calls.attach.length, 2);
		assert.equal(h.reconciler.lastKey, 'm1');
	});

	it('records detach network/5xx failure once and never retries in a loop', async () => {
		const h = makeHarness({
			associations: [assoc('a1', 'm1')],
			detach: async () => {
				throw { status: 503 };
			}
		});
		h.reconciler.setMemoId('memo1');
		const result = await h.reconciler.reconcile([], { force: true });
		assert.equal(result.failed, 1);
		assert.deepEqual(result.detached, []);
		assert.equal(h.calls.detach.length, 1);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(h.calls.detach.length, 1);
	});

	it('does not record the media key when the list request fails', async () => {
		let attempts = 0;
		const h = makeHarness();
		h.reconciler.setMemoId('memo1');
		h.setListImpl(async () => {
			attempts += 1;
			throw { status: 500 };
		});

		const first = await h.reconciler.reconcile(['m1'], { force: true });
		assert.equal(first.skipped, 'list-failed');
		assert.equal(attempts, 1);
		assert.equal(h.calls.attach.length, 0);
		assert.equal(h.calls.detach.length, 0);

		// The key was not recorded, so a later trigger is allowed to retry once.
		const second = await h.reconciler.reconcile(['m1']);
		assert.equal(second.skipped, 'list-failed');
		assert.equal(attempts, 2);
	});

	it('drops a stale pass: an older response never repairs a newer state', async () => {
		const h = makeHarness();
		h.reconciler.setMemoId('memo1');

		let resolveFirstList;
		h.setListImpl(
			() =>
				new Promise((resolve) => {
					resolveFirstList = resolve;
				})
		);

		// Pass A starts and hangs on its list request.
		const passA = h.reconciler.reconcile(['m1'], { force: true });
		// The user keeps editing: pass B starts and bumps the generation.
		h.setListImpl(async () => []);
		const passB = h.reconciler.reconcile(['m1', 'm2'], { force: true });

		// Pass A's response finally arrives, describing an outdated world.
		resolveFirstList([assoc('a9', 'm9')]);
		const resultA = await passA;
		const resultB = await passB;

		assert.equal(resultA.skipped, 'stale');
		assert.deepEqual(resultA.attached, []);
		assert.deepEqual(resultA.detached, []);

		assert.equal(resultB.skipped, null);
		// Only the newest pass mutated, and only for m1/m2.
		assert.deepEqual(h.calls.attach.map((c) => c.mediaId).sort(), ['m1', 'm2']);
		assert.equal(h.calls.detach.length, 0); // a9 was never detached by the stale pass
	});

	it('repairs a late old attach by re-listing and draining the latest desired set', async () => {
		const server = [];
		let releaseAttach;
		let signalAttachStarted;
		const attachStarted = new Promise((resolve) => (signalAttachStarted = resolve));
		let activeMutations = 0;
		let maxActiveMutations = 0;
		const calls = { list: 0, attach: 0, detach: 0 };
		const reconciler = new WorkMemoMediaReconciler({
			list: async () => {
				calls.list += 1;
				return server.map((row) => ({ ...row }));
			},
			attach: async (memoId, mediaId) => {
				calls.attach += 1;
				activeMutations += 1;
				maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
				signalAttachStarted();
				await new Promise((resolve) => (releaseAttach = resolve));
				server.push({ id: 'a1', memo_id: memoId, media_id: mediaId, position: 0, created: '' });
				activeMutations -= 1;
				return server[server.length - 1];
			},
			detach: async (_memoId, associationId) => {
				calls.detach += 1;
				activeMutations += 1;
				maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
				server.splice(
					server.findIndex((row) => row.id === associationId),
					1
				);
				activeMutations -= 1;
			}
		});
		reconciler.setMemoId('memo1');

		const oldPass = reconciler.reconcile(['m1'], { force: true });
		await attachStarted;
		const latestPass = reconciler.reconcile([], { force: true });
		releaseAttach();

		assert.equal((await oldPass).skipped, 'stale');
		assert.equal((await latestPass).skipped, null);
		assert.deepEqual(server, []);
		assert.deepEqual(calls, { list: 2, attach: 1, detach: 1 });
		assert.equal(maxActiveMutations, 1);
		assert.equal(reconciler.lastKey, '');
	});

	it('repairs a late old detach by re-listing and draining the latest desired set', async () => {
		const server = [assoc('a1', 'm1')];
		let releaseDetach;
		let signalDetachStarted;
		const detachStarted = new Promise((resolve) => (signalDetachStarted = resolve));
		let activeMutations = 0;
		let maxActiveMutations = 0;
		const calls = { list: 0, attach: 0, detach: 0 };
		const reconciler = new WorkMemoMediaReconciler({
			list: async () => {
				calls.list += 1;
				return server.map((row) => ({ ...row }));
			},
			attach: async (memoId, mediaId) => {
				calls.attach += 1;
				activeMutations += 1;
				maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
				const row = { id: 'a2', memo_id: memoId, media_id: mediaId, position: 0, created: '' };
				server.push(row);
				activeMutations -= 1;
				return row;
			},
			detach: async (_memoId, associationId) => {
				calls.detach += 1;
				activeMutations += 1;
				maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
				signalDetachStarted();
				await new Promise((resolve) => (releaseDetach = resolve));
				server.splice(
					server.findIndex((row) => row.id === associationId),
					1
				);
				activeMutations -= 1;
			}
		});
		reconciler.setMemoId('memo1');

		const oldPass = reconciler.reconcile([], { force: true });
		await detachStarted;
		const latestPass = reconciler.reconcile(['m1'], { force: true });
		releaseDetach();

		assert.equal((await oldPass).skipped, 'stale');
		assert.equal((await latestPass).skipped, null);
		assert.deepEqual(server.map((row) => row.media_id), ['m1']);
		assert.deepEqual(calls, { list: 2, attach: 1, detach: 1 });
		assert.equal(maxActiveMutations, 1);
		assert.equal(reconciler.lastKey, 'm1');
	});

	it('replaces a not-yet-started request with the latest desired set', async () => {
		let releaseList;
		let signalListStarted;
		const listStarted = new Promise((resolve) => (signalListStarted = resolve));
		let lists = 0;
		const attached = [];
		const reconciler = new WorkMemoMediaReconciler({
			list: async () => {
				lists += 1;
				if (lists === 1) {
					signalListStarted();
					await new Promise((resolve) => (releaseList = resolve));
				}
				return [];
			},
			attach: async (memoId, mediaId) => {
				attached.push(mediaId);
				return { id: mediaId, memo_id: memoId, media_id: mediaId, position: 0, created: '' };
			},
			detach: async () => {}
		});
		reconciler.setMemoId('memo1');

		const first = reconciler.reconcile(['old'], { force: true });
		await listStarted;
		const superseded = reconciler.reconcile(['middle'], { force: true });
		const latest = reconciler.reconcile(['latest'], { force: true });
		releaseList();

		assert.equal((await first).skipped, 'stale');
		assert.equal((await superseded).skipped, 'stale');
		assert.equal((await latest).skipped, null);
		assert.deepEqual(attached, ['latest']);
		assert.equal(lists, 2);
	});

	it('stops a stale pass before it performs any mutation', async () => {
		const h = makeHarness({
			associations: [assoc('a1', 'm1')]
		});
		h.reconciler.setMemoId('memo1');

		let releaseList;
		h.setListImpl(
			() =>
				new Promise((resolve) => {
					releaseList = resolve;
				})
		);

		const pass = h.reconciler.reconcile(['m1'], { force: true });
		// Something newer happens before the list resolves.
		h.reconciler.invalidate();
		releaseList([]);

		const result = await pass;
		assert.equal(result.skipped, 'stale');
		assert.equal(h.calls.detach.length, 0);
		assert.equal(h.calls.attach.length, 0);
	});

	it('invalidate() makes a fresh pass run normally afterwards', async () => {
		const h = makeHarness({ associations: [] });
		h.reconciler.setMemoId('memo1');
		h.reconciler.invalidate();
		const before = h.reconciler.currentGeneration;

		const result = await h.reconciler.reconcile(['m1'], { force: true });

		assert.equal(result.skipped, null);
		assert.ok(h.reconciler.currentGeneration > before);
		assert.deepEqual(h.calls.attach.map((c) => c.mediaId), ['m1']);
	});

	it('tracks the memo id it was told about', () => {
		const h = makeHarness();
		assert.equal(h.reconciler.memoId, null);
		h.reconciler.setMemoId('memo9');
		assert.equal(h.reconciler.memoId, 'memo9');
		assert.equal(h.reconciler.lastKey, null);
	});
});

describe('pending upload exclusion (isMediaSetStable)', () => {
	it('blocks reconciliation while a blob placeholder is present', () => {
		assert.equal(isMediaSetStable('<img src="blob:x" data-uploading="true">'), false);
	});

	it('allows reconciliation for stable image and plain content', () => {
		assert.equal(isMediaSetStable('<img data-media-id="m1" src="/a.png">'), true);
		assert.equal(isMediaSetStable('<p>hello</p>'), true);
	});
});

describe('production component wiring', () => {
	const workMemoEditorSource = readFileSync(
		new URL('./WorkMemoEditor.svelte', import.meta.url),
		'utf8'
	);
	const sessionSource = readFileSync(
		new URL('./workMemoEditingSession.ts', import.meta.url),
		'utf8'
	);
	const tiptapEditorSource = readFileSync(
		new URL('../editor/TiptapEditor.svelte', import.meta.url),
		'utf8'
	);

	it('uses the reconciler as the only Work Memo association mutation owner', () => {
		assert.doesNotMatch(workMemoEditorSource, /WorkMemoMediaCoordinator|mediaCoordinator/);
		assert.doesNotMatch(workMemoEditorSource, /onMediaCommitted|handleMediaCommitted/);
		// The editor hands the media API to the shared session and never mutates
		// associations itself, so each function appears exactly twice: the import
		// and the injected dependency.
		for (const fn of ['attachWorkMemoMedia', 'detachWorkMemoMedia', 'listWorkMemoMedia']) {
			assert.equal(
				(workMemoEditorSource.match(new RegExp(fn, 'g')) ?? []).length,
				2,
				`${fn} must only be imported and passed to the session`
			);
		}
		assert.doesNotMatch(
			workMemoEditorSource,
			/mediaReconciler/,
			'the reconciler is owned by the session, not by the editor'
		);
	});

	it('new memo creation only navigates and leaves association work to the edit route', () => {
		const start = workMemoEditorSource.indexOf('onCreated: (id) => {');
		const end = workMemoEditorSource.indexOf('\n\t\t\t},', start);
		assert.notEqual(start, -1);
		assert.notEqual(end, -1);
		const onCreatedBlock = workMemoEditorSource.slice(start, end);
		assert.match(onCreatedBlock, /goto\(`\/worklog\/\$\{date\}\/\$\{id\}`/);
		assert.doesNotMatch(onCreatedBlock, /reconcile|attach|mediaCoordinator|setMemoId/);
	});

	it('the edit route sets the memo id and forces one initial reconciliation', () => {
		// The editor used to perform this recovery pass inline. It now hands the
		// memo id to the shared session, which owns the pass for both hosts; the
		// new-memo flow is kept out of it via `reconcileOnCreate: false`, because
		// this component navigates away and the edit route owns that one pass.
		assert.match(workMemoEditorSource, /memoId: memo\?\.id \?\? null,/);
		assert.match(workMemoEditorSource, /reconcileOnCreate: false,/);

		assert.match(
			sessionSource,
			/if \(options\.memoId\) \{[\s\S]*?setMemoId\(options\.memoId\);[\s\S]*?reconcileMediaAssociations\(this\.content, \{ force: true \}\);/
		);
		assert.match(
			sessionSource,
			/if \(this\.reconcileOnCreate\) \{/,
			'the post-create pass must stay behind the reconcileOnCreate switch'
		);
	});

	it('deleted upload placeholders are neither reinserted nor separately associated', () => {
		assert.match(
			tiptapEditorSource,
			/const replaced = editor\.commands\.replacePlaceholderWithImage\([\s\S]*?if \(!replaced\) return;/
		);
		assert.doesNotMatch(tiptapEditorSource, /onMediaCommitted/);
	});
});
