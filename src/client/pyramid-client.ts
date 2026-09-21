// PyramidClient — thin undici wrapper over the Pyramid HTTP API (FILE-PYRAMID-CLIENT, EXTERNAL-PYRAMID-API).
//
// Responsibilities, and ONLY these:
//   - bearer auth (`Authorization: Bearer <apiKey>`) + JSON content negotiation;
//   - one shared `request<T>()` that maps non-2xx -> McpError via mapHttpError and
//     undici/transport throws -> McpError('network', ...) via toMcpError;
//   - the Phase-1 read-only methods that return RAW server JSON. The hydration /
//     name-resolution layers live elsewhere — this class never reshapes rows.
//
// The API key is attached as a header only; it is NEVER logged or placed in a URL.
//
// Ground truth, confirmed against the `pyramid` repo's server/ (Go handlers + models):
//   - All routes are mounted under `/v1` (internal/router/router.go: r.Route("/v1", ...)).
//   - GET /v1/me            -> a raw User object (model.User from handlers/user.go GetMe):
//                              { id, account_user_id, email, email_verified,
//                                display_name, first_name, last_name, avatar_url,
//                                timezone, locale, ... }. NO embedded workspace,
//                              NO project list — assembling WhoAmI is the op layer's job.
//   - GET /v1/workspaces    -> { "data": Workspace[] }  (no cursor) (handlers/workspace.go).
//   - GET /v1/projects      -> { "data": Project[], "cursor": string|null }
//                              (handlers/project.go list). Raw projects carry
//                              `task_prefix`, `archived_at`, etc.
//   - GET /v1/projects/{id}/workflow -> a workflow object (handlers/project.go Workflow).
//   - GET /v1/me/tasks      -> { "data": Task[], "cursor": string|null } via the
//                              shared cursorEnvelope (handlers/user.go GetMyTasks —
//                              this handler is BUILT, not a stub). Accepts the
//                              `limit`, `cursor` query params; `role` is accepted
//                              and IGNORED server-side, so we never send it.

import { request as undiciRequest } from 'undici';

import { McpError, mapHttpError, toMcpError } from '../errors.js';
import type { PyramidConfig } from '../types.js';

/** HTTP verbs this client issues. Phase 1 is read-only, but the seam is general. */
type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A query map; null/undefined values are skipped when building the URL. */
type Query = Record<string, string | number | boolean | null | undefined>;

/** Per-call options for the private transport. */
interface RequestOptions {
	query?: Query;
	body?: unknown;
	/** Extra request headers (e.g. an `If-Match` precondition). */
	headers?: Record<string, string>;
}

/** A parsed body paired with the response's `ETag` header (read-first flow). */
interface ResponseWithETag<T> {
	body: T;
	etag: string | null;
}

/** The locked cursor envelope shared by `/v1/projects` and `/v1/me/tasks`. */
interface CursorEnvelope {
	data?: unknown;
	cursor?: unknown;
}

