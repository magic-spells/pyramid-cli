// McpError shape + the HTTP-envelope -> code mapping (DOC-ERROR-MODEL, DATATYPE-MCP-ERROR).
//
// Every failure surfaced to a caller is an McpError. `code` is the contract;
// callers ACT ON THE CODE and never parse `message`. The Pyramid API returns
// the canonical envelope `{ "error": { code, message, details } }` on non-2xx.

import type { McpErrorCode } from './types.js';

export class McpError extends Error {
	readonly code: McpErrorCode;
	readonly hint?: string;
	readonly candidates?: string[];

	constructor(
		code: McpErrorCode,
		message: string,
		opts?: { hint?: string; candidates?: string[] }
	) {
		super(message);
		this.name = 'McpError';
		this.code = code;
		if (opts?.hint !== undefined) this.hint = opts.hint;
		if (opts?.candidates !== undefined) this.candidates = opts.candidates;
		// Restore prototype chain for instanceof across transpilation targets.
		Object.setPrototypeOf(this, McpError.prototype);
	}

	/** Plain serializable shape — what goes into MCP tool result text + CLI --json. */
	toJSON(): { code: McpErrorCode; message: string; hint?: string; candidates?: string[] } {
		const out: { code: McpErrorCode; message: string; hint?: string; candidates?: string[] } = {
			code: this.code,
			message: this.message,
		};
		if (this.hint !== undefined) out.hint = this.hint;
		if (this.candidates !== undefined) out.candidates = this.candidates;
		return out;
	}
}

/** True when `e` is an McpError (instanceof, tolerant of realm differences). */
export function isMcpError(e: unknown): e is McpError {
	return e instanceof McpError;
}

/**
 * Render an McpError as an MCP tool result (DOC-ERROR-MODEL). The error's
 * serializable `{ code, message, hint?, candidates? }` shape is JSON-encoded into
 * a single text block with `isError: true`. Surfaces NEVER throw to the MCP
 * transport — they return this instead so the model sees a typed, parseable error.
 */
export function toToolError(e: McpError): {
	content: { type: 'text'; text: string }[];
	isError: true;
} {
	return {
		content: [{ type: 'text', text: JSON.stringify(e.toJSON()) }],
		isError: true,
	};
}

const REGENERATE_KEY_HINT = 'Regenerate your key in Pyramid → Settings → API Keys.';

// ============ HTTP-envelope -> McpError ============

/** The Pyramid error envelope: `{ "error": { code, message, details } }`. */
interface PyramidEnvelope {
	error?: { code?: string; message?: string; details?: unknown };
}

/**
 * Defensively read `{ error: { code, message, details } }` out of a parsed body.
 * `field` is lifted out of `details` because it is the one detail the backend
 * promises on a validation failure (`{"field":"owner_id"}`) and the one a caller
 * cannot recover any other way: a PATCH carrying both owner_id and reporter_id
 * gets one "user is not a member of this project" message for either half.
 */
function readEnvelope(body: unknown): { code?: string; message?: string; field?: string } {
	if (body && typeof body === 'object' && 'error' in body) {
		const err = (body as PyramidEnvelope).error;
		if (err && typeof err === 'object') {
			const details = err.details;
			const rawField =
				details && typeof details === 'object'
					? (details as Record<string, unknown>).field
					: undefined;
			return {
				code: typeof err.code === 'string' ? err.code : undefined,
				message: typeof err.message === 'string' ? err.message : undefined,
				field: typeof rawField === 'string' && rawField.length > 0 ? rawField : undefined,
			};
		}
	}
	return {};
}

/**
 * Best-effort 404 disambiguation from the server `error.code` / message. The
 * envelope codes (`project_not_found`, `task_not_found`, …) are preferred; we
 * fall back to a substring sniff, then to `unknown` when nothing is conclusive.
 */
