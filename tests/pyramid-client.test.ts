// Unit tests for PyramidClient's If-Match / ETag read-first flow
// (src/client/pyramid-client.ts, DOC-CONCURRENCY) — pure, NO real network. We
// mock undici's `request` so each call records its method/path/headers and
// returns a scripted status/body/ETag. We assert:
//   - updateTask GETs first to capture the ETag, then PATCHes with `If-Match`;
//   - on a 409 `conflict` it refetches the ETag and retries the mutation ONCE,
//     then succeeds (a genuine concurrent edit);
//   - a persistent 409 surfaces a typed `conflict` after the single retry;
//   - deleteTask follows the same read-first precondition flow;
//   - listTasks uses the real query param names (owner_id, not assignee_id).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock undici BEFORE importing the client so the client binds the mock.
const undiciRequest = vi.fn();
vi.mock('undici', () => ({ request: (...args: unknown[]) => undiciRequest(...args) }));

import { PyramidClient } from '../src/client/pyramid-client.js';
import { McpError } from '../src/errors.js';
import type { PyramidConfig } from '../src/types.js';

const CONFIG: PyramidConfig = {
	apiKey: 'pyk_test',
	baseUrl: 'https://pyramid.example.io',
	allowDestructive: true,
};

/** A captured call to the mocked undici request. */
interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

/** Build an undici-shaped response: status + JSON body + optional ETag header. */
function res(opts: { status: number; body?: unknown; etag?: string }) {
	return {
		statusCode: opts.status,
		headers: opts.etag ? { etag: opts.etag } : {},
		body: { text: async () => (opts.body === undefined ? '' : JSON.stringify(opts.body)) },
	};
}

/** Capture every undici call (url/method/headers/body) for assertions. */
function captureCalls(): Call[] {
	const calls: Call[] = [];
	undiciRequest.mockImplementation(
		(url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
			calls.push({ url, method: init.method, headers: init.headers, body: init.body });
			// The per-test script replaces this implementation; this base just records.
			return res({ status: 200, body: {} });
		}
	);
	return calls;
}

beforeEach(() => {
	undiciRequest.mockReset();
});
afterEach(() => {
	vi.clearAllMocks();
});

describe('PyramidClient — updateTask If-Match read-first flow', () => {
	it('GETs to capture the ETag, then PATCHes with If-Match set to it', async () => {
		const calls: Call[] = [];
		undiciRequest.mockImplementation(
			(url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
				calls.push({ url, method: init.method, headers: init.headers, body: init.body });
				if (init.method === 'GET') {
					return res({ status: 200, body: { id: 't1', updated_at: 'X' }, etag: '"etag-1"' });
				}
				// PATCH succeeds.
				return res({ status: 200, body: { id: 't1', title: 'New' } });
			}
		);

		const client = new PyramidClient(CONFIG);
		const out = await client.updateTask('t1', { title: 'New' });

		expect(out).toMatchObject({ id: 't1', title: 'New' });
		// first a GET, then a PATCH (read-first).
		expect(calls[0]!.method).toBe('GET');
		expect(calls[0]!.url).toContain('/v1/tasks/t1');
		expect(calls[1]!.method).toBe('PATCH');
		// the captured ETag rode along as If-Match.
		expect(calls[1]!.headers['if-match']).toBe('"etag-1"');
	});

	it('falls back to the body updated_at when no ETag header is present', async () => {
		const calls: Call[] = [];
		undiciRequest.mockImplementation(
			(url: string, init: { method: string; headers: Record<string, string> }) => {
				calls.push({ url, method: init.method, headers: init.headers });
				if (init.method === 'GET') {
					return res({ status: 200, body: { id: 't1', updated_at: '2026-06-16T00:00:00.123Z' } });
				}
				return res({ status: 200, body: { id: 't1' } });
			}
		);

		const client = new PyramidClient(CONFIG);
		await client.updateTask('t1', { title: 'New' });

		expect(calls[1]!.headers['if-match']).toBe('2026-06-16T00:00:00.123Z');
	});

	it('on a 409 conflict refetches the ETag and retries the PATCH exactly ONCE, then succeeds', async () => {
		const calls: Call[] = [];
		let patchCount = 0;
		undiciRequest.mockImplementation(
			(url: string, init: { method: string; headers: Record<string, string> }) => {
				calls.push({ url, method: init.method, headers: init.headers });
				if (init.method === 'GET') {
					// Each GET returns a fresh ETag.
					return res({
						status: 200,
						body: { id: 't1' },
						etag: patchCount === 0 ? '"etag-1"' : '"etag-2"',
					});
				}
				patchCount += 1;
				if (patchCount === 1)
					return res({ status: 409, body: { error: { code: 'conflict', message: 'stale' } } });
				return res({ status: 200, body: { id: 't1', title: 'New' } });
			}
		);

		const client = new PyramidClient(CONFIG);
		const out = await client.updateTask('t1', { title: 'New' });

		expect(out).toMatchObject({ id: 't1', title: 'New' });
		// GET, PATCH(409), GET(refetch), PATCH(ok) — exactly two PATCH attempts.
		const methods = calls.map((c) => c.method);
		expect(methods).toEqual(['GET', 'PATCH', 'GET', 'PATCH']);
		// the retry used the FRESH etag from the refetch.
		expect(calls[3]!.headers['if-match']).toBe('"etag-2"');
	});

	it('surfaces a typed conflict when the 409 persists after the single retry', async () => {
		undiciRequest.mockImplementation((_url: string, init: { method: string }) => {
			if (init.method === 'GET') return res({ status: 200, body: { id: 't1' }, etag: '"e"' });
			return res({ status: 409, body: { error: { code: 'conflict', message: 'still stale' } } });
		});

		const client = new PyramidClient(CONFIG);
		const err = await client
			.updateTask('t1', { title: 'New' })
			.then(() => undefined)
			.catch((e) => e as McpError);

		expect(err).toBeInstanceOf(McpError);
		expect((err as McpError).code).toBe('conflict');
		// GET, PATCH(409), GET, PATCH(409) — retried exactly once before surfacing.
		expect(undiciRequest).toHaveBeenCalledTimes(4);
	});
});