export class PyramidClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;

	constructor(config: PyramidConfig) {
		// Trim a single trailing slash so `${baseUrl}/v1/...` never doubles up.
		// loadConfig already normalizes, but stay defensive against a hand-built config.
		this.baseUrl = config.baseUrl.endsWith('/') ? config.baseUrl.slice(0, -1) : config.baseUrl;
		this.apiKey = config.apiKey;
	}

	// ---- Phase-1 read-only surface (raw server JSON; hydration is elsewhere) ----

	/**
	 * GET /v1/me — the authenticated user (raw `model.User`). The payload may carry
	 * a workspace in a future revision, so callers read it defensively; today it is
	 * just the user record. Returned raw.
	 */
	getMe(): Promise<unknown> {
		return this.request<unknown>('GET', '/v1/me');
	}

	/**
	 * GET /v1/workspaces — the caller's workspaces. The API key is workspace-pinned,
	 * so this is effectively a single-element list (the op layer takes `[0]` as the
	 * pinned workspace). Server shape is `{ data: Workspace[] }`; we unwrap to the
	 * array and tolerate a bare array.
	 */
	listWorkspaces(): Promise<unknown[]> {
		return this.request<unknown>('GET', '/v1/workspaces').then(unwrapData);
	}

	/**
	 * GET /v1/projects — accessible projects. Server shape is
	 * `{ data: Project[], cursor }`; we unwrap `data` (tolerating a bare array).
	 * First-page discovery only — Phase-1 needs no pagination here.
	 */
	listProjects(): Promise<unknown[]> {
		return this.request<unknown>('GET', '/v1/projects').then(unwrapData);
	}

	/**
	 * GET /v1/projects/{id}/workflow — the project's workflow (stages, statuses,
	 * labels, members, templates). Returned raw; the Resolver/hydrate layer joins
	 * it. `projectId` must already be a UUID (name->id resolution lives upstream).
	 */
	getWorkflow(projectId: string): Promise<unknown> {
		return this.request<unknown>('GET', `/v1/projects/${encodeURIComponent(projectId)}/workflow`);
	}

	/**
	 * GET /v1/me/tasks — the tasks the caller OWNS or REPORTS, across projects,
	 * newest first, with an opaque keyset cursor. Returns the raw `{ data, cursor }`
	 * envelope (cursor normalized to `string | null`). `limit` caps the page;
	 * `cursor` continues a prior page.
	 *
	 * There is deliberately NO `role` parameter: the server accepts `?role=` and
	 * IGNORES it (DOC-BACKEND-CONTRACT), so sending it would promise a narrowing
	 * that never happens.
	 */
	async listMyTasks(opts?: {
		limit?: number;
		cursor?: string;
	}): Promise<{ data: unknown[]; cursor: string | null }> {
		const envelope = await this.request<CursorEnvelope>('GET', '/v1/me/tasks', {
			query: {
				limit: opts?.limit,
				cursor: opts?.cursor,
			},
		});
		return {
			data: Array.isArray(envelope?.data) ? envelope.data : [],
			cursor: typeof envelope?.cursor === 'string' ? envelope.cursor : null,
		};
	}

	// ---- Phase-2 task read surface (raw server JSON; hydration is elsewhere) ----

	/**
	 * GET /v1/projects/{id}/tasks — a project's tasks, newest first, with an opaque
	 * keyset cursor. Returns the raw `{ data, cursor }` envelope (cursor normalized
	 * to `string | null`). All filter values are already-resolved UUIDs (`status` is
	 * a status UUID, plus `stage_id`/`owner_id`/`reporter_id`/`label_id`) or free
	 * text (`q`); `expand` opts relations into the rows. `projectId` must already be
	 * a UUID. (Real query names per DOC-BACKEND-CONTRACT — no `assignee_id`.)
	 */
	async listTasks(
		projectId: string,
		opts?: {
			status?: string;
			stage_id?: string;
			owner_id?: string;
			reporter_id?: string;
			label_id?: string;
			q?: string;
			limit?: number;
			cursor?: string;
			expand?: string;
		}
	): Promise<{ data: unknown[]; cursor: string | null }> {
		const envelope = await this.request<CursorEnvelope>(
			'GET',
			`/v1/projects/${encodeURIComponent(projectId)}/tasks`,
			{
				query: {
					status: opts?.status,
					stage_id: opts?.stage_id,
					owner_id: opts?.owner_id,
					reporter_id: opts?.reporter_id,
					label_id: opts?.label_id,
					q: opts?.q,
					limit: opts?.limit,
					cursor: opts?.cursor,
					expand: opts?.expand,
				},
			}
		);
		return normalizeCursorEnvelope(envelope);
	}

	/**
	 * GET /v1/projects/{id}/tasks/archived — a project's ARCHIVED tasks (a separate
	 * route from `listTasks`). Returns the raw `{ data, cursor }` envelope. `opts`
	 * carries `archived_after`/`limit`/`cursor`. `projectId` must already be a UUID.
	 */
	async listArchived(
		projectId: string,
		opts?: { archived_after?: string; limit?: number; cursor?: string }
	): Promise<{ data: unknown[]; cursor: string | null }> {
		const envelope = await this.request<CursorEnvelope>(
			'GET',
			`/v1/projects/${encodeURIComponent(projectId)}/tasks/archived`,
			{
				query: {
					archived_after: opts?.archived_after,
					limit: opts?.limit,
					cursor: opts?.cursor,
				},
			}
		);
		return normalizeCursorEnvelope(envelope);
	}

	/**
	 * GET /v1/projects/{id}/labels — a project's labels (separate from /workflow).
	 * Returns a bare array of raw label rows (tolerating a `{ data }` envelope).
	 */
	listLabels(projectId: string): Promise<unknown[]> {
		return this.request<unknown>(
			'GET',
			`/v1/projects/${encodeURIComponent(projectId)}/labels`
		).then(unwrapData);
	}

	/**
	 * GET /v1/projects/{id}/members — a project's members (separate from /workflow).
	 * Returns a bare array of raw `ProjectMember` rows (each carries `user`).
	 */
	listMembers(projectId: string): Promise<unknown[]> {
		return this.request<unknown>(
			'GET',
			`/v1/projects/${encodeURIComponent(projectId)}/members`
		).then(unwrapData);
	}

	/**
	 * GET /v1/projects/{id}/task-schema — the project's custom-field schema. Returns
	 * the raw `{ templates, fields_by_template }` payload (the Resolver merges it
	 * into the cached Workflow shape).
	 */
	getTaskSchema(projectId: string): Promise<unknown> {
		return this.request<unknown>(
			'GET',
			`/v1/projects/${encodeURIComponent(projectId)}/task-schema`
		);
	}

	/**
	 * GET /v1/tasks/{id}/timeline — one page of a task's history, **oldest first**
	 * (the reverse of every other list here). Returns the raw `{ data, cursor }`
	 * envelope. `limit` defaults to 50 server-side and is capped at 200;
	 * `event_type` narrows to one kind (e.g. `owner_changed`). No If-Match.
	 */
	async getTaskTimeline(
		taskId: string,
		opts?: { limit?: number; cursor?: string; event_type?: string }
	): Promise<{ data: unknown[]; cursor: string | null }> {
		const envelope = await this.request<CursorEnvelope>(
			'GET',
			`/v1/tasks/${encodeURIComponent(taskId)}/timeline`,
			{
				query: {
					limit: opts?.limit,
					cursor: opts?.cursor,
					event_type: opts?.event_type,
				},
			}
		);
		return normalizeCursorEnvelope(envelope);
	}

	/**
	 * GET /v1/tasks/{id} — one task's full detail (raw `RawTaskDetail`). A non-empty
	 * `expand` enables relations (editor/timeline/comments/estimates/followers/…);
	 * omit it for the lean shape. `taskId` must already be a UUID.
	 */
	getTask(taskId: string, expand?: string): Promise<unknown> {
		return this.request<unknown>('GET', `/v1/tasks/${encodeURIComponent(taskId)}`, {
			query: { expand },
		});
	}

	/**
	 * GET /v1/search/tasks — full-text task search across the workspace. Returns the
	 * raw `{ data }` envelope (no cursor per DOC-BACKEND-CONTRACT; normalized to a
	 * null cursor). `q` is the query; the optional filters are already-resolved user
	 * UUIDs.
	 */
	async searchTasks(opts: {
		q: string;
		owner_id?: string;
		reporter_id?: string;
		limit?: number;
	}): Promise<{ data: unknown[]; cursor: string | null }> {
		const envelope = await this.request<CursorEnvelope>('GET', '/v1/search/tasks', {
			query: {
				q: opts.q,
				owner_id: opts.owner_id,
				reporter_id: opts.reporter_id,
				limit: opts.limit,
			},
		});
		return normalizeCursorEnvelope(envelope);
	}

	// ---- Phase-2 task write surface (raw server JSON; resolution is elsewhere) ----

	/**
	 * POST /v1/projects/{id}/tasks — create one task. `body` is the already-resolved
	 * create payload (status_id/owner_id/label_ids/…); this client does no name
	 * resolution. Returns the raw `RawTaskDetail` of the created task.
	 */
	createTask(projectId: string, body: unknown): Promise<unknown> {
		return this.request<unknown>('POST', `/v1/projects/${encodeURIComponent(projectId)}/tasks`, {
			body,
		});
	}

	/**
	 * POST /v1/tasks/bulk — create many tasks. `body` is the resolved
	 * `{ project_id, template_id, tasks: [...] }` batch. The server replies
	 * `{ created: [Task], errors: [] }`; this returns the RAW envelope (the op
	 * hydrates `created`). No If-Match.
	 */
	bulkCreate(body: unknown): Promise<unknown> {
		return this.request<unknown>('POST', '/v1/tasks/bulk', { body });
	}

	/**
	 * PATCH /v1/tasks/{id} — sparse update of a task's content (title/description/
	 * priority/dates/estimate/guest_*) AND its `owner_id`/`reporter_id` (an explicit
	 * null clears one). `body` still carries NO labels and NO field_values — those
	 * keep their dedicated endpoints. Requires If-Match
	 * (DOC-CONCURRENCY): GET first to capture the ETag, send it, retry ONCE on 409.
	 * Returns the raw updated `RawTaskDetail`.
	 */
	updateTask(taskId: string, body: unknown): Promise<unknown> {
		return this.withPrecondition(taskId, (etag) =>
			this.request<unknown>('PATCH', `/v1/tasks/${encodeURIComponent(taskId)}`, {
				body,
				headers: { 'if-match': etag },
			})
		);
	}

	/**
	 * PATCH /v1/tasks/{id}/move — change a task's status (which carries its stage)
	 * and/or its position via neighbor ids. `body` is
	 * `{ status_id, before_id?, after_id? }` — already-resolved UUIDs; positions are
	 * server-generated, never a fractional key. The server replies an ENVELOPE
	 * `{ task, previous }`; this returns it raw (the op hydrates `raw.task`). No
	 * If-Match.
	 */
	moveTask(taskId: string, body: unknown): Promise<unknown> {
		return this.request<unknown>('PATCH', `/v1/tasks/${encodeURIComponent(taskId)}/move`, { body });
	}

	/**
	 * POST /v1/tasks/{id}/labels — add a label to an existing task. `labelId` is an
	 * already-resolved label UUID. No If-Match. Returns the raw response.
	 */
	addTaskLabel(taskId: string, labelId: string): Promise<unknown> {
		return this.request<unknown>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/labels`, {
			body: { label_id: labelId },
		});
	}

	/**
	 * DELETE /v1/tasks/{id}/labels/{labelId} — remove a label from a task. Both ids
	 * are already-resolved UUIDs. No If-Match. Resolves to void (204).
	 */
	async removeTaskLabel(taskId: string, labelId: string): Promise<void> {
		await this.request<unknown>(
			'DELETE',
			`/v1/tasks/${encodeURIComponent(taskId)}/labels/${encodeURIComponent(labelId)}`
		);
	}

	/**
	 * PATCH /v1/tasks/{id}/field-values — bulk-set a task's custom-field values.
	 * `body` is `{ field_values: { <fieldId>: value } }` keyed by field UUID. No
	 * If-Match. Returns the raw response.
	 */
	setFieldValues(taskId: string, body: unknown): Promise<unknown> {
		return this.request<unknown>('PATCH', `/v1/tasks/${encodeURIComponent(taskId)}/field-values`, {
			body,
		});
	}

	/**
	 * POST /v1/tasks/{id}/archive — soft-archive a task (reversible via the op's
	 * `unarchiveTask`). Returns the raw updated `RawTaskDetail`.
	 */
	archiveTask(taskId: string): Promise<unknown> {
		return this.request<unknown>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/archive`);
	}

	/**
	 * POST /v1/tasks/{id}/unarchive — restore a soft-archived task. Returns the raw
	 * updated `RawTaskDetail`. (The `task.archive` op picks archive vs unarchive.)
	 */
	unarchiveTask(taskId: string): Promise<unknown> {
		return this.request<unknown>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/unarchive`);
	}

	/**
	 * DELETE /v1/tasks/{id} — delete a task. `hard=true` requests a hard delete
	 * (the destructive op gates this upstream behind PYRAMID_ALLOW_DESTRUCTIVE).
	 * Requires If-Match (DOC-CONCURRENCY): GET first to capture the ETag, send it,
	 * retry ONCE on 409. The server replies 204; resolves to void.
	 */
	async deleteTask(taskId: string, hard: boolean): Promise<void> {
		await this.withPrecondition(taskId, (etag) =>
			this.request<unknown>('DELETE', `/v1/tasks/${encodeURIComponent(taskId)}`, {
				query: { hard },
				headers: { 'if-match': etag },
			})
		);
	}

	// ---- Phase-2 comment surface (raw server JSON; resolution is elsewhere) ----

	/**
	 * GET /v1/tasks/{id}/comments — a task's comments, stage-scoped. Returns the raw
	 * `{ data, cursor }` envelope. `stage_id` (already a UUID) narrows to one stage;
	 * omit it to read across stages.
	 */
	async listComments(
		taskId: string,
		opts?: { stage_id?: string; limit?: number; cursor?: string }
	): Promise<{ data: unknown[]; cursor: string | null }> {
		const envelope = await this.request<CursorEnvelope>(
			'GET',
			`/v1/tasks/${encodeURIComponent(taskId)}/comments`,
			{
				query: {
					stage_id: opts?.stage_id,
					limit: opts?.limit,
					cursor: opts?.cursor,
				},
			}
		);
		return normalizeCursorEnvelope(envelope);
	}

	/**
	 * POST /v1/tasks/{id}/comments — add a root (stage-scoped) comment. `body` is
	 * `{ content, stage_id?, mention_user_ids? }` with already-resolved mention
	 * UUIDs; `stage_id` defaults to the task's current stage upstream. Returns the
	 * raw `RawComment`.
	 */
	addComment(taskId: string, body: unknown): Promise<unknown> {
		return this.request<unknown>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/comments`, {
			body,
		});
	}

	/**
	 * GET /v1/comments/{id} — one comment (raw `RawComment`). The `comment.reply`
	 * op fetches the target to verify it is a ROOT comment (`parent_id` /
	 * `thread_root_id` null) BEFORE replying, enforcing the one-level rule. Returned
	 * raw; resolution/hydration is elsewhere. `commentId` must already be a UUID.
	 */
	getComment(commentId: string): Promise<unknown> {
		return this.request<unknown>('GET', `/v1/comments/${encodeURIComponent(commentId)}`);
	}

	/**
	 * POST /v1/comments/{id}/replies — reply to a ROOT comment (one level only; the
	 * op rejects reply-to-reply before this call). `body` is
	 * `{ content, mention_user_ids? }` with already-resolved mention UUIDs. Returns
	 * the raw `RawComment`.
	 */
	replyComment(commentId: string, body: unknown): Promise<unknown> {
		return this.request<unknown>('POST', `/v1/comments/${encodeURIComponent(commentId)}/replies`, {
			body,
		});
	}

	// ---------------------------- core request ----------------------------

	/**
	 * Issue one authenticated JSON request and return the parsed body as `T`.
	 *
	 * - Sets Bearer auth + `Accept: application/json` (and `Content-Type` for a body).
	 * - 2xx: returns the parsed JSON (an empty/204 body parses to `undefined`).
	 * - non-2xx: parses the `{ error: { code, message } }` envelope (best effort)
	 *   and throws `mapHttpError(status, body)`.
	 * - undici/transport failure (DNS, connect, reset, timeout): throws
	 *   `McpError('network', ...)` via `toMcpError`.
	 *
	 * The API key is on the header only — never logged, never in the URL.
	 */
	private async request<T>(method: HttpMethod, path: string, opts?: RequestOptions): Promise<T> {
		return (await this.requestWithETag<T>(method, path, opts)).body;
	}

	/**
	 * The transport core, also returning the response's `ETag` header (null when
	 * absent). `request<T>()` is the body-only sugar over this; the If-Match
	 * read-first flow reads the etag here (DOC-CONCURRENCY).
	 */
	private async requestWithETag<T>(
		method: HttpMethod,
		path: string,
		opts?: RequestOptions
	): Promise<ResponseWithETag<T>> {
		const url = this.buildUrl(path, opts?.query);

		const headers: Record<string, string> = {
			authorization: `Bearer ${this.apiKey}`,
			accept: 'application/json',
		};

		let bodyText: string | undefined;
		if (opts?.body !== undefined) {
			bodyText = JSON.stringify(opts.body);
			headers['content-type'] = 'application/json';
		}

		// Per-call headers (e.g. an `If-Match` precondition) are applied last so they
		// can never clobber auth/accept above (which they never name).
		if (opts?.headers) {
			for (const [k, v] of Object.entries(opts.headers)) headers[k] = v;
		}

		let status: number;
		let raw: string;
		let etag: string | null;
		try {
			const res = await undiciRequest(url, {
				method,
				headers,
				body: bodyText,
			});
			status = res.statusCode;
			etag = readETagHeader(res.headers);
			// Always drain the body (even on 204) so the connection can be reused.
			raw = await res.body.text();
		} catch (err) {
			// Transport-level throw (DNS / connect / reset / timeout / undici TypeError).
			// Coerce to McpError; any non-McpError cause is forced to code 'network'.
			const mapped = toMcpError(err);
			throw mapped.code === 'network'
				? mapped
				: new McpError('network', mapped.message, {
						hint: 'Check PYRAMID_BASE_URL and your network connection.',
					});
		}

		const parsed = safeJsonParse(raw);

		if (status < 200 || status >= 300) {
			// `parsed` is the canonical `{ error: { code, message, details } }` envelope
			// on a well-behaved error; mapHttpError reads it defensively and falls back
			// to a status-derived code/message when the body is empty or non-JSON.
			throw mapHttpError(status, parsed);
		}

		// A 2xx with an empty/204 body yields `undefined` — fine for void callers.
		return { body: parsed as T, etag };
	}

	/**
	 * Capture the current ETag for a task (DOC-CONCURRENCY): GET /v1/tasks/{id} and
	 * read its `ETag` response header, falling back to the body's `updated_at` when
	 * the header is absent. Used by the If-Match read-first flow.
	 */
	private async getTaskETag(taskId: string): Promise<string> {
		const res = await this.requestWithETag<unknown>(
			'GET',
			`/v1/tasks/${encodeURIComponent(taskId)}`
		);
		if (res.etag) return res.etag;
		// No ETag header — fall back to the body's updated_at (the token's source).
		const body = res.body;
		if (body && typeof body === 'object') {
			const updatedAt = (body as { updated_at?: unknown }).updated_at;
			if (typeof updatedAt === 'string' && updatedAt.length > 0) return updatedAt;
		}
		return '';
	}

	/**
	 * Run an If-Match-guarded mutation (PATCH update / DELETE) with the read-first
	 * flow (DOC-CONCURRENCY): GET to capture the ETag, run `fn(etag)`, and on a 409
	 * `conflict` refetch the ETag and retry ONCE before surfacing the conflict.
	 */
	private async withPrecondition<T>(taskId: string, fn: (etag: string) => Promise<T>): Promise<T> {
		const etag = await this.getTaskETag(taskId);
		try {
			return await fn(etag);
		} catch (err) {
			if (err instanceof McpError && err.code === 'conflict') {
				// A genuine concurrent edit — refetch the ETag and retry exactly once.
				const fresh = await this.getTaskETag(taskId);
				return fn(fresh);
			}
			throw err;
		}
	}

	/** Build an absolute URL, appending defined query params (skips null/undefined). */
	private buildUrl(path: string, query?: Query): string {
		const url = new URL(`${this.baseUrl}${path}`);
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value === undefined || value === null) continue;
				url.searchParams.set(key, String(value));
			}
		}
		return url.toString();
	}
}

