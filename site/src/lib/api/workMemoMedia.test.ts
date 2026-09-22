// @ts-nocheck
/**
 * Unit tests for the Work Memo Media association client core.
 *
 * These exercise the real request/response logic via an injected `fetch`, so no
 * server or bundler is required (`node --experimental-transform-types`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	attachWorkMemoMediaRequest,
	listWorkMemoMediaRequest,
	detachWorkMemoMediaRequest,
	normalizeWorkMemoMedia,
	normalizeWorkMemoMediaList
} from './workMemoMediaCore.ts';

class FakeApiError extends Error {
	status: number;
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

const apiError = (status, message) => new FakeApiError(status, message);

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

const ASSOCIATION = {
	id: 'assoc1',
	memo_id: 'memo1',
	media_id: 'm1',
	position: 0,
	created: '2026-01-01T00:00:00Z'
};

function attach(overrides = {}) {
	const { fetchFn, calls } = makeFetch(overrides.status ?? 201, overrides.body ?? ASSOCIATION);
	const promise = attachWorkMemoMediaRequest({
		fetchFn,
		apiError,
		token: overrides.token ?? 'test-token',
		memoId: overrides.memoId ?? 'memo1',
		mediaId: overrides.mediaId ?? 'm1'
	});
	return { promise, calls };
}

function list(overrides = {}) {
	const { fetchFn, calls } = makeFetch(
		overrides.status ?? 200,
		'body' in overrides ? overrides.body : { media: [ASSOCIATION] }
	);
	const promise = listWorkMemoMediaRequest({
		fetchFn,
		apiError,
		token: overrides.token ?? 'test-token',
		memoId: overrides.memoId ?? 'memo1'
	});
	return { promise, calls };
}

function detach(overrides = {}) {
	const { fetchFn, calls } = makeFetch(overrides.status ?? 200, overrides.body ?? { success: true });
	const promise = detachWorkMemoMediaRequest({
		fetchFn,
		apiError,
		token: overrides.token ?? 'test-token',
		memoId: overrides.memoId ?? 'memo1',
		associationId: overrides.associationId ?? 'assoc1'
	});
	return { promise, calls };
}

describe('attachWorkMemoMediaRequest', () => {
	it('POSTs media_id to the memo media endpoint and returns the association', async () => {
		const { promise, calls } = attach();
		const result = await promise;

		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, '/api/v1/work-memos/memo1/media');
		assert.equal(calls[0].init.method, 'POST');
		assert.deepEqual(JSON.parse(calls[0].init.body), { media_id: 'm1' });
		assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
		assert.equal(calls[0].init.headers['Content-Type'], 'application/json');

		assert.deepEqual(result, ASSOCIATION);
	});

	it('encodes the memo id in the request path', async () => {
		const { promise, calls } = attach({ memoId: 'a/b c' });
		await promise;
		assert.equal(calls[0].url, '/api/v1/work-memos/a%2Fb%20c/media');
	});

	it('surfaces 409 as an error with status 409 (already associated)', async () => {
		const { promise } = attach({ status: 409 });
		await assert.rejects(promise, (e) => e.status === 409);
	});

	it('surfaces 401, 404, 4xx and 5xx with their HTTP status', async () => {
		for (const status of [401, 404, 422, 500, 503]) {
			const { promise } = attach({ status });
			await assert.rejects(promise, (e) => e.status === status);
		}
	});

	it('propagates network failures instead of swallowing them', async () => {
		const boom = new Error('network down');
		const promise = attachWorkMemoMediaRequest({
			fetchFn: async () => {
				throw boom;
			},
			apiError,
			token: 't',
			memoId: 'memo1',
			mediaId: 'm1'
		});
		await assert.rejects(promise, (e) => e === boom);
	});
});

describe('listWorkMemoMediaRequest', () => {
	it('GETs the memo media endpoint and unwraps { media: [...] }', async () => {
		const { promise, calls } = list();
		const result = await promise;

		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, '/api/v1/work-memos/memo1/media');
		assert.equal(calls[0].init.method, 'GET');
		assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
		// A GET carries no body and no JSON content type.
		assert.equal(calls[0].init.body, undefined);
		assert.equal(calls[0].init.headers['Content-Type'], undefined);

		assert.deepEqual(result, [ASSOCIATION]);
	});

	it('encodes the memo id in the request path', async () => {
		const { promise, calls } = list({ memoId: 'a/b c' });
		await promise;
		assert.equal(calls[0].url, '/api/v1/work-memos/a%2Fb%20c/media');
	});

	it('returns an empty array for an empty or malformed payload', async () => {
		for (const body of [{ media: [] }, {}, { media: null }, { media: 'nope' }, null]) {
			const { promise } = list({ body });
			assert.deepEqual(await promise, []);
		}
	});

	it('drops rows that cannot take part in reconciliation', async () => {
		const { promise } = list({
			body: {
				media: [
					ASSOCIATION,
					{ id: '', media_id: 'm2' }, // no id -> cannot be detached
					{ id: 'assoc3', media_id: '' }, // no media_id -> cannot be matched
					null,
					'not-an-object',
					{ id: 'assoc4', media_id: 'm4', position: 'x' }
				]
			}
		});
		const result = await promise;
		assert.deepEqual(
			result.map((a) => a.id),
			['assoc1', 'assoc4']
		);
		assert.equal(result[1].position, 0);
	});

	it('surfaces 401, 404 and 500 with their HTTP status', async () => {
		for (const status of [401, 404, 500]) {
			const { promise } = list({ status });
			await assert.rejects(promise, (e) => e.status === status);
		}
	});

	it('propagates network failures instead of swallowing them', async () => {
		const boom = new Error('network down');
		const promise = listWorkMemoMediaRequest({
			fetchFn: async () => {
				throw boom;
			},
			apiError,
			token: 't',
			memoId: 'memo1'
		});
		await assert.rejects(promise, (e) => e === boom);
	});
});

describe('detachWorkMemoMediaRequest', () => {
	it('DELETEs the association path with auth and no body', async () => {
		const { promise, calls } = detach();
		await promise;

		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, '/api/v1/work-memos/memo1/media/assoc1');
		assert.equal(calls[0].init.method, 'DELETE');
		assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
		assert.equal(calls[0].init.body, undefined);
		assert.equal(calls[0].init.headers['Content-Type'], undefined);
	});

	it('URL-encodes the association id and the memo id', async () => {
		const { promise, calls } = detach({ memoId: 'a/b', associationId: 'i d/1' });
		await promise;
		assert.equal(calls[0].url, '/api/v1/work-memos/a%2Fb/media/i%20d%2F1');
	});

	it('resolves for a 200 { success: true } response', async () => {
		const { promise } = detach();
		assert.equal(await promise, undefined);
	});

	it('surfaces a 404 (association already gone) as status 404', async () => {
		const { promise } = detach({ status: 404 });
		await assert.rejects(promise, (e) => e.status === 404);
	});

	it('surfaces 401 and 500 with their HTTP status', async () => {
		for (const status of [401, 500]) {
			const { promise } = detach({ status });
			await assert.rejects(promise, (e) => e.status === status);
		}
	});

	it('propagates network failures instead of swallowing them', async () => {
		const boom = new Error('network down');
		const promise = detachWorkMemoMediaRequest({
			fetchFn: async () => {
				throw boom;
			},
			apiError,
			token: 't',
			memoId: 'memo1',
			associationId: 'assoc1'
		});
		await assert.rejects(promise, (e) => e === boom);
	});
});

describe('normalizeWorkMemoMedia', () => {
	it('keeps a well-formed payload intact', () => {
		assert.deepEqual(normalizeWorkMemoMedia(ASSOCIATION), ASSOCIATION);
	});

	it('tolerates missing or wrongly typed fields', () => {
		assert.deepEqual(normalizeWorkMemoMedia(null), {
			id: '',
			memo_id: '',
			media_id: '',
			position: 0,
			created: ''
		});
		assert.deepEqual(normalizeWorkMemoMedia({ position: '2' }), {
			id: '',
			memo_id: '',
			media_id: '',
			position: 0,
			created: ''
		});
	});
});

describe('normalizeWorkMemoMediaList', () => {
	it('keeps well-formed rows in order', () => {
		const second = { ...ASSOCIATION, id: 'assoc2', media_id: 'm2', position: 1 };
		assert.deepEqual(normalizeWorkMemoMediaList({ media: [ASSOCIATION, second] }), [
			ASSOCIATION,
			second
		]);
	});

	it('returns an empty array for non-list payloads', () => {
		assert.deepEqual(normalizeWorkMemoMediaList(undefined), []);
		assert.deepEqual(normalizeWorkMemoMediaList({ media: 'nope' }), []);
	});
});
