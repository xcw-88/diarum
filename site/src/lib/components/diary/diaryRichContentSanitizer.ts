/**
 * Read-boundary sanitizer for stored rich content (Controller Review Fix 2A).
 *
 * A Work Memo body is persisted as whatever HTML string the client sent, and
 * `DiaryRichContent.svelte` executes it with `{@html}`. "TipTap produced it" is
 * a client-side assumption, not a trust boundary: `POST /work-memos` accepts
 * any string. This module is the one place that turns the stored string into
 * something safe to execute.
 *
 * Design rules
 * ------------
 * 1. **Purely subtractive.** It removes elements and attributes; it never adds,
 *    rewrites or reorders anything. Whatever survives is a byte-for-byte part of
 *    the input, so a sanitized body can never say something the stored body did
 *    not.
 * 2. **The stored body is never touched.** No write-back, no re-storage, no
 *    migration. Sanitization happens once, at the `{@html}` boundary.
 * 3. **Fail closed.** DOMPurify returns its input unchanged when it could not
 *    bind to a DOM (`isSupported === false`). That is the exact hole this module
 *    exists to close, so the unsupported case yields an empty string instead.
 * 4. **Allowlist, never a denylist.** Tags, attributes and URI schemes are all
 *    enumerated from what this app's own editor can emit — see the comments on
 *    each table below.
 * 5. **Two independent layers.** DOMPurify's own `ALLOWED_TAGS`/`ALLOWED_ATTR`
 *    filtering plus its URI regexp, and then a `uponSanitizeAttribute` hook that
 *    re-checks every value with the same policy. The hook is not decorative:
 *    `style` is in DOMPurify's `URI_SAFE_ATTRIBUTES` (so its value is never
 *    URI-checked) and `img` is in `DATA_URI_TAGS` (so `data:` on `src` is
 *    re-allowed after the regexp fails). Both are proven by the tests.
 *
 * Zero local runtime imports on purpose: the project's only frontend test
 * mechanism is `node --experimental-transform-types --test`, and Node's ESM
 * resolver does not guess an extension for a TypeScript specifier. `dompurify`
 * is a bare specifier and resolves normally, so this file is directly loadable
 * by a `node:test` file.
 */

import DOMPurify from 'dompurify';
import type {
	Config,
	DOMPurify as Purifier,
	UponSanitizeAttributeHookEvent,
	WindowLike
} from 'dompurify';

/**
 * Every element this app's editor can actually serialize.
 *
 * Sources: `@tiptap/starter-kit` (paragraph, heading h1-h6, bold, italic,
 * strike, code, bullet/ordered list + item, blockquote, horizontal rule, hard
 * break), `extension-underline`, `extension-highlight` (`mark`),
 * `extension-link` (`a`), `extension-code-block-lowlight` (`pre` + `code`),
 * `extension-task-list` / `extension-task-item` (`ul`/`li`/`label`/`span`/
 * `div`/`input`) and this repo's `ImageNodeView` (`img`).
 *
 * `div` is not decoration: TipTap's task item renders `li > label + div`.
 */
export const DIARY_ALLOWED_TAGS: readonly string[] = [
	'p',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'br',
	'hr',
	'strong',
	'em',
	'u',
	's',
	'ul',
	'ol',
	'li',
	'blockquote',
	'pre',
	'code',
	'mark',
	'a',
	'img',
	'label',
	'span',
	'div',
	'input'
];

/**
 * Every attribute those elements can carry.
 *
 * - `href`/`target`/`rel` — `@tiptap/extension-link` (`target` defaults to
 *   `_blank`, `rel` to `noopener noreferrer nofollow`).
 * - `src`/`alt`/`title`/`data-media-id`/`data-uploading`/`data-placeholder-id`
 *   — this repo's `ImageNodeView.addAttributes()`.
 * - `data-type`/`data-checked` — `extension-task-list` / `extension-task-item`.
 * - `data-color` — `extension-highlight` with `multicolor: true`.
 * - `style` — only `extension-highlight` emits it, and only on `mark`; the hook
 *   below rejects it everywhere else and validates its declarations.
 * - `class` — `extension-code-block` emits `language-*` on `code`.
 * - `start`/`type` — `extension-ordered-list`; `type` is also the checkbox on a
 *   task item's `input`.
 * - `checked`/`disabled` — the task item checkbox.
 *
 * `data-uploading` / `data-placeholder-id` are inert, and the save guard
 * (`shouldPersistContent`) refuses to persist a body that still carries them —
 * they are listed for fidelity, not because a placeholder can reach here.
 */
export const DIARY_ALLOWED_ATTRIBUTES: readonly string[] = [
	'href',
	'target',
	'rel',
	'class',
	'src',
	'alt',
	'title',
	'start',
	'type',
	'checked',
	'disabled',
	'style',
	'data-media-id',
	'data-uploading',
	'data-placeholder-id',
	'data-type',
	'data-checked',
	'data-color'
];

