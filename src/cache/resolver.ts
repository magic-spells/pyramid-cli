// Name -> UUID resolution with deterministic precedence + a 60s workflow cache
// (FILE-RESOLVER, DOC-NAME-RESOLUTION).
//
// Inputs accept human names/keys/handles; the Resolver maps them to the strict
// workflow shapes in src/types.ts. The precedence is fixed so the same input
// always resolves the same way:
//   - project: handle (ci exact) -> name (ci exact) -> unique fuzzy contains
//   - status:  key (ci) -> name (ci) -> category (ci) -> stage-name (first
//              status of that stage by position)
//   - stage:   key (ci) -> name (ci) -> category (ci) -> unique fuzzy contains
//   - user:    email (ci exact) -> display_name (ci exact) -> unique fuzzy
//   - label:   name (ci exact) -> unique fuzzy contains
//
// A tier with >1 match throws McpError('ambiguous_*_name', …, { candidates }).
// Every tier empty throws McpError('*_not_found', …, { candidates: closeMatches }).
//
// The workflow is the join source for hydration (src/hydrate.ts) and is cached
// per projectId for 60s via a simple Map + timestamp. The project list (for
// project-name resolution) is cached the same way.

import { McpError } from '../errors.js';
import type {
	ProjectSummary,
	Workflow,
	WorkflowStage,
	WorkflowStatus,
	WorkflowMember,
} from '../types.js';

// ============ Structural client dependency ============
//
// The Resolver depends only on the two read methods it needs, typed
// structurally so it is decoupled from the concrete PyramidClient class and
// from the exact `Raw*` row shapes. The real client satisfies this; the
// resolver tests pass a small fake implementing just these. Both methods return
// `unknown` (per the spec's client signatures) — we normalize defensively.

export interface ResolverClient {
	/** GET /v1/projects — bare array or `{ data | items | results }` envelope. */
	listProjects(...args: unknown[]): Promise<unknown>;
	/** GET /v1/projects/{id}/workflow — raw `{ stages: [...] }` (stages+statuses ONLY). */
	getWorkflow(projectId: string): Promise<unknown>;
	/** GET /v1/projects/{id}/labels — raw label rows (separate from /workflow). */
	listLabels(projectId: string): Promise<unknown[]>;
	/** GET /v1/projects/{id}/members — raw `ProjectMember` rows (carry `user`). */
	listMembers(projectId: string): Promise<unknown[]>;
	/** GET /v1/projects/{id}/task-schema — raw `{ templates, fields_by_template }`. */
	getTaskSchema(projectId: string): Promise<unknown>;
}

// ============ Cache primitives ============

const TTL_MS = 60_000;

interface Cached<T> {
	value: T;
	expiresAt: number;
}

/** A workflow cache kind, used by `invalidate`. */
export type ResolveKind = 'project' | 'workflow' | 'status' | 'stage' | 'user' | 'label';

// ============ Resolver ============

export class Resolver {
	/** Per-project workflow cache (also the hydration join source). */
	private readonly workflows = new Map<string, Cached<Workflow>>();
	/** Workspace-wide project list cache (backs project-name resolution). */
	private projects?: Cached<ProjectSummary[]>;

	constructor(private readonly client: ResolverClient) {}

	// ---------- Workflow fetch + 60s cache ----------

	/**
	 * Cached workflow for a project (60s TTL). One fetch warms every kind of
	 * resolution for that project. Backs `get_project_workflow` and hydration.
	 */
	async getWorkflow(projectId: string): Promise<Workflow> {
		const hit = this.workflows.get(projectId);
		if (hit && hit.expiresAt > Date.now()) return hit.value;

		// The real GET /workflow returns ONLY stages+statuses; labels, members, and
		// custom-field templates live on separate endpoints. Fan out in parallel and
		// MERGE into the single cached Workflow shape the resolver/hydrate layer uses
		// (DOC-BACKEND-CONTRACT).
		const [rawWf, rawLabels, rawMembers, rawSchema] = await Promise.all([
			this.client.getWorkflow(projectId),
			this.client.listLabels(projectId),
			this.client.listMembers(projectId),
			this.client.getTaskSchema(projectId),
		]);
		const wf = normalizeWorkflow(rawWf);
		wf.labels = (Array.isArray(rawLabels) ? rawLabels : []).map(normalizeLabel);
		wf.members = (Array.isArray(rawMembers) ? rawMembers : []).map(normalizeMember);
		wf.templates = normalizeTaskSchema(rawSchema);
		this.workflows.set(projectId, { value: wf, expiresAt: Date.now() + TTL_MS });
		return wf;
	}

