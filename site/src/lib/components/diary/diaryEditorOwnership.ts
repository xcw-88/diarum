/**
 * Two-phase handoff for the single image-capable TipTap slot on the diary page.
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
 * through an explicit intermediate owner:
 *
 *     'legacy' --enter--> 'none' --flush--> 'event'
 *     'event'  --exit---> 'none' --flush--> 'legacy'
 *
 * `apply('none')` tears the outgoing editor down; the injected `flush` (Svelte's
 * `tick`) then resolves only once that teardown has actually reached the DOM —
 * i.e. once the outgoing component's `onDestroy` has run. Only after that
 * boundary is the incoming owner applied. The safety therefore does not depend
 * on the relative ordering of sibling effects inside a single flush: there is a
 * whole flush in between with no editor mounted at all.
 *
 * Transitions are serialised, so rapid clicks cannot interleave two handoffs and
 * skip the intermediate step.
 */

export type DiaryEditorOwner = 'legacy' | 'none' | 'event';

export interface DiaryEditorOwnershipOptions {
	/** Applies an owner. Called synchronously, in order. */
	apply: (owner: DiaryEditorOwner) => void;
	/**
	 * Resolves once everything applied so far has reached the DOM. In a Svelte
	 * component this is `tick`. It is the flush boundary that makes the handoff
	 * safe, so it must not be replaced with a microtask that resolves earlier.
	 */
	flush: () => Promise<void>;
}

/** The owner that means "image-capable editor mounted". */
function mountsEditor(owner: DiaryEditorOwner): boolean {
	return owner !== 'none';
}

export class DiaryEditorOwnership {
	private readonly applyOwner: (owner: DiaryEditorOwner) => void;
	private readonly flushDom: () => Promise<void>;

	private owner: DiaryEditorOwner = 'legacy';
	private tail: Promise<void> = Promise.resolve();

	constructor(options: DiaryEditorOwnershipOptions) {
		this.applyOwner = options.apply;
		this.flushDom = options.flush;
	}

	/** The owner currently applied. */
	get current(): DiaryEditorOwner {
		return this.owner;
	}

	/**
	 * Hand the slot to the event editor. Resolves once the event owner has been
	 * applied — that is, after the legacy editor has been torn down.
	 */
	enterEvent(): Promise<void> {
		return this.enqueue(() => this.transitionTo('event'));
	}

	/**
	 * Hand the slot back to the legacy diary editor. Resolves once the legacy
	 * owner has been applied — that is, after the event editor was torn down.
	 */
	exitEvent(): Promise<void> {
		return this.enqueue(() => this.transitionTo('legacy'));
	}

	private enqueue(step: () => Promise<void>): Promise<void> {
		// Serialise: a second handoff must not start before the first one has
		// passed its flush boundary. The tail never rejects, so one failed
		// handoff cannot wedge the queue or surface as an unhandled rejection.
		const run = this.tail.then(step).catch((error) => {
			// `flush` is Svelte's `tick`, which does not reject; if a caller ever
			// injects something that can, log it instead of losing it silently.
			console.error('DiaryEditorOwnership: handoff failed', error);
		});
		this.tail = run;
		return run;
	}

	private async transitionTo(target: DiaryEditorOwner): Promise<void> {
		if (this.owner === target) return;

		// Phase 1 — tear the outgoing editor down and let that land in the DOM.
		this.set('none');
		await this.flushDom();

		// Phase 2 — only now may the incoming editor mount.
		this.set(target);
	}

	private set(owner: DiaryEditorOwner): void {
		if (this.owner === owner) return;
		this.owner = owner;
		this.applyOwner(owner);
	}
}

/**
 * True when two owners could both hold an image-capable editor. Exported so the
 * component-level tests can assert the invariant directly.
 */
export function ownersOverlap(a: DiaryEditorOwner, b: DiaryEditorOwner): boolean {
	return mountsEditor(a) && mountsEditor(b) && a !== b;
}
