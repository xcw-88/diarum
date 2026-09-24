/**
 * Cross-surface coordination for one Event's todo state (Task 2, Controller
 * Review Fix 2 / P1-2).
 *
 * Two surfaces can write the same Event's status:
 *
 *   - the read-only card, through the status-only endpoint (no live body);
 *   - the inline editor, through the shared editing session.
 *
 * The card is the one that can be *in flight while the user does something else
 * with the same Event*, so this module owns exactly three things:
 *
 *   1. {@link DiaryTodoPendingMutations} — the per-Event registry of card
 *      mutations that have not settled, kept as an **awaitable handle** rather
 *      than a boolean, so "is this Event busy?" and "tell me when this Event has
 *      settled" are the same fact and cannot drift apart;
 *   2. {@link DiaryTodoAcceptedStatuses} — the statuses this page has already
 *      had accepted, each with the revision it was accepted at, so a list
 *      response that was already on the wire when a status was accepted cannot
 *      put the old status back;
 *   3. {@link enterEventWhenTodoSettled} — the entry gate: an Event may only be
 *      opened once the card mutation for *that* Event has settled, and it must
 *      then be read **fresh** from the page's model rather than from the object
 *      captured at click time.
 *
 * Why the gate exists
 * -------------------
 * The editor seeds its session from the status it is handed. If the user taps
 * "set as todo" on a card and immediately opens that same Event, the editor can
 * mount while `normal -> pending` is still on the wire: it takes `normal`, and
 * its first autosave then PUTs the whole snapshot — body plus the OLD status —
 * writing `normal` back over the `pending` the user had already been shown. Both
 * writes are individually valid; only their interleaving is wrong, and no
 * disabled button fixes it, because keyboard and programmatic entry bypass the
 * button. The gate therefore sits in the entry path itself.
 *
 * Two properties the fix deliberately keeps:
 *
 *   - **only the same Event waits.** Settling is per id, so opening Event B is
 *     never delayed by a mutation in flight for Event A;
 *   - **the card's write path is unchanged.** This delays the editor; it does
 *     not move a card's status write onto the save machine, and it does not add
 *     a second writer for a status. The two persistence paths keep their
 *     existing jobs.
 *
 * What the re-read promises, exactly. It hands over the list's *current* entry —
 * the very object the card renders — so the editor and the card cannot disagree
 * about what is stored. It is deliberately not given the object the click
 * carried: `enterEventWhenTodoSettled` takes the id and nothing else, so no
 * caller can seed an editor from a memo it captured.
 *
 * Why an accepted status needs a revision (Controller Review Fix 3)
 * -----------------------------------------------------------------
 * A gate on the *entry* path cannot close a race that happens in the *list*: a
 * `GET` issued before a status was accepted observes the old status, and when it
 * returns it replaces the whole day — including the row the card write had just
 * moved, and including the row a subsequent re-read then hands to the editor.
 * Re-reading later does not help, because by then the model itself is wrong
 * again.
 *
 * Both orderings are possible, so both halves exist:
 *
 *   - **write accepted, then a stale response applies.** The acceptance must be
 *     remembered, and a response that *started* before it must not be allowed to
 *     overwrite it — that is the revision comparison in
 *     {@link DiaryTodoAcceptedStatuses.reconcileLoadedMemos};
 *   - **a stale response applies, then the write is accepted.** Nothing needs
 *     remembering: the acceptance simply has to land on the row that is in the
 *     list *now*, which is
 *     {@link DiaryTodoAcceptedStatuses.applyStatusToRows}.
 *
 * What the revision comparison deliberately does **not** do is make the overlay
 * permanent. A response that started *after* the acceptance is a newer
 * observation and keeps the server's answer, so a status changed on another
 * device still reaches this page. The overlay is a guard against a stale read,
 * not a local truth that outlives its evidence.
 *
 * Zero runtime imports (Node's ESM resolver does not guess an extension for a
 * TypeScript specifier, so anything a test imports must not import a local
 * module at runtime). The tests drive it with real promises and the real
 * `DiaryEditorOwnership`.
 */