describe('PyramidClient — deleteTask read-first precondition', () => {
	it('GETs the ETag then DELETEs with If-Match and hard=true', async () => {
		const calls: Call[] = [];
		undiciRequest.mockImplementation(
			(url: string, init: { method: string; headers: Record<string, string> }) => {
				calls.push({ url, method: init.method, headers: init.headers });
				if (init.method === 'GET') return res({ status: 200, body: { id: 't1' }, etag: '"e1"' });
				return res({ status: 204 });
			}
		);

		const client = new PyramidClient(CONFIG);
		await client.deleteTask('t1', true);

		expect(calls[0]!.method).toBe('GET');
		expect(calls[1]!.method).toBe('DELETE');
		expect(calls[1]!.headers['if-match']).toBe('"e1"');
		expect(calls[1]!.url).toContain('hard=true');
	});
});

describe('PyramidClient — listTasks query params (real names)', () => {
	it('sends owner_id (not assignee_id) and the real filter set', async () => {
		const calls: Call[] = captureCalls();
		undiciRequest.mockImplementation((url: string, init: { method: string }) => {
			calls.push({ url, method: init.method, headers: {} });
			return res({ status: 200, body: { data: [], cursor: null } });
		});

		const client = new PyramidClient(CONFIG);
		await client.listTasks('p1', {
			owner_id: 'u1',
			status: 'st1',
			label_id: 'lb1',
			q: 'x',
			limit: 10,
		});

		const last = calls[calls.length - 1]!;
		expect(last.url).toContain('owner_id=u1');
		expect(last.url).toContain('status=st1');
		expect(last.url).toContain('label_id=lb1');
		expect(last.url).not.toContain('assignee_id');
	});

	it('listArchived hits the separate /tasks/archived route', async () => {
		const calls: Call[] = [];
		undiciRequest.mockImplementation((url: string, init: { method: string }) => {
			calls.push({ url, method: init.method, headers: {} });
			return res({ status: 200, body: { data: [], cursor: null } });
		});

		const client = new PyramidClient(CONFIG);
		await client.listArchived('p1', { limit: 5 });

		expect(calls[0]!.url).toContain('/v1/projects/p1/tasks/archived');
	});
});

describe('PyramidClient — the flat-ownership contract (no stage-responsibilities)', () => {
	it('has no setStageResponsibilities method — the route was removed server-side', () => {
		const client = new PyramidClient(CONFIG) as unknown as Record<string, unknown>;
		expect(client.setStageResponsibilities).toBeUndefined();
	});

	it('listMyTasks never sends ?role= (the server accepts and ignores it)', async () => {
		const calls: Call[] = [];
		undiciRequest.mockImplementation((url: string, init: { method: string }) => {
			calls.push({ url, method: init.method, headers: {} });
			return res({ status: 200, body: { data: [], cursor: null } });
		});

		const client = new PyramidClient(CONFIG);
		await client.listMyTasks({ limit: 5 });

		expect(calls[0]!.url).toContain('/v1/me/tasks');
		expect(calls[0]!.url).toContain('limit=5');
		expect(calls[0]!.url).not.toContain('role=');
	});

	it('getTaskTimeline hits /tasks/{id}/timeline with limit/cursor/event_type', async () => {
		const calls: Call[] = [];
		undiciRequest.mockImplementation((url: string, init: { method: string }) => {
			calls.push({ url, method: init.method, headers: {} });
			return res({ status: 200, body: { data: [{ id: 'ev' }], cursor: 'c2' } });
		});

		const client = new PyramidClient(CONFIG);
		const page = await client.getTaskTimeline('t1', {
			limit: 200,
			cursor: 'c1',
			event_type: 'owner_changed',
		});

		expect(calls[0]!.method).toBe('GET');
		expect(calls[0]!.url).toContain('/v1/tasks/t1/timeline');
		expect(calls[0]!.url).toContain('limit=200');
		expect(calls[0]!.url).toContain('cursor=c1');
		expect(calls[0]!.url).toContain('event_type=owner_changed');
		// the raw envelope is normalized, never reshaped.
		expect(page).toEqual({ data: [{ id: 'ev' }], cursor: 'c2' });
	});
});
