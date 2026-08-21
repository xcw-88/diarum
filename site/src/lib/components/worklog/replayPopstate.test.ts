// @ts-nocheck
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPopstateReplayDelta } from './replayPopstate.ts';

describe('getPopstateReplayDelta', () => {
	it('replays back navigation as negative delta', () => {
		assert.equal(getPopstateReplayDelta(-1), -1);
		assert.equal(getPopstateReplayDelta(-2), -2);
	});

	it('replays forward navigation as positive delta', () => {
		assert.equal(getPopstateReplayDelta(1), 1);
		assert.equal(getPopstateReplayDelta(2), 2);
	});

	it('falls back to back when delta is missing or zero', () => {
		assert.equal(getPopstateReplayDelta(undefined), -1);
		assert.equal(getPopstateReplayDelta(0), -1);
	});
});
