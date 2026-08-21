// @ts-nocheck
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	WorkMemoSaveMachine,
	type WorkMemoSnapshot,
	type SaveMachineState
} from './workMemoSaveMachine.ts';

const emptySnapshot: WorkMemoSnapshot = { content: '', status: 'normal', isPinned: false };
const snapshotA: WorkMemoSnapshot = { content: '<p>A</p>', status: 'normal', isPinned: false };
const snapshotB: WorkMemoSnapshot = { content: '<p>B</p>', status: 'pending', isPinned: false };
const snapshotC: WorkMemoSnapshot = { content: '<p>C</p>', status: 'completed', isPinned: true };

function isContentEmpty(html: string): boolean {
	if (!html) return true;
	return html.replace(/<[^>]*>/g, '').trim().length === 0;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMachine(options: {
	memoId?: string | null;
	initialSnapshot?: WorkMemoSnapshot;
	createDelay?: number;
	updateDelay?: number;
	createShouldFail?: boolean;
	updateShouldFail?: boolean;
	removeShouldFail?: boolean;
	onCreated?: (id: string) => void;
}) {
	const createCalls: WorkMemoSnapshot[] = [];
	const updateCalls: { id: string; snapshot: WorkMemoSnapshot }[] = [];
	const removeCalls: string[] = [];
	const states: SaveMachineState[] = [];

	const machine = new WorkMemoSaveMachine({
		date: '2026-08-21',
		memoId: options.memoId ?? null,
		initialSnapshot: options.initialSnapshot ?? emptySnapshot,
		create: async (_date, snapshot) => {
			createCalls.push(snapshot);
			if (options.createShouldFail) throw new Error('create failed');
			await wait(options.createDelay ?? 5);
			return 'memo-123';
		},
		update: async (id, snapshot) => {
			updateCalls.push({ id, snapshot });
			if (options.updateShouldFail) throw new Error('update failed');
			await wait(options.updateDelay ?? 5);
		},
		remove: async (id) => {
			removeCalls.push(id);
			if (options.removeShouldFail) throw new Error('remove failed');
		},
		onCreated: options.onCreated,
		onStateChange: (state) => states.push(state),
		debounceMs: 10,
		emptyContentPredicate: isContentEmpty
	});

	return { machine, createCalls, updateCalls, removeCalls, states };
}

describe('WorkMemoSaveMachine', () => {
	it('does not POST for an empty new memo', async () => {
		const { machine, createCalls } = createMachine({});
		machine.schedule(emptySnapshot);
		await wait(50);
		assert.equal(createCalls.length, 0);
		assert.equal(machine.getState().phase, 'idle');
	});

	it('POSTs exactly once when scheduling multiple times quickly', async () => {
		const { machine, createCalls } = createMachine({});
		machine.schedule(snapshotA);
		machine.schedule({ ...snapshotA, content: '<p>A1</p>' });
		machine.schedule({ ...snapshotA, content: '<p>A2</p>' });
		await wait(100);
		assert.equal(createCalls.length, 1);
		assert.equal(machine.getState().memoId, 'memo-123');
	});

	it('PUTs latest content after POST during which user kept typing', async () => {
		const { machine, createCalls, updateCalls } = createMachine({ createDelay: 40 });
		machine.schedule(snapshotA);
		await wait(20);
		// While POST is still running, user types more.
		machine.schedule(snapshotB);
		machine.schedule(snapshotC);
		await wait(200);

		assert.equal(createCalls.length, 1);
		assert.ok(updateCalls.length >= 1, 'expected at least one PUT');
		// The final PUT must contain the latest snapshot.
		const lastUpdate = updateCalls[updateCalls.length - 1];
		assert.equal(lastUpdate.snapshot.content, snapshotC.content);
		assert.equal(lastUpdate.snapshot.status, snapshotC.status);
		assert.equal(lastUpdate.snapshot.isPinned, snapshotC.isPinned);
	});

	it('serializes PUTs so two updates never overlap', async () => {
		const { machine, updateCalls } = createMachine({ memoId: 'memo-123', updateDelay: 40 });
		let overlap = false;
		let inFlight = 0;

		// Wrap update to detect overlap.
		const originalUpdate = (machine as any).update.bind(machine);
		(machine as any).update = async (id: string, snapshot: WorkMemoSnapshot) => {
			inFlight++;
			if (inFlight > 1) overlap = true;
			await originalUpdate(id, snapshot);
			inFlight--;
		};

		machine.schedule(snapshotA);
		await wait(5);
		machine.schedule(snapshotB);
		await wait(5);
		machine.schedule(snapshotC);
		await wait(200);

		assert.equal(overlap, false);
		assert.ok(updateCalls.length >= 1);
	});

	it('saves change B after request A completes, without falsely clearing dirty', async () => {
		const { machine, updateCalls } = createMachine({ memoId: 'memo-123', updateDelay: 40 });
		machine.schedule(snapshotA);
		await wait(20);
		machine.schedule(snapshotB);
		await wait(200);

		const lastUpdate = updateCalls[updateCalls.length - 1];
		assert.equal(lastUpdate.snapshot.content, snapshotB.content);
		assert.equal(machine.getState().phase, 'saved');
	});

	it('flush waits for all pending saves to complete', async () => {
		const { machine, updateCalls } = createMachine({ memoId: 'memo-123', updateDelay: 40 });
		machine.schedule(snapshotA);
		await wait(5);
		machine.schedule(snapshotB);
		const flushPromise = machine.flush();
		await flushPromise;

		assert.ok(updateCalls.length >= 1);
		const lastUpdate = updateCalls[updateCalls.length - 1];
		assert.equal(lastUpdate.snapshot.content, snapshotB.content);
		assert.equal(machine.getState().phase, 'saved');
	});

	it('delete waits for in-flight save and does not PUT after delete', async () => {
		const { machine, updateCalls, removeCalls } = createMachine({
			memoId: 'memo-123',
			updateDelay: 40
		});
		machine.schedule(snapshotA);
		// Wait until the update request is actually in flight.
		await wait(20);
		const deletePromise = machine.delete();
		// Try to schedule more while delete is running.
		machine.schedule(snapshotB);
		const ok = await deletePromise;

		assert.equal(ok, true);
		assert.equal(removeCalls.length, 1);
		assert.equal(removeCalls[0], 'memo-123');
		// The in-flight update completed, but the late schedule during delete was ignored.
		assert.equal(updateCalls.length, 1);
	});

	it('reports error state when update fails and allows retry', async () => {
		const { machine, updateCalls } = createMachine({ memoId: 'memo-123', updateShouldFail: true });
		machine.schedule(snapshotA);
		await wait(50);

		assert.equal(machine.getState().phase, 'error');
		assert.equal(updateCalls.length, 1);

		// Retry after failure.
		(machine as any).updateShouldFail = false; // not part of public API; use fresh machine in real usage
		// For the test, rebuild with failing=false by reassigning internal update.
		(machine as any).update = async (id: string, snapshot: WorkMemoSnapshot) => {
			updateCalls.push({ id, snapshot });
		};
		machine.schedule(snapshotB);
		await wait(50);

		assert.equal(machine.getState().phase, 'saved');
	});

	it('calls onCreated only after pending changes are saved', async () => {
		let createdId: string | null = null;
		const { machine, createCalls, updateCalls } = createMachine({
			createDelay: 20,
			onCreated: (id) => {
				createdId = id;
			}
		});
		machine.schedule(snapshotA);
		await wait(10);
		machine.schedule(snapshotB);
		await machine.flush();

		assert.equal(createCalls.length, 1);
		assert.ok(updateCalls.length >= 1);
		assert.equal(createdId, 'memo-123');
	});

	it('flushes pending changes before debounce fires', async () => {
		const { machine, updateCalls } = createMachine({
			memoId: 'memo-123',
			debounceMs: 10_000 // Long debounce so it would not fire naturally.
		});
		machine.schedule(snapshotA);
		await machine.flush();

		assert.equal(updateCalls.length, 1);
		assert.equal(updateCalls[0].snapshot.content, snapshotA.content);
		assert.equal(machine.getState().phase, 'saved');
	});

	it('flush rejects when save fails', async () => {
		const { machine } = createMachine({
			memoId: 'memo-123',
			updateShouldFail: true
		});
		machine.schedule(snapshotA);

		let rejected = false;
		try {
			await machine.flush();
		} catch {
			rejected = true;
		}

		assert.equal(rejected, true);
		assert.equal(machine.getState().phase, 'error');
	});
});
