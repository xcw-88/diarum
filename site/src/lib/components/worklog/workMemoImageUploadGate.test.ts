// @ts-nocheck
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkMemoImageUploadGate } from './workMemoImageUploadGate.ts';

describe('WorkMemoImageUploadGate', () => {
	it('waits until every active upload completes', async () => {
		const gate = new WorkMemoImageUploadGate();
		gate.update({ pending: 2, error: null });
		let settled = false;
		const waiting = gate.wait().then(() => (settled = true));

		gate.update({ pending: 1, error: null });
		await Promise.resolve();
		assert.equal(settled, false);

		gate.update({ pending: 0, error: null });
		await waiting;
		assert.equal(settled, true);
	});

	it('rejects navigation waiting on an upload that fails', async () => {
		const gate = new WorkMemoImageUploadGate();
		gate.update({ pending: 1, error: null });
		const waiting = gate.wait();
		gate.update({ pending: 0, error: 'upload failed' });
		await assert.rejects(waiting, /upload failed/);
	});

	it('does not permanently block navigation after a completed failure', async () => {
		const gate = new WorkMemoImageUploadGate();
		gate.update({ pending: 1, error: null });
		gate.update({ pending: 0, error: 'upload failed' });
		await gate.wait();
	});
});
