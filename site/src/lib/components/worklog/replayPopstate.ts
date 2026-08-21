/**
 * Determine the history.go() delta for replaying a popstate navigation.
 *
 * SvelteKit's `navigation.delta` reports the original direction and magnitude
 * of a history traversal:
 * - Back navigation: delta < 0
 * - Forward navigation: delta > 0
 *
 * This helper returns a non-zero integer that preserves that direction.
 * A missing or zero delta falls back to -1 (back) to match the common
 * "leave editor" case.
 */
export function getPopstateReplayDelta(delta: number | undefined): number {
	if (typeof delta !== 'number' || delta === 0) return -1;
	return delta;
}
