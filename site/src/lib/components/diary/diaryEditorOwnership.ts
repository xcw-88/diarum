/**
 * Durable two-phase handoff for the single image-capable TipTap slot on the
 * diary page.
 *
 * Why this exists
 * ---------------
 * `TiptapEditor` registers its image/gallery handlers in a **module-level
 * singleton** (`editor/commands.ts`):
 *
 *     setImageUploadTrigger(handleSlashImage)      // on mount
 *     setImageUploadTrigger(null)                  // on destroy  <-- blanket
 *
 * Two consequences make a naive "swap the editors and let reactivity sort it
 * out" unsafe:
 *
 * 1. the second instance to mount silently overwrites the first one's handler;
 * 2. the first instance to *unmount* clears the singleton unconditionally, so
 *    it also wipes the handler the surviving instance still needs.
 *
 * Simply writing `{#if eventEditorActive} … {:else} <TiptapEditor/> {/if}` and
 * driving `eventEditorActive` from a post-render `$effect` therefore still
 * leaves a window in which both editors are mounted — and in that window the
 * legacy editor is the one that unmounts **last**, which is exactly the order
 * that nulls the event editor's triggers.
 *
 * The contract
 * ------------
 * The page must never have both editors mounted *at any point in time*, not
 * merely "almost always". This class enforces that by routing every change
 * through an explicit intermediate slot:
 *
 *     kind: 'legacy' --request--> 'none' --flush--> 'event' {target}
 *     kind: 'event'  --request--> 'none' --flush--> 'legacy'
 *
 * `apply({kind:'none'})` tears the outgoing editor down; the injected `flush`
 * (Svelte's `tick`) then resolves only once that teardown has actually reached
 * the DOM — i.e. once the outgoing component's `onDestroy` has run. Only after
 * that boundary is the incoming slot applied. The safety therefore does not
 * depend on the relative ordering of sibling effects inside a single flush:
 * there is a whole flush in between with no editor mounted at all.
 *
 * Event identity (added in Controller Review Fix 2)
 * ------------------------------------------------
 * A slot is `(kind, target)`, where `target` identifies *which* event surface is
 * mounted (`'new'` or `` `memo:<id>` ``). That identity is what makes
 * `event A -> event B` a real handoff rather than a same-kind early return:
 * two different targets are two different slots, so the transition always walks
 * the full `none -> flush -> event` path. Without it, switching events looked
 * like "the owner is already `event`" and the outgoing editor was swapped out
 * by a plain DOM diff — losing whatever the save machine had only queued.
 *
 * Durable release
 * ---------------
 * Because the outgoing editor now has something to lose, every transition that
 * leaves an `event` slot runs a caller-supplied `release` **while that editor is
 * still mounted** (phase 0). `release` is the editor's durable flush: an
 * upload-aware, save-and-association-awaiting promise. If it rejects, nothing is
 * applied at all — the slot keeps its current kind *and* target, so the caller's
 * editor stays mounted, editable and able to show the error.
 *
 * Rapid clicks
 * ------------
 * Policy: **serialise the release, then honour the latest intent.** Every
 * request is queued, never run in parallel, so several clicks cannot start
 * several releases at once. While a transition is in flight the pending intent
 * is simply overwritten, and the runner loop then processes the newest one. An
 * intermediate target that the user has already navigated away from is skipped
 * outright — it is never applied, so it is never even briefly mounted.
 */

/** Who holds the single image-capable slot. */
export type DiaryEditorOwner = 'legacy' | 'none' | 'event';

/** Alias kept for readability in the newer APIs. */
export type DiaryEditorKind = DiaryEditorOwner;

/** Target key for a brand new event draft. */
export const NEW_EVENT_TARGET = 'new';

/** Target key for an existing event, namespaced so it can never be confused
 *  with {@link NEW_EVENT_TARGET} whatever the id format turns out to be. */
export function memoEventTarget(id: string): string {
	return `memo:${id}`;
}

/** The id encoded in a `memo:<id>` target, or null for any other target. */
export function memoIdFromTarget(target: string | null): string | null {
	if (!target || !target.startsWith('memo:')) return null;
	return target.slice('memo:'.length);
}

