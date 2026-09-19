// Unit tests for mapHttpError / toMcpError (src/errors.ts) — pure, no network.
//
// The contract: callers ACT ON THE CODE, never parse the message. mapHttpError
// turns an HTTP status + the canonical envelope `{ error: { code, message } }`
// into an McpError with the right code per the DOC-ERROR-MODEL table:
//   401 -> auth_invalid  (auth_expired when the envelope sniffs "expired")
//   403 -> permission_denied
//   404 -> best-effort project/task/... else unknown
//   400|422 -> validation_failed
//   429 -> rate_limited
//   5xx / anything else -> unknown
// toMcpError coerces arbitrary throws: McpError passes through; undici/network
// failures become `network`; everything else `unknown`.

import { describe, it, expect } from 'vitest';
import { McpError, mapHttpError, toMcpError, isMcpError, toToolError } from '../src/errors.js';

/** Build the canonical Pyramid error envelope. */
function envelope(code: string, message = 'boom'): unknown {
	return { error: { code, message } };
}

describe('mapHttpError — status -> code', () => {
	it('maps 401 to auth_invalid with a regenerate-key hint', () => {
		const err = mapHttpError(401, envelope('unauthorized'));
		expect(err).toBeInstanceOf(McpError);
		expect(err.code).toBe('auth_invalid');
		expect(err.hint).toMatch(/API Keys/i);
	});

	it('maps 401 to auth_expired when the envelope mentions "expired"', () => {
		const err = mapHttpError(401, envelope('token_expired', 'your token has expired'));
		expect(err.code).toBe('auth_expired');
	});

	it('maps 403 to permission_denied', () => {
		const err = mapHttpError(403, envelope('forbidden'));
		expect(err.code).toBe('permission_denied');
	});

	it('maps 404 with a project envelope to project_not_found', () => {
		const err = mapHttpError(404, envelope('project_not_found', 'no such project'));
		expect(err.code).toBe('project_not_found');
	});

	it('maps 404 with a task envelope to task_not_found', () => {
		const err = mapHttpError(404, envelope('task_not_found', 'no such task'));
		expect(err.code).toBe('task_not_found');
	});

	it('maps 404 envelopes to the matching *_not_found code (status/stage/label/user/field)', () => {
		// Best-effort 404 disambiguation from the envelope code/message substring.
		expect(mapHttpError(404, envelope('status_not_found')).code).toBe('status_not_found');
		expect(mapHttpError(404, envelope('stage_not_found')).code).toBe('stage_not_found');
		expect(mapHttpError(404, envelope('label_not_found')).code).toBe('label_not_found');
		expect(mapHttpError(404, envelope('user_not_found')).code).toBe('user_not_found');
		expect(mapHttpError(404, envelope('field_not_found')).code).toBe('field_not_found');
	});

	it('disambiguates a 404 from the envelope MESSAGE when the code is opaque', () => {
		const err = mapHttpError(404, envelope('not_found', 'that project is gone'));
		expect(err.code).toBe('project_not_found');
	});

	it('maps an unrecognizable 404 to unknown', () => {
		const err = mapHttpError(404, envelope('mystery', 'gone'));
		expect(err.code).toBe('unknown');
	});

	it('maps 400 to validation_failed', () => {
		const err = mapHttpError(400, envelope('bad_request'));
		expect(err.code).toBe('validation_failed');
	});

	it('maps 422 to validation_failed', () => {
		const err = mapHttpError(422, envelope('unprocessable'));
		expect(err.code).toBe('validation_failed');
		expect(err.hint).toBeUndefined();
	});

	// A PATCH can carry both owner_id and reporter_id, and a non-member in either
	// half yields the SAME message — only details.field says which one.
	it('names details.field in the hint on a 422 (non-member owner/reporter)', () => {
		const err = mapHttpError(422, {
			error: {
				code: 'validation_failed',
				message: 'user is not a member of this project',
				details: { field: 'owner_id', user_id: 'u-stranger' },
			},
		});
		expect(err.code).toBe('validation_failed');
		expect(err.hint).toContain('owner_id');
	});

	it('ignores a details blob with no usable field', () => {
		const err = mapHttpError(422, {
			error: { code: 'validation_failed', message: 'boom', details: { field: 42 } },
		});
		expect(err.hint).toBeUndefined();
	});

	it('maps 429 to rate_limited', () => {
		const err = mapHttpError(429, envelope('rate_limited'));
		expect(err.code).toBe('rate_limited');
	});

	it('maps 500 to unknown', () => {
		const err = mapHttpError(500, envelope('internal'));
		expect(err.code).toBe('unknown');
	});

	it('maps an unlisted status (e.g. 418) to unknown', () => {
		const err = mapHttpError(418, envelope('teapot'));
		expect(err.code).toBe('unknown');
	});

	it('prefers the envelope message when present', () => {
		const err = mapHttpError(403, envelope('forbidden', 'you cannot do that'));
		expect(err.message).toBe('you cannot do that');
	});

	it('falls back to a generic message when the body has no envelope', () => {
		const err = mapHttpError(500, { something: 'else' });
		expect(err.code).toBe('unknown');
		expect(err.message).toMatch(/500/);
	});

	it('tolerates a non-object body (null / string)', () => {
		expect(mapHttpError(500, null).code).toBe('unknown');
		expect(mapHttpError(401, 'not json').code).toBe('auth_invalid');
	});
});

