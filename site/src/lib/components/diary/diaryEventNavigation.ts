/**
 * The two pure decisions the diary event editor needs around durability, kept
 * in their own module so they can be unit tested with plain `node:test` — the
 * project has no component test framework.
 *
 * Nothing here imports Svelte, `$app/*` or `$lib`. The durable-failure type
 * comes in through a **type-only** import, which the compiler erases, and the
 * class itself is recognised by name rather than by `instanceof`. That keeps
 * this module free of *runtime* imports, which is what lets `node:test` load it:
 * Node's ESM resolver does not guess an extension for a TypeScript specifier, so
 * a module a test imports must not pull in a sibling module at runtime.
 * `workMemoDurability.test.ts` asserts the class still carries that name.
 */

import type { WorkMemoDurabilityFailure } from '../worklog/workMemoDurability';

/**
 * What the page needs from the event editor that currently holds the slot. Both
 * members delegate to the shared session, so no caller re-derives "is this safe
 * to leave?" from individual save-machine phases.
 */
export interface EditorDurability {
	hasDurabilityWork: () => boolean;
	flushDurably: () => Promise<void>;
}

export interface NavigationGuardInput {
	/** Path of the page the editor is currently mounted on. */
	fromPathname: string;
	/** Destination path, or null when the router did not supply one. */
	toPathname: string | null;
	/**
	 * The session's own answer to "is anything at stake?" — see
	 * `WorkMemoEditingSession.hasDurabilityWork()`. This module never inspects
	 * save-machine phases itself: the session owns that definition.
	 */
	hasDurabilityWork: boolean;
}

/**
 * Whether a navigation must be held back until the open event editor is
 * durable.
 *
 * Same-pathname navigations (a query or hash change, e.g. the diary table of
 * contents jumping to a heading, or the share modal writing `?` state) do not
 * unmount the event editor — SvelteKit keeps the route component — so the work
 * in it cannot be lost by them and holding them would break in-page anchors for
 * no benefit. Every navigation that leaves the pathname is held.
 *
 * An unknown destination (`toPathname === null`) is held: when the router cannot
 * say where the user is going, the conservative answer is the safe one, and the
 * caller replays it to the diary day it can reconstruct.
 */
export function shouldHoldNavigation(input: NavigationGuardInput): boolean {
	if (!input.hasDurabilityWork) return false;
	if (input.toPathname === null) return true;
	return input.toPathname !== input.fromPathname;
}

/** Translation key of the message a durability failure should show. */
export type DurabilityMessageKey =
	| 'diaryEvents.uploadFailed'
	| 'diaryEvents.attachmentsFailed'
	| 'diaryEvents.saveFailed'
	| 'diaryEvents.handoffFailed';

/** Mirrors `DURABILITY_ERROR_NAME` in `workMemoDurability`. */
const DURABILITY_ERROR_NAME = 'WorkMemoDurabilityError';

const MESSAGE_KEY_BY_REASON: Record<WorkMemoDurabilityFailure, DurabilityMessageKey> = {
	uploads: 'diaryEvents.uploadFailed',
	body: 'diaryEvents.uploadFailed',
	attachments: 'diaryEvents.attachmentsFailed',
	save: 'diaryEvents.saveFailed',
	destroyed: 'diaryEvents.saveFailed'
};

/**
 * Read the failure reason off a durability error without importing its class.
 *
 * Anchored on the error's `name` *and* on the reason being one this module knows
 * how to phrase, so an unrelated object that happens to expose a `reason` string
 * cannot smuggle a message through. Anything unrecognised yields null and the
 * caller falls back to the generic save message.
 */
function durabilityReasonOf(error: unknown): WorkMemoDurabilityFailure | null {
	if (typeof error !== 'object' || error === null) return null;
	const { name, reason } = error as { name?: unknown; reason?: unknown };
	if (name !== DURABILITY_ERROR_NAME) return null;
	if (typeof reason !== 'string') return null;
	return Object.prototype.hasOwnProperty.call(MESSAGE_KEY_BY_REASON, reason)
		? (reason as WorkMemoDurabilityFailure)
		: null;
}

/**
 * Map a durability failure to the message the user should see. Keeping the
 * failure a discriminated value rather than a message means the UI never has to
 * match on error text, and an unrecognised error still gets a usable message.
 */
export function durabilityMessageKey(error: unknown): DurabilityMessageKey {
	const reason = durabilityReasonOf(error);
	return reason ? MESSAGE_KEY_BY_REASON[reason] : 'diaryEvents.saveFailed';
}

/** Reason of a durability failure, or null for anything else. */
export function durabilityFailureReason(error: unknown): WorkMemoDurabilityFailure | null {
	return durabilityReasonOf(error);
}