function notFoundCode(env: { code?: string; message?: string }): McpErrorCode {
	const hay = `${env.code ?? ''} ${env.message ?? ''}`.toLowerCase();
	if (hay.includes('project')) return 'project_not_found';
	if (hay.includes('task')) return 'task_not_found';
	if (hay.includes('status')) return 'status_not_found';
	if (hay.includes('stage')) return 'stage_not_found';
	if (hay.includes('label')) return 'label_not_found';
	if (hay.includes('user')) return 'user_not_found';
	if (hay.includes('field')) return 'field_not_found';
	return 'unknown';
}

/**
 * Map a non-2xx HTTP status + parsed envelope body to an McpError, per the
 * DOC-ERROR-MODEL table:
 *   401 -> auth_invalid (regenerate-key hint; "expired" sniff -> auth_expired)
 *   403 -> permission_denied
 *   404 -> project/task/...  (best-effort) else unknown
 *   400|422 -> validation_failed
 *   429 -> rate_limited
 *   5xx / anything else -> unknown
 */
export function mapHttpError(status: number, body: unknown): McpError {
	const env = readEnvelope(body);
	const message = env.message ?? `Pyramid request failed (HTTP ${status}).`;

	if (status === 401) {
		const expired =
			(env.code ?? '').toLowerCase().includes('expired') ||
			(env.message ?? '').toLowerCase().includes('expired');
		return new McpError(expired ? 'auth_expired' : 'auth_invalid', message, {
			hint: REGENERATE_KEY_HINT,
		});
	}

	if (status === 403) {
		return new McpError('permission_denied', message);
	}

	if (status === 404) {
		return new McpError(notFoundCode(env), message);
	}

	if (status === 400 || status === 422) {
		// `details.field` names WHICH member the server rejected (e.g. owner_id when
		// the named owner is not a project member) — surface it or the caller cannot
		// tell which half of a two-field write failed.
		return env.field === undefined
			? new McpError('validation_failed', message)
			: new McpError('validation_failed', message, {
					hint: `The server rejected the \`${env.field}\` field.`,
				});
	}

	if (status === 409) {
		// pyramid-server returns 409 `conflict` for both slug/prefix collisions and a
		// missing/stale If-Match precondition (DOC-CONCURRENCY). The read-first retry in
		// the client handles the racy case; a surfaced conflict means reread + retry.
		return new McpError('conflict', message, {
			hint: 'The resource changed since you last read it — reread it and try again.',
		});
	}

	if (status === 429) {
		// The backend has no rate limiting today; kept defensively for proxies/CDNs.
		return new McpError('rate_limited', message, { hint: 'Slow down and retry.' });
	}

	// 5xx and any other non-2xx fall through to unknown.
	return new McpError('unknown', message);
}

/**
 * Coerce any thrown value into an McpError. McpErrors pass through unchanged;
 * undici/network failures (and any other non-HTTP throw) become `network`,
 * with a final `unknown` fallback for the truly opaque.
 */
export function toMcpError(e: unknown): McpError {
	if (e instanceof McpError) return e;

	if (e instanceof Error) {
		if (isNetworkError(e)) {
			return new McpError('network', e.message, {
				hint: 'Check PYRAMID_BASE_URL and your network connection.',
			});
		}
		return new McpError('unknown', e.message);
	}

	return new McpError('unknown', typeof e === 'string' ? e : 'Unknown error.');
}

/** Heuristic: does this Error look like an undici/Node network failure? */
function isNetworkError(e: Error): boolean {
	const code = (e as NodeJS.ErrnoException).code ?? '';
	const name = e.name ?? '';
	const msg = e.message ?? '';
	if (
		code === 'ECONNREFUSED' ||
		code === 'ENOTFOUND' ||
		code === 'ECONNRESET' ||
		code === 'ETIMEDOUT' ||
		code === 'EAI_AGAIN' ||
		code === 'UND_ERR_CONNECT_TIMEOUT' ||
		code === 'UND_ERR_SOCKET' ||
		code === 'UND_ERR_HEADERS_TIMEOUT'
	) {
		return true;
	}
	if (name === 'AbortError' || name === 'TimeoutError') return true;
	// undici surfaces low-level failures as a generic TypeError: "fetch failed".
	return /fetch failed|network|socket|connect/i.test(msg);
}