/**
 * URI schemes a stored body may use, mirroring the editor's own link policy.
 *
 * `@tiptap/extension-link` validates against `['http','https','ftp','ftps',
 * 'mailto','tel','callto','sms','cid','xmpp']`, so that is exactly the set a
 * legitimate body can contain. Everything else — `javascript:`, `vbscript:`,
 * `data:` (outside the raster images below), `blob:` — is dropped.
 */
export const DIARY_ALLOWED_PROTOCOLS: readonly string[] = [
	'http',
	'https',
	'ftp',
	'ftps',
	'mailto',
	'tel',
	'callto',
	'sms',
	'cid',
	'xmpp'
];

/**
 * The only `data:` payloads that survive: base64 raster images.
 *
 * `image/svg+xml` is excluded on purpose — SVG is an execution surface
 * (`<svg onload>`), and nothing in this app persists a `data:` URI at all
 * (uploads produce real URLs), so this is a tolerance, not a requirement.
 */
export const DIARY_SAFE_RASTER_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i;

/** `rel` tokens this app can emit or that are meaningfully inert. */
export const DIARY_ALLOWED_REL_TOKENS: readonly string[] = [
	'noopener',
	'noreferrer',
	'nofollow',
	'tag'
];

/**
 * Layers with DOMPurify's default rather than trusting it: DOMPurify's own
 * fallback for `data:` on `DATA_URI_TAGS` tags (`img` among them) would accept
 * `data:text/html,...`, so this regexp accepts the safe raster payloads itself
 * and lets the hook reject everything else.
 */