/**
 * Read the `ETag` response header (case-insensitive) out of undici's header bag,
 * tolerating a string or string[] value. Returns null when absent.
 */
function readETagHeader(headers: Record<string, string | string[] | undefined>): string | null {
	const value = headers.etag ?? headers.ETag;
	if (Array.isArray(value)) return value[0] ?? null;
	return typeof value === 'string' ? value : null;
}

/**
 * Unwrap the `{ data: [...] }` list envelope into its array. Tolerant: accepts a
 * bare array (returns it), an envelope (returns `.data` when it's an array), or
 * anything else (returns `[]`). Keeps the client resilient to envelope drift.
 */
function unwrapData(body: unknown): unknown[] {
	if (Array.isArray(body)) return body;
	if (body && typeof body === 'object' && 'data' in body) {
		const data = (body as { data?: unknown }).data;
		if (Array.isArray(data)) return data;
	}
	return [];
}

/**
 * Normalize a `{ data, cursor }` cursor envelope into `{ data: unknown[], cursor:
 * string | null }`: a missing/non-array `data` -> `[]`, a non-string `cursor` ->
 * `null`. The same normalization `listMyTasks` applies inline — shared by the
 * Phase-2 list methods (listTasks / searchTasks / listComments).
 */
function normalizeCursorEnvelope(envelope: CursorEnvelope): {
	data: unknown[];
	cursor: string | null;
} {
	return {
		data: Array.isArray(envelope?.data) ? envelope.data : [],
		cursor: typeof envelope?.cursor === 'string' ? envelope.cursor : null,
	};
}

/**
 * Parse a JSON string. An empty body (e.g. 204) -> `undefined`; a non-JSON body
 * -> `undefined` (rather than throwing) so a malformed error page still maps to a
 * clean status-derived McpError instead of crashing the parse.
 */
function safeJsonParse(text: string): unknown {
	if (text.trim() === '') return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