import type { DiaryTodoStatus } from './diaryTodoStatus';

/**
 * The card mutations that have not settled yet, keyed by Event id.
 *
 * Holds the promise itself, not a flag, because the entry gate has to *wait* for
 * it — and whatever it settles to, the failure must never leak into a waiter: a
 * failed mutation leaves the model on its previous status, which is exactly what
 * the editor should then be seeded from.
 */
export class DiaryTodoPendingMutations {
	private readonly inFlight = new Map<string, Promise<unknown>>();
	private readonly listeners = new Set<() => void>();

	/** The ids with a mutation in flight, in the order they were tracked. */
	get pendingIds(): string[] {
		return [...this.inFlight.keys()];
	}

	/** Whether a mutation for `id` is in flight. Authoritative for the guard. */
	isPending(id: string): boolean {
		return this.inFlight.has(id);
	}

	/**
	 * Register the mutation in flight for `id` and return it, so the caller can
	 * await the same promise the registry holds.
	 *
	 * A later `track` for the same id replaces the handle — but the older
	 * mutation's cleanup must not remove the newer one, which is why removal is
	 * conditional on still being the tracked promise. Callers do not rely on
	 * this: each surface single-flights its own writes.
	 */
	track(id: string, mutation: Promise<unknown>): Promise<unknown> {
		this.inFlight.set(id, mutation);
		this.notify();

		const done = () => {
			if (this.inFlight.get(id) !== mutation) return;
			this.inFlight.delete(id);
			this.notify();
		};
		// Both branches, so a rejected mutation is handled here as well and can
		// never surface as an unhandled rejection.
		void mutation.then(done, done);

		return mutation;
	}

	/**
	 * Wait for the mutation in flight for `id` to settle, whatever the outcome.
	 * Resolves immediately when there is none, and never rejects: the caller
	 * re-reads the status from the model instead of being handed an error it can
	 * already see rendered on the card.
	 */
	async settle(id: string): Promise<void> {
		const mutation = this.inFlight.get(id);
		if (!mutation) return;
		try {
			await mutation;
		} catch {
			// The model keeps its previous status on failure, which is the truth
			// the editor must be seeded from.
		}
	}

	/**
	 * Notified whenever the pending set changes. Returns the unsubscribe, so a
	 * component can keep a render mirror without becoming a second source of
	 * truth for "is this Event busy?".
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

/** One accepted status, and the revision at which it was accepted. */
export interface DiaryAcceptedStatusRecord {
	/** Strictly increasing: every acceptance takes the next revision. */
	revision: number;
	status: DiaryTodoStatus;
}

/**
 * The statuses this page has already had accepted, and when.
 *
 * A list response carries the whole day, so it can *replace a row* — including
 * one a card write has just moved. The revision is what separates a response
 * that predates an acceptance from one that does not: the page reads
 * {@link getAcceptedRevision} immediately **before** it issues a request, and a
 * record whose revision is greater than that value was accepted while the
 * request was in flight, so the response cannot have observed it. Whatever it
 * says about that Event is older than what this page already knows, and is
 * corrected on the way in.
 *
 * Records are never removed. A response can stay in flight arbitrarily long, and
 * forgetting an acceptance would silently reopen the race it exists to close;
 * the cost is one small object per Event whose status changed in this session.
 *
 * Nothing here writes to the network: the card still uses the status-only
 * endpoint and the editor still uses its own session. This is bookkeeping over
 * the model the page renders, not a second persistence path.
 */
export class DiaryTodoAcceptedStatuses {
	private revision = 0;
	private readonly accepted = new Map<string, DiaryAcceptedStatusRecord>();

	/** The most recent acceptance's revision; 0 before the first one. */
	getAcceptedRevision(): number {
		return this.revision;
	}

	/**
	 * Record that the backend accepted `status` for `id`, and return the
	 * revision — strictly greater than every revision handed out before it.
	 */
	recordAcceptedStatus(id: string, status: DiaryTodoStatus): number {
		const revision = this.revision + 1;
		this.revision = revision;
		this.accepted.set(id, { revision, status });
		return revision;
	}