export interface DiaryEditorSlot {
	kind: DiaryEditorOwner;
	/** Surface identity while `kind === 'event'`; always null otherwise. */
	target: string | null;
}

/** A transition the caller wants. */
export type DiaryEditorIntent =
	| { kind: 'event'; target: string }
	| { kind: 'legacy' };

/**
 * Makes the outgoing event editor durable. Injected rather than imported so this
 * module stays free of Svelte and `$lib` imports and can be unit tested.
 */
export type DiaryRelease = () => Promise<void>;

export interface DiaryEditorOwnershipOptions {
	/** Applies a slot. Called synchronously, in order. */
	apply: (slot: DiaryEditorSlot) => void;
	/**
	 * Resolves once everything applied so far has reached the DOM. In a Svelte
	 * component this is `tick`. It is the flush boundary that makes the handoff
	 * safe, so it must not be replaced with a microtask that resolves earlier.
	 */
	flush: () => Promise<void>;
}

interface Waiter {
	resolve: () => void;
	reject: (error: unknown) => void;
}

const NO_RELEASE: DiaryRelease = async () => {};

/** The owner that means "image-capable editor mounted". */
function mountsEditor(owner: DiaryEditorOwner): boolean {
	return owner !== 'none';
}

export class DiaryEditorOwnership {
	private readonly applySlot: (slot: DiaryEditorSlot) => void;
	private readonly flushDom: () => Promise<void>;

	private slot: DiaryEditorSlot = { kind: 'legacy', target: null };

	/**
	 * The newest requested transition, or null when the runner has caught up.
	 * Overwritten by later requests, which is what makes rapid clicks resolve to
	 * the user's last intent instead of replaying every intermediate hop.
	 */
	private intent: DiaryEditorIntent | null = null;
	/** Release for the intent currently being processed; latest call wins. */
	private release: DiaryRelease = NO_RELEASE;
	/**
	 * The slot whose outgoing editor has already been released. Reset whenever a
	 * new slot is applied, so a later handoff releases the editor it leaves.
	 */
	private releasedSlot: DiaryEditorSlot | null = null;
	private running = false;
	private waiters: Waiter[] = [];

	constructor(options: DiaryEditorOwnershipOptions) {
		this.applySlot = options.apply;
		this.flushDom = options.flush;
	}

	/** The owner currently applied. */
	get current(): DiaryEditorOwner {
		return this.slot.kind;
	}

	/** The surface identity currently applied, or null. */
	get target(): string | null {
		return this.slot.target;
	}

	/** The full applied slot. */
	get currentSlot(): DiaryEditorSlot {
		return { ...this.slot };
	}

	/**
	 * Hand the slot to an event surface identified by `target`.
	 *
	 * Resolves once that surface has been applied — which is always after the
	 * outgoing editor was released, torn down and committed to the DOM. Rejects
	 * when the outgoing editor could not be made durable; in that case nothing
	 * has been applied and the caller must keep its editor.
	 */
	enterEvent(target: string, release: DiaryRelease = NO_RELEASE): Promise<void> {
		return this.request({ kind: 'event', target }, release);
	}

	/**
	 * Hand the slot back to the legacy diary editor. Rejects when the outgoing
	 * event editor could not be made durable.
	 */
	exitEvent(release: DiaryRelease = NO_RELEASE): Promise<void> {
		return this.request({ kind: 'legacy' }, release);
	}

	private request(intent: DiaryEditorIntent, release: DiaryRelease): Promise<void> {
		this.intent = intent;
		this.release = release;
		const waiter = this.defer();
		this.waiters.push(waiter);
		this.start();
		return waiter.promise;
	}

