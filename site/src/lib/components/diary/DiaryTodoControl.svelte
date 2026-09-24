<script lang="ts">
	import { t } from '$lib/i18n';
	import {
		diaryTodoActionLabelKey,
		diaryTodoBadgeKey,
		getDiaryTodoViewModel,
		type DiaryTodoAction
	} from './diaryTodoStatus';

	/**
	 * The one Todo control, shared by the read-only Event card in
	 * `DiaryEvents.svelte` and the inline `DiaryEventEditor.svelte`.
	 *
	 * It is deliberately presentational: it renders the view model produced by
	 * `diaryTodoStatus`, emits the *semantic* action the user chose, and owns no
	 * write path. That is what keeps the transition rules in exactly one place —
	 * the parent decides how to persist, this component decides nothing.
	 *
	 * Mobile contract (§8), all of it load-bearing:
	 *  - the check control is a `<button role="checkbox">`, **not** a native
	 *    input: its whole visual state is derived from the model, so a refused
	 *    toggle cannot leave a natively-flipped box on screen;
	 *  - every target is at least 44x44 CSS px (`h-11 w-11` / `min-h-11`);
	 *  - nothing is hover-only, nothing needs a right click, and the state is
	 *    never conveyed by colour alone (a check glyph plus a text label);
	 *  - the row is `flex-wrap` with `min-w-0` children, so a long Event body
	 *    never produces a horizontal scrollbar and the control stays reachable
	 *    with the virtual keyboard open.
	 */
	interface Props {
		/** The Event's stored status. Untrusted: normalized on the way in. */
		status: unknown;
		/** A todo write is in flight: the controls are disabled. */
		busy?: boolean;
		/** Text of the last failure, or null. */
		error?: string | null;
		/** The action the user asked for. The parent persists it. */
		onAction: (action: DiaryTodoAction) => void;
	}

	let { status, busy = false, error = null, onAction }: Props = $props();

	const model = $derived(getDiaryTodoViewModel(status));
	const badgeKey = $derived(diaryTodoBadgeKey(model.status));
	const toggleLabel = $derived(
		$t(diaryTodoActionLabelKey(model.toggleAction ?? 'complete'))
	);
</script>

<div
	class="diary-todo-control flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
	role="group"
	aria-label={$t('diaryEvents.todoGroupLabel')}
>
	{#if model.isTodo}
		<button
			type="button"
			role="checkbox"
			aria-checked={model.checked}
			aria-label={toggleLabel}
			title={toggleLabel}
			disabled={busy}
			class="diary-todo-toggle inline-flex min-h-11 min-w-11 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
			onclick={() => onAction(model.toggleAction ?? 'complete')}
		>
			<span
				class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border {model.checked
					? 'border-emerald-500 bg-emerald-500 text-white dark:border-emerald-400 dark:bg-emerald-400 dark:text-emerald-950'
					: 'border-border bg-background'}"
				aria-hidden="true"
			>
				{#if model.checked}
					<svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M4.5 10.5l3.5 3.5 7.5-8" />
					</svg>
				{/if}
			</span>
			{#if badgeKey}
				<span
					class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium {model.checked
						? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
						: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'}"
				>
					{$t(badgeKey)}
				</span>
			{/if}
		</button>

		{#if model.canClear}
			<button
				type="button"
				aria-label={$t('diaryEvents.todoCancel')}
				title={$t('diaryEvents.todoCancel')}
				disabled={busy}
				class="diary-todo-clear inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
				onclick={() => onAction('clear')}
			>
				{$t('diaryEvents.todoCancel')}
			</button>
		{/if}
	{:else}
		<button
			type="button"
			aria-label={$t('diaryEvents.todoSetPending')}
			title={$t('diaryEvents.todoSetPending')}
			disabled={busy}
			class="diary-todo-set inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
			onclick={() => onAction('set-pending')}
		>
			<svg class="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
			</svg>
			<span>{$t('diaryEvents.todoSetPending')}</span>
		</button>
	{/if}

	{#if busy}
		<span class="diary-todo-busy text-xs text-muted-foreground" role="status">
			{$t('diaryEvents.todoUpdating')}
		</span>
	{/if}

	{#if error}
		<span
			class="diary-todo-error min-w-0 break-words text-xs text-destructive"
			role="alert"
		>
			{error}
		</span>
	{/if}
</div>