	// ---------- Project ----------

	/** handle (ci exact) -> name (ci exact) -> unique fuzzy contains. */
	async resolveProject(nameOrHandle: string): Promise<ProjectSummary> {
		const projects = await this.getProjects();
		const needle = norm(nameOrHandle);

		const byHandle = projects.filter((p) => norm(p.handle) === needle);
		const byName = projects.filter((p) => norm(p.name) === needle);
		const fuzzy = projects.filter((p) => contains(p.handle, needle) || contains(p.name, needle));

		const match = pick(
			'project',
			'ambiguous_project_name',
			nameOrHandle,
			[byHandle, byName, fuzzy],
			(p) => p.handle
		);
		if (match) return match;

		throw new McpError('project_not_found', `No project matches "${nameOrHandle}".`, {
			candidates: shortlist(
				nameOrHandle,
				projects.map((p) => p.handle)
			),
		});
	}

	// ---------- Status ----------

	/**
	 * key (ci) -> name (ci) -> category (ci) -> stage-name (first status of that
	 * stage by position). Returns the full WorkflowStatus (carries stage_id).
	 */
	async resolveStatus(projectId: string, q: string): Promise<WorkflowStatus> {
		const wf = await this.getWorkflow(projectId);
		const needle = norm(q);

		const byKey = wf.statuses.filter((s) => norm(s.key) === needle);
		const byName = wf.statuses.filter((s) => norm(s.name) === needle);
		const byCategory = wf.statuses.filter(
			(s) => s.category !== undefined && norm(s.category) === needle
		);

		let match = pick(
			'status',
			'ambiguous_status_name',
			q,
			[byKey, byName, byCategory],
			(s) => s.name
		);

		// A stage name where a status is expected -> first status of that stage by
		// position (DOC-NAME-RESOLUTION).
		if (!match) {
			const stage = wf.stages.find((s) => norm(s.key) === needle || norm(s.name) === needle);
			if (stage) {
				const first = firstStatusOfStage(wf, stage.id);
				if (first) match = first;
			}
		}

		// Unique fuzzy contains as a last tier.
		if (!match) {
			const fuzzy = wf.statuses.filter((s) => contains(s.key, needle) || contains(s.name, needle));
			match = pick('status', 'ambiguous_status_name', q, [fuzzy], (s) => s.name);
		}

		if (match) return match;

		throw new McpError('status_not_found', `No status matches "${q}".`, {
			candidates: shortlist(
				q,
				wf.statuses.map((s) => s.name)
			),
		});
	}

	// ---------- Stage ----------

	/** key (ci) -> name (ci) -> category (ci) -> unique fuzzy contains. */
	async resolveStage(projectId: string, q: string): Promise<WorkflowStage> {
		const wf = await this.getWorkflow(projectId);
		const needle = norm(q);

		const byKey = wf.stages.filter((s) => norm(s.key) === needle);
		const byName = wf.stages.filter((s) => norm(s.name) === needle);
		const byCategory = wf.stages.filter(
			(s) => s.category !== undefined && norm(s.category) === needle
		);
		const fuzzy = wf.stages.filter((s) => contains(s.key, needle) || contains(s.name, needle));

		const match = pick(
			'stage',
			'ambiguous_stage_name',
			q,
			[byKey, byName, byCategory, fuzzy],
			(s) => s.name
		);
		if (match) return match;

		throw new McpError('stage_not_found', `No stage matches "${q}".`, {
			candidates: shortlist(
				q,
				wf.stages.map((s) => s.name)
			),
		});
	}

	// ---------- User ----------