	private defer(): Waiter & { promise: Promise<void> } {
		let resolve: () => void = () => {};
		let reject: (error: unknown) => void = () => {};
		const promise = new Promise<void>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	private start(): void {
		if (this.running) return;
		this.running = true;
		void this.drain();
	}

	/**
	 * Serialised runner. Each iteration services the newest intent and settles
	 * exactly the waiters that were registered when that iteration began, so a
	 * request that arrives mid-transition is answered by the next iteration and
	 * never by the one already in flight.
	 */
	private async drain(): Promise<void> {
		try {
			while (this.intent) {
				const intent = this.intent;
				this.intent = null;
				const waiters = this.waiters.splice(0);
				try {
					await this.applyIntent(intent, this.release);
					for (const waiter of waiters) waiter.resolve();
				} catch (error) {
					// The outgoing editor is still mounted and untouched: every
					// request in this batch reports the same failure.
					for (const waiter of waiters) waiter.reject(error);
				}
			}
		} finally {
			this.running = false;
			// JavaScript cannot interleave between the final loop check and this
			// assignment, but retain a defensive restart if that ever changes.
			if (this.intent) this.start();
		}
	}

	private async applyIntent(intent: DiaryEditorIntent, release: DiaryRelease): Promise<void> {
		if (this.matches(intent)) return;

		// Coalesce: a newer event target arrived while this one waited its turn.
		// Applying the intermediate target would mount a surface the user has
		// already left, so skip it and let the runner service the newest intent.
		if (this.isSuperseded(intent)) return;

		// Phase 0 — make the OUTGOING event editor durable while it is still
		// mounted. A rejection propagates and leaves the slot untouched.
		//
		// `releasedSlot` stops the same outgoing editor from being released twice
		// when a superseded target is followed by the target that replaced it:
		// the slot never moved in between, so there is nothing new to flush.
		if (this.slot.kind === 'event' && !this.sameSlot(this.releasedSlot, this.slot)) {
			await release();
			this.releasedSlot = { ...this.slot };
		}

		// The release awaited, so a newer intent may have arrived meanwhile.
		// Re-check before committing to a target the user has already left.
		if (this.isSuperseded(intent)) return;

		// Phase 1 — tear the outgoing editor down and let that land in the DOM.
		this.apply({ kind: 'none', target: null });
		await this.flushDom();

		// Phase 2 — only now may the incoming surface mount.
		this.apply(
			intent.kind === 'event'
				? { kind: 'event', target: intent.target }
				: { kind: 'legacy', target: null }
		);
	}

	/** A newer event intent has taken over the one being processed. */
	private isSuperseded(intent: DiaryEditorIntent): boolean {
		const newest = this.intent;
		return (
			newest !== null &&
			newest.kind === 'event' &&
			intent.kind === 'event' &&
			newest.target !== intent.target
		);
	}

	private sameSlot(a: DiaryEditorSlot | null, b: DiaryEditorSlot): boolean {
		return a !== null && a.kind === b.kind && a.target === b.target;
	}

	private matches(intent: DiaryEditorIntent): boolean {
		if (intent.kind === 'legacy') return this.slot.kind === 'legacy';
		return this.slot.kind === 'event' && this.slot.target === intent.target;
	}

	private apply(slot: DiaryEditorSlot): void {
		if (this.slot.kind === slot.kind && this.slot.target === slot.target) return;
		this.slot = slot;
		// A newly applied slot has never been released.
		this.releasedSlot = null;
		this.applySlot(slot);
	}
}

function normalizeSlot(value: DiaryEditorOwner | DiaryEditorSlot): DiaryEditorSlot {
	return typeof value === 'string' ? { kind: value, target: null } : value;
}

/**
 * True when two slots could both hold an image-capable editor — that is, when
 * they mount *different* surfaces and would therefore fight over the
 * module-level trigger singleton.
 *
 * Note that two different event targets DO overlap: `memo:A` and `memo:B` are
 * distinct editors. Applying them back to back is exactly the bug a plain
 * DOM diff produced, which is why the transition always inserts `'none'`.
 * Exported so the tests can assert the invariant directly.
 */
export function ownersOverlap(
	a: DiaryEditorOwner | DiaryEditorSlot,
	b: DiaryEditorOwner | DiaryEditorSlot
): boolean {
	const left = normalizeSlot(a);
	const right = normalizeSlot(b);
	if (!mountsEditor(left.kind) || !mountsEditor(right.kind)) return false;
	return left.kind !== right.kind || left.target !== right.target;
}
