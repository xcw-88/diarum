// @ts-nocheck
/**
 * Unit tests for the status-only Work Memo update core.
 *
 * The point of these is §13 F of the Task 2 spec: a Todo toggle must send
 * `status` and nothing else, so it can never re-submit a stale body. The
 * strongest form of that assertion is on the *wire*, so the request is driven
 * through an injected `fetch` rather than asserted against source text.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildWorkMemoStatusBody,
	buildWorkMemoUpdateBody,
	isWorkMemoStatusValue,
	updateWorkMemoStatusRequest,
	workMemoResourcePath
} from './workMemoStatusCore.ts';

const STATUSES = ['normal', 'pending', 'completed'];

class FakeApiError extends Error {
	status;
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

const apiError = (response) => new FakeApiError(response.status, `HTTP ${response.status}`);

function makeFetch(status, body = {}) {
	const calls = [];
	const fetchFn = async (url, init) => {
		calls.push({ url, init });
		return {
			status,
			ok: status >= 200 && status < 300,
			json: async () => body
		};
	};
	return { fetchFn, calls };
}

function request(overrides = {}) {
	const { fetchFn, calls } = makeFetch(
		overrides.httpStatus ?? 200,
		'body' in overrides ? overrides.body : { id: 'm1', status: overrides.newStatus ?? 'pending' }
	);
	const promise = updateWorkMemoStatusRequest({
		fetchFn,
		apiError,
		token: overrides.token ?? 'test-token',
		id: overrides.id ?? 'm1',
		status: overrides.newStatus ?? 'pending',
		signal: overrides.signal
	});
	return { promise, calls };
}

describe('buildWorkMemoStatusBody — the stale-payload guard', () => {
	it('carries status as the ONLY key, for every status', () => {
		for (const status of STATUSES) {
			const body = buildWorkMemoStatusBody(status);
			assert.deepEqual(Object.keys(body), ['status'], `${status} must not add a key`);
			assert.deepEqual(body, { status });
		}
	});

	it('serialises to a body no other column can be read out of', () => {
		for (const status of STATUSES) {
			const json = JSON.stringify(buildWorkMemoStatusBody(status));
			assert.equal(json, `{"status":"${status}"}`);
			for (const forbidden of [
				'content',
				'date',
				'position',
				'tags',
				'is_pinned',
				'created',
				'updated',
				'search_text'
			]) {
				assert.ok(
					!json.includes(forbidden),
					`a status-only body must not mention ${forbidden}`
				);
			}
		}
	});
});

describe('buildWorkMemoUpdateBody — partial update semantics', () => {
	it('sends only the keys the caller actually provided', () => {
		assert.deepEqual(buildWorkMemoUpdateBody({}), {});
		assert.deepEqual(Object.keys(buildWorkMemoUpdateBody({ status: 'pending' })), ['status']);
		assert.deepEqual(Object.keys(buildWorkMemoUpdateBody({ content: '<p>x</p>' })), ['content']);
		assert.deepEqual(
			Object.keys(buildWorkMemoUpdateBody({ content: '<p>x</p>', status: 'completed' })),
			['content', 'status']
		);
	});

	it('treats an explicit false pin as a value, not an omission', () => {
		assert.deepEqual(buildWorkMemoUpdateBody({ is_pinned: false }), { is_pinned: false });
	});

	it('agrees with the status-only builder, so there is one body shape', () => {
		for (const status of STATUSES) {
			assert.deepEqual(
				buildWorkMemoUpdateBody({ status }),
				buildWorkMemoStatusBody(status)
			);
		}
	});

	it('is idempotent', () => {
		const draft = { content: '<p>x</p>', status: 'pending' };
		const once = buildWorkMemoUpdateBody(draft);
		assert.deepEqual(buildWorkMemoUpdateBody(once), once);
	});
});

describe('isWorkMemoStatusValue', () => {
	it('accepts the three persisted statuses', () => {
		for (const status of STATUSES) assert.equal(isWorkMemoStatusValue(status), true);
	});

	it('rejects anything else, including lookalikes', () => {
		for (const value of [
			'',
			'Normal',
			'pending ',
			'done',
			null,
			undefined,
			0,
			{},
			['pending']
		]) {
			assert.equal(isWorkMemoStatusValue(value), false, `${JSON.stringify(value)} is not a status`);
		}
	});
});

describe('workMemoResourcePath', () => {
	it('targets the existing endpoint and encodes the id', () => {
		assert.equal(workMemoResourcePath('m1'), '/api/v1/work-memos/m1');
		assert.equal(workMemoResourcePath('a/b c'), '/api/v1/work-memos/a%2Fb%20c');
	});
});

describe('updateWorkMemoStatusRequest — the wire', () => {
	it('issues one PUT whose body has exactly one key', async () => {
		const { promise, calls } = request({ newStatus: 'pending' });
		await promise;

		assert.equal(calls.length, 1, 'no retry, no second request');
		const [call] = calls;
		assert.equal(call.url, '/api/v1/work-memos/m1');
		assert.equal(call.init.method, 'PUT');
		assert.equal(call.init.headers.Authorization, 'Bearer test-token');
		assert.equal(call.init.headers['Content-Type'], 'application/json');

		const body = JSON.parse(call.init.body);
		assert.deepEqual(Object.keys(body), ['status']);
		assert.equal(body.status, 'pending');
	});

	it('resolves with the raw updated payload for the binding to normalize', async () => {
		const payload = { id: 'm1', status: 'completed', content: '<p>server value</p>' };
		const { promise } = request({ newStatus: 'completed', body: payload });
		assert.deepEqual(await promise, payload);
	});

	it('forwards the abort signal so a caller can cancel', async () => {
		const controller = new AbortController();
		const { promise, calls } = request({ signal: controller.signal });
		await promise;
		assert.equal(calls[0].init.signal, controller.signal);
	});

	it('routes every non-2xx through the injected error, with the response', async () => {
		for (const httpStatus of [400, 401, 404, 500]) {
			const { promise, calls } = request({ httpStatus });
			await assert.rejects(promise, (error) => {
				assert.ok(error instanceof FakeApiError);
				assert.equal(error.status, httpStatus);
				return true;
			});
			assert.equal(calls.length, 1);
		}
	});

	it('does not swallow a transport failure, and does not retry it', async () => {
		let calls = 0;
		const fetchFn = async () => {
			calls += 1;
			throw new TypeError('Failed to fetch');
		};
		await assert.rejects(
			updateWorkMemoStatusRequest({
				fetchFn,
				apiError,
				token: 't',
				id: 'm1',
				status: 'pending'
			}),
			(error) => error instanceof TypeError
		);
		assert.equal(calls, 1, 'an offline toggle fails once and says so');
	});
});
