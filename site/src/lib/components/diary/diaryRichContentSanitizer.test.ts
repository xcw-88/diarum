// @ts-nocheck
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

import {
	DIARY_ALLOWED_ATTRIBUTES,
	DIARY_ALLOWED_TAGS,
	DIARY_FORBIDDEN_TAGS,
	DIARY_SANITIZER_CONFIG,
	configureDiaryPurifier,
	createDiaryPurifier,
	isAllowedDiaryClass,
	isAllowedDiaryStyle,
	isAllowedDiaryUri,
	sanitizeDiaryRichContent
} from './diaryRichContentSanitizer.ts';

/**
 * The sanitiser is exercised through the real DOMPurify against a real DOM
 * (jsdom), because the two holes it closes are DOMPurify *defaults*: `style` is
 * in `URI_SAFE_ATTRIBUTES` so its value is never URI-checked, and `img` is in
 * `DATA_URI_TAGS` so `data:` on `src` is re-allowed after the URI regexp fails.
 * Asserting those defaults directly is what makes the hook's necessity a fact
 * rather than a claim.
 *
 * jsdom is a devDependency and is built here only; nothing the bundle reaches
 * imports it.
 */

const domWindow = new JSDOM('<!doctype html><html><body></body></html>').window;

/** The sanitiser under test: the real policy, bound to a real DOM. */
const purifier = createDiaryPurifier(domWindow);
assert.ok(purifier, 'the jsdom-bound purifier must be supported');

const clean = (html) => purifier.sanitize(html, DIARY_SANITIZER_CONFIG);