	/** email (ci exact) -> display_name (ci exact) -> unique fuzzy contains. */
	async resolveUser(projectId: string, q: string): Promise<WorkflowMember> {
		const wf = await this.getWorkflow(projectId);
		const needle = norm(q);

		const byEmail = wf.members.filter((m) => norm(m.email) === needle);
		const byName = wf.members.filter((m) => norm(m.display_name) === needle);
		const fuzzy = wf.members.filter(
			(m) => contains(m.email, needle) || contains(m.display_name, needle)
		);

		const match = pick(
			'user',
			'ambiguous_user_name',
			q,
			[byEmail, byName, fuzzy],
			(m) => m.display_name
		);
		if (match) return match;

		throw new McpError('user_not_found', `No user matches "${q}".`, {
			candidates: shortlist(
				q,
				wf.members.map((m) => m.display_name)
			),
		});
	}

	// ---------- Label ----------

	/** name (ci exact) -> unique fuzzy contains. */
	async resolveLabel(projectId: string, q: string): Promise<{ id: string; name: string }> {
		const wf = await this.getWorkflow(projectId);
		const needle = norm(q);

		const byName = wf.labels.filter((l) => norm(l.name) === needle);
		const fuzzy = wf.labels.filter((l) => contains(l.name, needle));

		const match = pick('label', 'ambiguous_label_name', q, [byName, fuzzy], (l) => l.name);
		if (match) return { id: match.id, name: match.name };

		throw new McpError('label_not_found', `No label matches "${q}".`, {
			candidates: shortlist(
				q,
				wf.labels.map((l) => l.name)
			),
		});
	}

	// ---------- Invalidation ----------

	/**
	 * Drop cached data after a mutating op. One getWorkflow warms every per-project
	 * kind, so any per-project kind invalidates the whole project workflow entry;
	 * `project` also clears the workspace-wide project list. With no `kind`, clear
	 * everything cached for the project.
	 */
	invalidate(projectId: string, kind?: ResolveKind): void {
		if (kind === 'project') {
			this.projects = undefined;
			return;
		}
		this.workflows.delete(projectId);
		if (kind === undefined && (projectId === '' || projectId === '*')) {
			this.projects = undefined;
		}
	}

	// ---------- Internal: project-list cache ----------

	private async getProjects(): Promise<ProjectSummary[]> {
		if (this.projects && this.projects.expiresAt > Date.now()) {
			return this.projects.value;
		}
		const raw = await this.client.listProjects();
		const projects = extractArray(raw).map(normalizeProject);
		this.projects = { value: projects, expiresAt: Date.now() + TTL_MS };
		return projects;
	}
}

// ============ Precedence helper ============

/**
 * Walk precedence tiers in order. The first tier with >=1 match decides:
 * exactly one -> return it; more than one -> throw the ambiguous error with
 * candidate labels. An empty tier falls through. Returns undefined only when
 * every tier was empty (the caller throws *_not_found).
 */
function pick<T>(
	_kind: string,
	ambiguousCode:
		| 'ambiguous_project_name'
		| 'ambiguous_user_name'
		| 'ambiguous_label_name'
		| 'ambiguous_status_name'
		| 'ambiguous_stage_name',
	query: string,
	tiers: T[][],
	label: (item: T) => string
): T | undefined {
	for (const tier of tiers) {
		if (tier.length === 1) return tier[0];
		if (tier.length > 1) {
			// `ambiguous_status_name` / `ambiguous_stage_name` aren't in the
			// McpErrorCode union; fall back to validation_failed for those so the
			// surfaced code is always a valid contract code.
			const code = isMcpAmbiguousCode(ambiguousCode) ? ambiguousCode : 'validation_failed';
			throw new McpError(code, `"${query}" is ambiguous — ${tier.length} matches.`, {
				candidates: dedupeStrings(tier.map(label)),
			});
		}
	}
	return undefined;
}

/** True for the ambiguity codes that exist in the McpErrorCode union. */
function isMcpAmbiguousCode(
	code: string
): code is 'ambiguous_project_name' | 'ambiguous_user_name' | 'ambiguous_label_name' {
	return (
		code === 'ambiguous_project_name' ||
		code === 'ambiguous_user_name' ||
		code === 'ambiguous_label_name'
	);
}