describe('toMcpError — coerce arbitrary throws', () => {
	it('passes an McpError through unchanged', () => {
		const original = new McpError('rate_limited', 'slow down', { hint: 'wait' });
		expect(toMcpError(original)).toBe(original);
	});

	it('classifies an ECONNREFUSED error as network', () => {
		const e = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
		const err = toMcpError(e);
		expect(err.code).toBe('network');
		// Network failures carry an actionable base-URL/connection hint.
		expect(err.hint).toMatch(/PYRAMID_BASE_URL/);
	});

	it('classifies every transport-level errno (DNS / reset / timeout / undici) as network', () => {
		for (const code of [
			'ENOTFOUND',
			'ECONNRESET',
			'ETIMEDOUT',
			'EAI_AGAIN',
			'UND_ERR_CONNECT_TIMEOUT',
			'UND_ERR_SOCKET',
			'UND_ERR_HEADERS_TIMEOUT',
		]) {
			const e = Object.assign(new Error(`transport failure: ${code}`), { code });
			expect(toMcpError(e).code).toBe('network');
		}
	});

	it('classifies abort/timeout errors (by name) as network', () => {
		const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
		const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
		expect(toMcpError(abort).code).toBe('network');
		expect(toMcpError(timeout).code).toBe('network');
	});

	it('classifies a generic undici "fetch failed" as network', () => {
		const err = toMcpError(new TypeError('fetch failed'));
		expect(err.code).toBe('network');
	});

	it('classifies an arbitrary Error as unknown', () => {
		const err = toMcpError(new Error('something odd'));
		expect(err.code).toBe('unknown');
		expect(err.message).toBe('something odd');
	});

	it('coerces a thrown string to unknown', () => {
		const err = toMcpError('plain string failure');
		expect(err.code).toBe('unknown');
		expect(err.message).toBe('plain string failure');
	});
});

describe('McpError — shape', () => {
	it('is an instanceof Error and McpError, carries code/hint/candidates', () => {
		const err = new McpError('ambiguous_project_name', 'pick one', {
			hint: 'be specific',
			candidates: ['alpha', 'beta'],
		});
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(McpError);
		expect(err.code).toBe('ambiguous_project_name');
		expect(err.hint).toBe('be specific');
		expect(err.candidates).toEqual(['alpha', 'beta']);
	});

	it('sets name to "McpError" and exposes the message via Error', () => {
		const err = new McpError('validation_failed', 'bad input');
		expect(err.name).toBe('McpError');
		expect(err.message).toBe('bad input');
	});

	it('toJSON() emits { code, message } and omits absent hint/candidates', () => {
		const json = new McpError('validation_failed', 'bad input').toJSON();
		expect(json).toEqual({ code: 'validation_failed', message: 'bad input' });
		expect('hint' in json).toBe(false);
		expect('candidates' in json).toBe(false);
	});

	it('toJSON() includes hint/candidates when present', () => {
		const json = new McpError('ambiguous_user_name', 'pick one', {
			hint: 'narrow it',
			candidates: ['ann', 'andy'],
		}).toJSON();
		expect(json).toEqual({
			code: 'ambiguous_user_name',
			message: 'pick one',
			hint: 'narrow it',
			candidates: ['ann', 'andy'],
		});
	});
});

describe('isMcpError — discriminator', () => {
	it('is true for an McpError', () => {
		expect(isMcpError(new McpError('unknown', 'x'))).toBe(true);
	});

	it('is false for a plain Error and non-error values', () => {
		expect(isMcpError(new Error('plain'))).toBe(false);
		expect(isMcpError('string')).toBe(false);
		expect(isMcpError(null)).toBe(false);
		expect(isMcpError({ code: 'unknown', message: 'lookalike' })).toBe(false);
	});
});

describe('toToolError — MCP tool-result envelope', () => {
	it('wraps the serialized error in a single text block with isError:true', () => {
		const err = new McpError('rate_limited', 'slow down', { hint: 'wait' });
		const result = toToolError(err);
		expect(result.isError).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe('text');
		// The text payload must be the parseable JSON of the error's toJSON() shape.
		expect(JSON.parse(result.content[0]!.text)).toEqual({
			code: 'rate_limited',
			message: 'slow down',
			hint: 'wait',
		});
	});
});