/** The same config with no hook, to show what DOMPurify's defaults do alone. */
const bare = DOMPurify(domWindow);
const cleanWithDefaults = (html) => bare.sanitize(html, DIARY_SANITIZER_CONFIG);

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('sanitizeDiaryRichContent — execution surfaces are removed', () => {
	const dangerous = [
		['a script element', '<p>before</p><script>alert(1)</script>', ['<script', 'alert(1)']],
		[
			'an inline event handler on an image',
			'<img src="/a.png" onerror="alert(1)">',
			['onerror', 'alert(1)']
		],
		['a javascript: href', '<a href="javascript:alert(1)">x</a>', ['javascript', 'alert(1)']],
		['a vbscript: href', '<a href="vbscript:msgbox(1)">x</a>', ['vbscript', 'msgbox']],
		['an svg with an onload', '<svg onload="alert(1)"><circle /></svg>', ['svg', 'onload']],
		['an iframe', '<iframe src="https://evil.example"></iframe>', ['iframe']],
		['an object element', '<object data="/x.swf"></object>', ['object']],
		['an embed element', '<embed src="/x.swf">', ['<embed']],
		[
			'a data:text/html source',
			'<img src="data:text/html,<script>alert(1)</script>">',
			['<script', 'alert(1)']
		],
		[
			'a data:image/svg+xml source',
			'<img src="data:image/svg+xml,<svg onload=alert(1)/>">',
			['svg', 'onload']
		]
	];

	for (const [what, input, forbidden] of dangerous) {
		test(`drops ${what}`, () => {
			const output = clean(input);
			for (const needle of forbidden) {
				assert.equal(
					output.toLowerCase().includes(needle.toLowerCase()),
					false,
					`${what}: ${needle} survived in ${output}`
				);
			}
		});
	}

	test('drops every on* attribute, on every element', () => {
		const handlers = ['onclick', 'onerror', 'onload', 'onmouseover', 'onfocus', 'onanimationstart'];
		for (const handler of handlers) {
			const output = clean(`<p ${handler}="alert(1)">x</p>`);
			assert.equal(output.includes('alert'), false, handler);
			assert.equal(output.includes(handler), false, handler);
		}
	});

	test('drops the href entirely rather than leaving a dead scheme', () => {
		assert.equal(clean('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
	});

	test('drops an unauthorised style, and the value policy is what does it', () => {
		// `style` is in DOMPurify's URI_SAFE_ATTRIBUTES, so DOMPurify alone
		// keeps this verbatim — including the javascript: inside url().
		const payload = '<mark style="background-color:url(javascript:alert(1))">bad</mark>';

		assert.ok(
			cleanWithDefaults(payload).includes('javascript:'),
			'negative control: DOMPurify alone keeps the payload, so the hook is load-bearing'
		);

		const output = clean(payload);
		assert.equal(output.includes('javascript'), false, output);
		assert.equal(output.includes('style='), false, output);
		assert.equal(output, '<mark>bad</mark>');
	});

	test('drops a style on any element other than mark', () => {
		assert.equal(clean('<p style="color:red">styled</p>'), '<p>styled</p>');
	});

	test('data: URIs are tolerated only as base64 raster images', () => {
		assert.equal(isAllowedDiaryUri('src', 'data:image/png;base64,iVBORw0KGgo='), true);
		assert.equal(isAllowedDiaryUri('src', 'data:image/webp;base64,UklGRg=='), true);
		assert.equal(isAllowedDiaryUri('src', 'data:image/svg+xml,<svg/>'), false);
		assert.equal(isAllowedDiaryUri('src', 'data:text/html,<b>x</b>'), false);
		assert.equal(isAllowedDiaryUri('href', 'data:image/png;base64,iVBORw0KGgo='), false);
	});

	test('an obfuscated scheme is still caught', () => {
		assert.equal(isAllowedDiaryUri('href', 'JaVaScRiPt:alert(1)'), false);
		assert.equal(isAllowedDiaryUri('href', 'java\tscript:alert(1)'), false);
		assert.equal(isAllowedDiaryUri('href', ' javascript:alert(1)'), false);
		assert.equal(isAllowedDiaryUri('href', 'vbscript:msgbox(1)'), false);
	});

	test('a body that is nothing but a payload does not become a payload', () => {
		assert.equal(clean('<script>alert(1)</script>'), '');
		assert.equal(clean('<img src=x onerror=alert(1)>'), '<img src="x">');
	});
});

describe('sanitizeDiaryRichContent — legitimate TipTap output is preserved', () => {
	const preserved = [
		['a paragraph with marks', '<p>plain <strong>b</strong> <em>i</em> <u>u</u> <s>s</s></p>'],
		['a heading', '<h2>Title</h2>'],
		['a deep heading', '<h6>Deep</h6>'],
		['a bullet list', '<ul><li><p>one</p></li><li><p>two</p></li></ul>'],
		['an ordered list', '<ol start="3"><li><p>three</p></li></ol>'],
		['a blockquote', '<blockquote><p>quoted</p></blockquote>'],
		['a code block', '<pre><code class="language-js">const a = 1;</code></pre>'],
		['an inline code mark', '<p>use <code>npm run check</code></p>'],
		['a horizontal rule', '<hr>'],
		[
			'a highlight',
			'<mark data-color="#fbbf24" style="background-color: #fbbf24; color: inherit">hi</mark>'
		],
		[
			'a link',
			'<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">ok</a>'
		],
		[
			'an event image with its media id',
			'<img src="/api/v1/files/media/m1/photo.png" alt="photo" title="t" data-media-id="m1">'
		],
		[
			'a task list',
			'<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>todo</p></div></li></ul>'
		],
		[
			'a completed task item',
			'<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done</p></div></li></ul>'
		],
		['a line break', '<p>one<br>two</p>']
	];

	for (const [what, input] of preserved) {
		test(`keeps ${what} byte for byte`, () => {
			assert.equal(clean(input), input);
		});
	}

	test('the media id survives, because the whole association model reads it back', () => {
		const output = clean('<img src="/a.png" data-media-id="m1">');
		assert.match(output, /data-media-id="m1"/);
	});

	test('a whole realistic body round-trips unchanged', () => {
		const body =
			'<h1>Day</h1>' +
			'<p>Wrote <strong>notes</strong> and <em>thoughts</em>.</p>' +
			'<ul data-type="taskList">' +
			'<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>ship it</p></div></li>' +
			'</ul>' +
			'<img src="/api/v1/files/media/m9/a.png" alt="a" data-media-id="m9">' +
			'<blockquote><p>quote</p></blockquote>' +
			'<pre><code class="language-go">func main() {}</code></pre>';

		assert.equal(clean(body), body);
	});

	test('a relative media URL is not mistaken for a scheme', () => {
		assert.equal(isAllowedDiaryUri('src', '/api/v1/files/media/m1/a.png'), true);
		assert.equal(isAllowedDiaryUri('href', '#anchor'), true);
		assert.equal(isAllowedDiaryUri('href', 'mailto:a@b.example'), true);
	});
});

describe('the policy tables describe what the hook enforces', () => {
	test('no allowed tag is also forbidden', () => {
		for (const tag of DIARY_ALLOWED_TAGS) {
			assert.equal(DIARY_FORBIDDEN_TAGS.includes(tag), false, tag);
		}
	});

	test('the executable elements are all explicitly forbidden', () => {
		for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math']) {
			assert.ok(DIARY_FORBIDDEN_TAGS.includes(tag), tag);
		}
	});

	test('style is only reachable on mark', () => {
		assert.equal(isAllowedDiaryStyle('mark', 'background-color: #fff; color: inherit'), true);
		assert.equal(isAllowedDiaryStyle('p', 'background-color: #fff'), false);
		assert.equal(isAllowedDiaryStyle('img', 'background-color: #fff'), false);
		assert.equal(isAllowedDiaryStyle('mark', 'background-image: url(https://e/x.png)'), false);
		assert.equal(isAllowedDiaryStyle('mark', 'width: expression(alert(1))'), false);
		assert.equal(isAllowedDiaryStyle('mark', ''), false);
	});

	test('the class rule keeps language-* but nothing exotic', () => {
		assert.equal(isAllowedDiaryClass('language-js'), true);
		assert.equal(isAllowedDiaryClass('hljs-keyword'), true);
		assert.equal(isAllowedDiaryClass(''), false);
		assert.equal(isAllowedDiaryClass('a"onmouseover="alert(1)'), false);
	});

	test('every attribute the editor emits is in the table', () => {
		for (const attribute of ['data-media-id', 'data-type', 'data-checked', 'data-color']) {
			assert.ok(DIARY_ALLOWED_ATTRIBUTES.includes(attribute), attribute);
		}
	});
});

describe('sanitizeDiaryRichContent — module behaviour', () => {
	test('configuring the same purifier twice does not double-hook it', () => {
		const once = createDiaryPurifier(domWindow);
		assert.ok(once);

		assert.equal(configureDiaryPurifier(once), once);
		assert.equal(configureDiaryPurifier(once), once);
		assert.equal(once.sanitize('<p style="color:red">x</p>', DIARY_SANITIZER_CONFIG), '<p>x</p>');
	});

	test('empty input stays empty', () => {
		assert.equal(clean(''), '');
	});

	test('fails closed when DOMPurify has no DOM, instead of passing the body through', () => {
		// Node has no `document`, so the module-level binding cannot produce a
		// usable purifier: DOMPurify hands back a bare factory whose `sanitize`
		// is not even defined. Rendering nothing is the only fail-closed answer —
		// "show the body untouched" would be exactly the hole this closes.
		assert.equal(createDiaryPurifier(), null, 'the no-DOM binding produces nothing usable');
		assert.equal(sanitizeDiaryRichContent('<p>anything</p>'), '');
	});
});

describe('read-boundary wiring', () => {
	const component = read('./DiaryRichContent.svelte');

	test('the component sanitises before {@html} rather than after', () => {
		assert.match(
			component,
			/import\s*\{\s*sanitizeDiaryRichContent\s*\}\s*from\s*'\.\/diaryRichContentSanitizer'/
		);
		assert.match(component, /const safeHtml = \$derived\(sanitizeDiaryRichContent\(html\)\)/);
		// The comments above mention `{@html}`, so anchor on the rendered line.
		assert.match(
			component,
			/\{#if html\}\s*<div class="tiptap-editor-content">\{@html safeHtml\}<\/div>/
		);
		assert.equal(
			component.includes('{@html html}'),
			false,
			'the raw stored body must never be executed'
		);
	});

	test('the stored body is never written back', () => {
		// Purely subtractive: no fetch, no store, no assignment to the body.
		for (const forbidden of ['fetch(', '$lib/api', 'setContent', 'content =']) {
			assert.equal(component.includes(forbidden), false, forbidden);
		}
	});
});