// ============ Defensive normalization (raw server JSON -> strict types) ============

/** Pull an array out of a bare array or a `{ data | items | results }` envelope. */
function extractArray(body: unknown): unknown[] {
	if (Array.isArray(body)) return body;
	if (body && typeof body === 'object') {
		const obj = body as Record<string, unknown>;
		for (const key of ['data', 'items', 'results', 'projects']) {
			const val = obj[key];
			if (Array.isArray(val)) return val;
		}
	}
	return [];
}

function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, fallback = ''): string {
	return typeof v === 'string' ? v : fallback;
}

function optStr(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const PROJECT_ROLES = ['admin', 'pm', 'member', 'viewer', 'guest'] as const;
type ProjectRole = (typeof PROJECT_ROLES)[number];

function projectRole(v: unknown): ProjectRole {
	return (PROJECT_ROLES as readonly string[]).includes(str(v)) ? (str(v) as ProjectRole) : 'member';
}

/** Raw project row -> ProjectSummary (archived derived from archived_at). */
function normalizeProject(raw: unknown): ProjectSummary {
	const p = rec(raw);
	return {
		id: str(p.id),
		handle: str(p.handle),
		name: str(p.name),
		task_prefix: str(p.task_prefix),
		role: projectRole(p.role),
		archived: p.archived_at != null || p.archived === true,
	};
}

function normalizeStage(raw: unknown): WorkflowStage {
	const s = rec(raw);
	const stage: WorkflowStage = {
		id: str(s.id),
		key: str(s.key),
		name: str(s.name),
		position: str(s.position),
	};
	const category = optStr(s.category);
	if (category !== undefined) stage.category = category;
	return stage;
}

function normalizeStatus(raw: unknown): WorkflowStatus {
	const s = rec(raw);
	const status: WorkflowStatus = {
		id: str(s.id),
		key: str(s.key),
		name: str(s.name),
		stage_id: str(s.stage_id),
		position: str(s.position),
	};
	const category = optStr(s.category);
	if (category !== undefined) status.category = category;
	return status;
}

/**
 * Raw `ProjectMember` row -> WorkflowMember. The real `/members` row carries the
 * user's name/email under a nested `user` (DOC-BACKEND-CONTRACT) and its own
 * `job_title`; we read those first and fall back to top-level fields for a
 * flatter shape. The member id is
 * the USER id (what owner_id/reporter_id/author_id reference), so prefer
 * `user.id` / `user_id` over the membership row's own id.
 */
function normalizeMember(raw: unknown): WorkflowMember {
	const m = rec(raw);
	const u = rec(m.user);
	const member: WorkflowMember = {
		id: str(u.id) || str(m.user_id) || str(m.id),
		display_name: str(u.display_name) || str(m.display_name),
		email: str(u.email) || str(m.email),
		role: str(m.role) || str(u.role),
	};
	// job_title is the person's OWN title ("Design Lead"), not the permission role.
	// It rides the membership row (and is mirrored onto the nested user), and is
	// what lets hydrate label an Owner without a per-task `?expand`.
	const jobTitle = optStr(m.job_title) ?? optStr(u.job_title);
	if (jobTitle !== undefined) member.job_title = jobTitle;
	return member;
}

/**
 * Raw task-schema `{ templates, fields_by_template }` -> the templates[].fields
 * shape the resolver/hydrate/customFields code expects. `fields_by_template` maps
 * a template id to its CustomField rows; we fold those into each template.
 */
function normalizeTaskSchema(raw: unknown): Workflow['templates'] {
	const s = rec(raw);
	const fieldsByTemplate = rec(s.fields_by_template);
	const templates = Array.isArray(s.templates) ? s.templates : [];
	return templates.map((t) => {
		const tt = rec(t);
		const id = str(tt.id);
		const rawFields = fieldsByTemplate[id];
		const fields = (Array.isArray(rawFields) ? rawFields : []).map(normalizeField);
		return { id, name: str(tt.name), fields };
	});
}

function normalizeLabel(raw: unknown): { id: string; name: string; color: string } {
	const l = rec(raw);
	return { id: str(l.id), name: str(l.name), color: str(l.color) };
}

function normalizeField(raw: unknown): Workflow['templates'][number]['fields'][number] {
	const f = rec(raw);
	const field: Workflow['templates'][number]['fields'][number] = {
		id: str(f.id),
		key: str(f.key),
		name: str(f.name),
		field_type: str(f.field_type),
	};
	if (Array.isArray(f.options)) {
		field.options = f.options.filter((o): o is string => typeof o === 'string');
	}
	return field;
}

/**
 * Raw workflow payload -> strict Workflow. The server may nest statuses under
 * each stage (`stages[].statuses`) or provide a flat top-level `statuses`; we
 * accept both and always emit a flat `statuses` list carrying `stage_id`.
 */
function normalizeWorkflow(raw: unknown): Workflow {
	const w = rec(raw);

	const rawStages = Array.isArray(w.stages) ? w.stages : [];
	const stages = rawStages.map(normalizeStage);

	// Flat statuses if present; otherwise flatten the per-stage nested lists.
	let statuses: WorkflowStatus[];
	if (Array.isArray(w.statuses)) {
		statuses = w.statuses.map(normalizeStatus);
	} else {
		statuses = [];
		for (const rawStage of rawStages) {
			const s = rec(rawStage);
			const nested = Array.isArray(s.statuses) ? s.statuses : [];
			const stageId = str(s.id);
			for (const ns of nested) {
				const status = normalizeStatus(ns);
				if (status.stage_id === '') status.stage_id = stageId;
				statuses.push(status);
			}
		}
	}

	const labels = (Array.isArray(w.labels) ? w.labels : []).map(normalizeLabel);
	const members = (Array.isArray(w.members) ? w.members : []).map(normalizeMember);
	const templates = (Array.isArray(w.templates) ? w.templates : []).map((t) => {
		const tt = rec(t);
		return {
			id: str(tt.id),
			name: str(tt.name),
			fields: (Array.isArray(tt.fields) ? tt.fields : []).map(normalizeField),
		};
	});

	return {
		project: normalizeProject(w.project),
		stages,
		statuses,
		labels,
		members,
		templates,
	};
}

// ============ Workflow helpers ============

/** First status of a stage ordered by `position` (string-sortable). */
function firstStatusOfStage(wf: Workflow, stageId: string): WorkflowStatus | undefined {
	const inStage = wf.statuses.filter((s) => s.stage_id === stageId);
	if (inStage.length === 0) return undefined;
	return [...inStage].sort((a, b) =>
		a.position < b.position ? -1 : a.position > b.position ? 1 : 0
	)[0];
}

// ============ String / matching utilities ============

/** Case-insensitive, trimmed normalization for exact-match comparisons. */
function norm(s: string): string {
	return s.trim().toLowerCase();
}

/** Case-insensitive substring test (the "fuzzy contains" tier). */
function contains(haystack: string, normNeedle: string): boolean {
	if (normNeedle.length === 0) return false;
	return haystack.trim().toLowerCase().includes(normNeedle);
}

function dedupeStrings(xs: string[]): string[] {
	return [...new Set(xs.filter((x) => x.length > 0))];
}

/**
 * Closest-match shortlist for a miss hint (max 8). Ranked by: substring match
 * either direction first, then Levenshtein distance ascending, then alpha.
 */
function shortlist(query: string, candidates: string[]): string[] {
	const q = norm(query);
	const pool = dedupeStrings(candidates);
	if (pool.length === 0) return [];
	const scored = pool.map((c) => {
		const cn = norm(c);
		const sub = cn.includes(q) || (q.length > 0 && q.includes(cn)) ? 0 : 1;
		return { c, sub, dist: levenshtein(q, cn) };
	});
	scored.sort((a, b) => a.sub - b.sub || a.dist - b.dist || a.c.localeCompare(b.c));
	return scored.slice(0, 8).map((s) => s.c);
}

/** Classic iterative Levenshtein (small inputs — workflow vocabularies). */
function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	let curr = new Array<number>(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length]!;
}