	/**
	 * Move the row for `id` in `rows` to `status`, if `rows` has one. Returns
	 * whether a row was patched.
	 *
	 * This is the "a stale response applied first, the write was accepted
	 * afterwards" half. The object a click carried is not necessarily the object
	 * the page renders any more — a response in between replaces the list — so
	 * an accepted status belongs to the row **currently in the list**, found by
	 * id. A row that is no longer listed is not resurrected here; the record
	 * above still protects it if a stale response brings it back.
	 */
	applyStatusToRows<TRow extends { id: string; status: DiaryTodoStatus }>(
		rows: readonly TRow[],
		id: string,
		status: DiaryTodoStatus
	): boolean {
		const row = rows.find((candidate) => candidate.id === id);
		if (!row) return false;
		row.status = status;
		return true;
	}

	/**
	 * Correct a list response that may predate the statuses this page accepted.
	 *
	 * `loadStartedAtRevision` is what {@link getAcceptedRevision} returned
	 * **before the request went out**:
	 *
	 *   - a record newer than it was accepted while the request was in flight,
	 *     so the response's answer for that Event is stale and is replaced by
	 *     the accepted status;
	 *   - a record that is not newer was already accepted before the request
	 *     started, so the response is a genuinely newer observation of the
	 *     server and is left exactly as it came back — including a status
	 *     changed on another device.
	 *
	 * Rows are patched in place (they were just parsed from a response and are
	 * owned by the caller) and the same array is returned, so the call site can
	 * assign it directly.
	 */
	reconcileLoadedMemos<TRow extends { id: string; status: DiaryTodoStatus }>(
		loadedMemos: TRow[],
		loadStartedAtRevision: number
	): TRow[] {
		for (const memo of loadedMemos) {
			const record = this.accepted.get(memo.id);
			if (!record) continue;
			if (record.revision <= loadStartedAtRevision) continue;
			memo.status = record.status;
		}
		return loadedMemos;
	}
}

/**
 * The three steps the entry gate needs, injected so this module stays free of
 * Svelte, `$app/*` and `$lib`.
 */
export interface DiaryEventEntry<TMemo> {
	/** Await the card mutation in flight for `id`; resolves at once if none. */
	settleTodo: (id: string) => Promise<void>;
	/**
	 * The freshest model for `id`, read from the page's list at settle time —
	 * never the object captured when the click happened, which may have been
	 * replaced by a reload in the meantime.
	 */
	readMemo: (id: string) => TMemo | null;
	/** Open the editor for that freshly read model. */
	enter: (memo: TMemo) => Promise<void>;
}

/** Whether the Event was opened, or was no longer listed when the gate opened. */
export type DiaryEventEntryOutcome = 'entered' | 'missing';

/**
 * Open an Event once its own todo mutation — if any — has settled.
 *
 * The order is the contract:
 *
 *   1. settle the mutation for THIS Event only. Per id, so another Event's
 *      in-flight write cannot delay this one;
 *   2. re-read the model. A write that landed is now visible in it; a write that
 *      failed left the previous status in place. Either way the status the
 *      editor is seeded from is the status the card is showing — which is the
 *      whole point, because the two can no longer disagree;
 *   3. only then request the editor.
 *
 * The parameter is an **id**, never a memo: there is no captured object a caller
 * could seed an editor from, and re-reading is what puts the entry on the list's
 * current entry.
 *
 * `enter`'s rejection (a handoff the outgoing editor refused) is propagated
 * unchanged: it is the caller's existing error path, not this gate's business.
 */
export async function enterEventWhenTodoSettled<TMemo>(
	id: string,
	entry: DiaryEventEntry<TMemo>
): Promise<DiaryEventEntryOutcome> {
	await entry.settleTodo(id);

	const memo = entry.readMemo(id);
	if (memo === null) return 'missing';

	await entry.enter(memo);
	return 'entered';
}