export const DIARY_ALLOWED_URI =
	/^(?:(?:https?|ftps?|mailto|tel|callto|sms|cid|xmpp):|data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/** Elements that must never survive, whatever else is configured. */
export const DIARY_FORBIDDEN_TAGS: readonly string[] = [
	'script',
	'style',
	'iframe',
	'frame',
	'frameset',
	'object',
	'embed',
	'applet',
	'svg',
	'math',
	'template',
	'base',
	'link',
	'meta',
	'noscript',
	'form'
];

/**
 * The DOMPurify configuration. `USE_PROFILES` is deliberately absent: a profile
 * would overwrite `ALLOWED_TAGS` with a much larger built-in list.
 */
export const DIARY_SANITIZER_CONFIG: Config = {
	ALLOWED_TAGS: [...DIARY_ALLOWED_TAGS],
	ALLOWED_ATTR: [...DIARY_ALLOWED_ATTRIBUTES],
	FORBID_TAGS: [...DIARY_FORBIDDEN_TAGS],
	// Inert only when named explicitly, which the table above does.
	ALLOW_DATA_ATTR: false,
	ALLOW_ARIA_ATTR: false,
	ALLOW_UNKNOWN_PROTOCOLS: false,
	ALLOWED_URI_REGEXP: DIARY_ALLOWED_URI,
	// `<script>`/`<style>`/`<svg>` sit in DOMPurify's FORBID_CONTENTS, so their
	// bodies go with them; keeping this explicit documents that we rely on it.
	KEEP_CONTENT: true,
	RETURN_DOM: false,
	RETURN_DOM_FRAGMENT: false
};

/** A CSS colour literal, the only kind of value a `mark` declaration may carry. */
const COLOR_LITERAL =
	'#[0-9a-fA-F]{3,8}|rgba?\\(\\s*[0-9.,%\\s]+\\)|hsla?\\(\\s*[0-9.,%\\s]+\\)|[a-zA-Z]{3,20}';

/** One `background-color` / `color` declaration with a literal value. */
const MARK_STYLE_DECLARATION = new RegExp(
	`^(?:background-color|color)\\s*:\\s*(?:${COLOR_LITERAL})$`,
	'i'
);

/** A URI scheme, as it appears before the colon. */
const URI_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** Whitespace and control characters a browser would ignore inside a scheme. */
const IGNORABLE_IN_URI = /[\u0000-\u0020\u00a0\u2028\u2029]/g;

/** Class tokens this app can emit (`language-js`, `hljs-keyword`, `taskList`). */
const CLASS_VALUE = /^[A-Za-z0-9_\-\s]+$/;

/** The `type` values `@tiptap/extension-ordered-list` can carry. */
const ORDERED_LIST_TYPE = /^[1aAiI]$/;

/** A `start` attribute value. */
const ORDERED_LIST_START = /^\d{1,9}$/;

/**
 * Whether a URI-valued attribute may keep `value`.
 *
 * @param attributeName the attribute the URI came from; `data:` raster images
 *                      are only tolerated on `src`.
 */
export function isAllowedDiaryUri(attributeName: string, value: string): boolean {
	// `extension-link` writes `href=""` when it refuses a URI. Keeping that is
	// what makes the anchor non-navigable, so it must not be treated as invalid.
	if (value === '') return true;

	const compact = value.replace(IGNORABLE_IN_URI, '');

	if (/^data:/i.test(compact)) {
		return attributeName === 'src' && DIARY_SAFE_RASTER_DATA_URI.test(compact);
	}

	const scheme = URI_SCHEME.exec(compact);
	// No scheme at all: a relative path, an anchor or a protocol-relative URL.
	// None of those can introduce script, so they pass.
	if (!scheme) return true;

	return DIARY_ALLOWED_PROTOCOLS.includes(scheme[1].toLowerCase());
}

/**
 * Whether a `style` attribute may survive.
 *
 * Only `mark` ever carries one, and only `extension-highlight` writes it, in the
 * shape `background-color: <colour>; color: inherit`. Anything else — including
 * `url(...)`, `expression(...)` and any unknown property — is dropped, which is
 * what closes the "unauthorised style" execution surface.
 */
export function isAllowedDiaryStyle(tagName: string, value: string): boolean {
	if (tagName.toLowerCase() !== 'mark') return false;

	const declarations = value
		.split(';')
		.map((declaration) => declaration.trim())
		.filter((declaration) => declaration.length > 0);

	if (declarations.length === 0) return false;
	return declarations.every((declaration) => MARK_STYLE_DECLARATION.test(declaration));
}

/** Whether a `class` value is a plain list of class tokens. */
export function isAllowedDiaryClass(value: string): boolean {
	return value.trim().length > 0 && CLASS_VALUE.test(value);
}

/** Whether a `rel` value is a subset of the known-safe tokens. */
export function isAllowedDiaryRel(value: string): boolean {
	const tokens = value
		.split(/\s+/)
		.filter((token) => token.length > 0)
		.map((token) => token.toLowerCase());

	if (tokens.length === 0) return false;
	return tokens.every((token) => DIARY_ALLOWED_REL_TOKENS.includes(token));
}

/**
 * The single value policy, applied by the hook to every surviving attribute.
 *
 * Name-level filtering already happened in `ALLOWED_ATTR`; this decides whether
 * a *value* is acceptable, which is where DOMPurify's defaults are weakest.
 */
export function isAllowedDiaryAttribute(
	tagName: string,
	attributeName: string,
	value: string
): boolean {
	switch (attributeName) {
		case 'href':
		case 'src':
			return isAllowedDiaryUri(attributeName, value);
		case 'style':
			return isAllowedDiaryStyle(tagName, value);
		case 'class':
			return isAllowedDiaryClass(value);
		case 'rel':
			return isAllowedDiaryRel(value);
		// `extension-link` only ever writes `_blank`; any other target would be
		// a way to steer the reader somewhere the stored body did not intend.
		case 'target':
			return value === '_blank';
		case 'start':
			return ORDERED_LIST_START.test(value);
		case 'type':
			if (tagName.toLowerCase() === 'input') return value === 'checkbox';
			return tagName.toLowerCase() === 'ol' && ORDERED_LIST_TYPE.test(value);
		default:
			return true;
	}
}

/** Purifiers already carrying the hook, so a shared instance is not double-hooked. */
const configuredPurifiers = new WeakSet<object>();

/**
 * Attach the value policy to a DOMPurify instance and return it.
 *
 * Idempotent: the module-level instance and a test instance are different
 * objects, and each is configured exactly once.
 */
export function configureDiaryPurifier(purifier: Purifier): Purifier {
	if (configuredPurifiers.has(purifier)) return purifier;
	configuredPurifiers.add(purifier);

	purifier.addHook(
		'uponSanitizeAttribute',
		(node: Element, data: UponSanitizeAttributeHookEvent) => {
			const tagName = node && typeof node.tagName === 'string' ? node.tagName : '';
			if (!isAllowedDiaryAttribute(tagName, data.attrName, data.attrValue)) {
				data.keepAttr = false;
			}
		}
	);

	return purifier;
}

/**
 * Bind DOMPurify to a DOM and give it the value policy, or return null when
 * there is no DOM to bind to.
 *
 * The default export is both a factory and an instance: DOMPurify builds it as
 * `root => createDOMPurify(root)` and, when it cannot see a `document` at import
 * time, hands back exactly that bare factory — `isSupported === false` and no
 * `sanitize` at all. So a supported purifier is the only usable outcome, and
 * `null` is the honest answer for everything else. Tests pass a jsdom window.
 */
export function createDiaryPurifier(root?: WindowLike): Purifier | null {
	const purifier = root ? DOMPurify(root) : DOMPurify;
	if (!purifier.isSupported) return null;
	return configureDiaryPurifier(purifier);
}

/** The module-level purifier, resolved at most once, and only on success. */
let cachedPurifier: Purifier | null = null;

function resolveDiaryPurifier(): Purifier | null {
	if (cachedPurifier) return cachedPurifier;
	cachedPurifier = createDiaryPurifier();
	return cachedPurifier;
}

/**
 * Make a stored body safe to hand to `{@html}`.
 *
 * Returns `''` when DOMPurify has no DOM to work with. It cannot sanitise there
 * — calling `sanitize` would throw — and "show the body untouched instead" is a
 * silent fail-open, so refusing to render is the only honest answer.
 */
export function sanitizeDiaryRichContent(html: string): string {
	if (typeof html !== 'string' || html === '') return '';

	const purifier = resolveDiaryPurifier();
	if (!purifier) return '';

	return purifier.sanitize(html, DIARY_SANITIZER_CONFIG);
}

export default sanitizeDiaryRichContent;
