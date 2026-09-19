// Unit tests for the operation registry (src/operations/index.ts) — pure, NO
// network. Each op's `run` is exercised with a MOCKED client + resolver (the
// `OpContext` seam), so we assert the operation contract in isolation:
//
//   - it resolves human names/keys to ids via the resolver,
//   - it calls the right client method,
//   - it hydrates ids back into names in the output (names-in / names-out),
//   - destructive ops refuse to act when `config.allowDestructive` is false.
//
// IMPORTANT — scope note (read before extending):
//   The FILE-OPERATIONS target set (task.create / task.move / task.delete /
//   comment.reply, …) is the TARGET surface, but the CURRENT codebase ships only
//   the Phase-1 read-only ops: whoami, list_projects, get_project_workflow,
//   list_my_tasks (see src/operations/index.ts). The client likewise has no
//   createTask / moveTask / deleteTask / replyComment methods yet. So the
//   create/move/delete/reply assertions the test plan calls for are written here
//   as a SELF-CONTAINED, registry-shaped harness against representative
//   `Operation` objects that mirror the spec's `run` contract — they document and
//   pin the contract (resolve -> client call with UUIDs -> hydrate; destructive
//   gate) without importing ops that don't exist. The Phase-1 blocks below run
//   against the REAL registry and are the ones that guard shipped behavior. When
//   the write ops land, move those blocks onto the real `operationsByName` entries.

import { describe, it, expect, vi } from 'vitest';

import { z } from 'zod';

import { McpError } from '../src/errors.js';
import { hydrateTaskDetail, hydrateTaskSummary } from '../src/hydrate.js';
import { operationsByName, type Operation, type OpContext } from '../src/operations/index.js';
import type { PyramidConfig, TaskDetail, Workflow, WhoAmI } from '../src/types.js';

// ============ Shared fixtures ============

const CONFIG_SAFE: PyramidConfig = {
	apiKey: 'pyk_test_secret',
	baseUrl: 'https://pyramid.magicspells.io',
	allowDestructive: false,
};
const CONFIG_DESTRUCTIVE: PyramidConfig = { ...CONFIG_SAFE, allowDestructive: true };

// A workflow rich enough to drive every resolver/hydration join below.
const APOLLO_WORKFLOW: Workflow = {
	project: {
		id: 'p-apollo',
		slug: 'apollo',
		name: 'Apollo',
		task_prefix: 'APO',
		role: 'admin',
		archived: false,
	},
	stages: [
		{ id: 'stg-todo', key: 'todo', name: 'To Do', position: '1' },
		{ id: 'stg-doing', key: 'doing', name: 'In Progress', position: '2' },
	],
	statuses: [
		{ id: 'st-backlog', key: 'backlog', name: 'Backlog', stage_id: 'stg-todo', position: '1' },
		{ id: 'st-ready', key: 'ready', name: 'Ready', stage_id: 'stg-todo', position: '2' },
		{ id: 'st-review', key: 'review', name: 'In Review', stage_id: 'stg-doing', position: '1' },
	],
	labels: [{ id: 'lb-bug', name: 'bug', color: '#f00' }],
	members: [
		{
			id: 'u-ann',
			display_name: 'Ann Smith',
			email: 'ann@example.com',
			role: 'admin',
			// job_title is the person's OWN title, not the permission role.
			job_title: 'Design Lead',
		},
		{ id: 'u-bob', display_name: 'Bob Jones', email: 'bob@example.com', role: 'member' },
	],
	templates: [],
};

/**
 * A mock resolver covering the methods the ops below call. Each method returns
 * the workflow-derived shape the real Resolver would (carrying UUIDs), so the op
 * can hand those UUIDs to the client. Only the surface the tests touch is mocked.
 */
function makeResolver() {
	return {
		resolveProject: vi.fn(async (_name: string) => APOLLO_WORKFLOW.project),
		getWorkflow: vi.fn(async (_projectId: string) => APOLLO_WORKFLOW),
		resolveStatus: vi.fn(async (_pid: string, q: string) => {
			let s = APOLLO_WORKFLOW.statuses.find(
				(x) => x.name.toLowerCase() === q.toLowerCase() || x.key === q
			);
			if (!s) {
				// A stage name where a status is expected -> that stage's first status by
				// position (DOC-NAME-RESOLUTION), mirroring the real resolver (r3).
				const stg = APOLLO_WORKFLOW.stages.find(
					(g) => g.name.toLowerCase() === q.toLowerCase() || g.key === q
				);
				if (stg) {
					s = APOLLO_WORKFLOW.statuses
						.filter((x) => x.stage_id === stg.id)
						.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))[0];
				}
			}
			if (!s) throw new McpError('status_not_found', `No status "${q}".`);
			const stage = APOLLO_WORKFLOW.stages.find((g) => g.id === s.stage_id)!;
			return { ...s, stage_name: stage.name };
		}),
		resolveStage: vi.fn(async (_pid: string, q: string) => {
			const g = APOLLO_WORKFLOW.stages.find(
				(x) => x.name.toLowerCase() === q.toLowerCase() || x.key === q
			);
			if (!g) throw new McpError('stage_not_found', `No stage "${q}".`);
			return g;
		}),
		resolveUser: vi.fn(async (_pid: string, q: string) => {
			const m = APOLLO_WORKFLOW.members.find(
				(x) => x.email === q || x.display_name.toLowerCase() === q.toLowerCase()
			);
			if (!m) throw new McpError('user_not_found', `No user "${q}".`);
			return m;
		}),
		resolveLabel: vi.fn(async (_pid: string, q: string) => {
			const l = APOLLO_WORKFLOW.labels.find((x) => x.name === q);
			if (!l) throw new McpError('label_not_found', `No label "${q}".`);
			return { id: l.id, name: l.name };
		}),
		resolveTask: vi.fn(async (key: string) => ({
			id: `id-of-${key}`,
			projectId: 'p-apollo',
			key,
		})),
		invalidate: vi.fn(),
	};
}

/** Assemble an OpContext from a client mock + a resolver mock + a config. */
function makeCtx(
	client: Record<string, unknown>,
	resolver: ReturnType<typeof makeResolver>,
	config: PyramidConfig = CONFIG_SAFE
): OpContext {
	return {
		config,
		client: client as never,
		resolver: resolver as never,
	};
}

/**
 * The spec-target resolver surface (DOC-NAME-RESOLUTION) adds `resolveTask` on top of
 * the shipped Phase-1 `Resolver`. The current `OpContext.resolver` is typed as
 * the Phase-1 class, which doesn't declare it yet, so the FILE-OPERATIONS contract ops below
 * reach that not-yet-shipped method through this structural view. Drop this once
 * `resolveTask` lands on the real Resolver.
 */
interface ExtendedResolver {
	resolveTask(name: string): Promise<{ id: string; projectId: string; key: string }>;
}
function ext(ctx: OpContext): ExtendedResolver {
	return ctx.resolver as unknown as ExtendedResolver;
}

// ============ Phase-1 ops against the REAL registry ============

describe('operation: list_projects (real registry)', () => {
	it('hydrates raw rows to ProjectSummary with archived derived from archived_at', async () => {
		const op = operationsByName.get('list_projects')!;
		expect(op).toBeDefined();

		const client = {
			listProjects: vi.fn(async () => [
				{ id: 'p1', slug: 'apollo', name: 'Apollo', task_prefix: 'APO', role: 'admin' },
				{
					id: 'p2',
					slug: 'gemini',
					name: 'Gemini',
					task_prefix: 'GEM',
					role: 'member',
					archived_at: '2026-01-01T00:00:00Z',
				},
			]),
		};
		const resolver = makeResolver();
		const out = (await op.run({}, makeCtx(client, resolver))) as Array<{
			id: string;
			archived: boolean;
		}>;

		expect(client.listProjects).toHaveBeenCalledOnce();
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ id: 'p1', archived: false });
		// archived_at present -> archived true (the names-in/derive-out contract).
		expect(out[1]).toMatchObject({ id: 'p2', archived: true });
	});
});

describe('operation: get_project_workflow (real registry)', () => {
	it('resolves the project name to an id, then fetches the workflow by id', async () => {
		const op = operationsByName.get('get_project_workflow')!;
		const client = {}; // the op talks to the resolver only
		const resolver = makeResolver();

		const out = (await op.run({ project: 'apollo' }, makeCtx(client, resolver))) as Workflow;

		// names in: "apollo" -> resolveProject; ids out to getWorkflow.
		expect(resolver.resolveProject).toHaveBeenCalledWith('apollo');
		expect(resolver.getWorkflow).toHaveBeenCalledWith('p-apollo');
		expect(out.project.id).toBe('p-apollo');
		expect(out.statuses).toHaveLength(3);
	});
});

describe('operation: list_my_tasks (real registry)', () => {
	it('hydrates each row against its project workflow and surfaces the cursor', async () => {
		const op = operationsByName.get('list_my_tasks')!;
		const client = {
			// raw rows keyed by UUID; project_id drives per-project workflow hydration.
			listMyTasks: vi.fn(async () => ({
				data: [
					{
						id: 't1',
						key: 'APO-1',
						title: 'Wire auth',
						status_id: 'st-review',
						owner_id: 'u-ann',
						labels: ['lb-bug'],
						project_id: 'p-apollo',
						updated_at: '2026-06-01T00:00:00Z',
					},
				],
				cursor: 'CUR-NEXT',
			})),
		};
		const resolver = makeResolver();

		const page = (await op.run({}, makeCtx(client, resolver))) as {
			items: Array<{
				key: string;
				status: { name: string };
				stage: { name: string };
				owner: { display_name: string } | null;
				labels: string[];
			}>;
			next_cursor: string | null;
			has_more: boolean;
		};

		expect(client.listMyTasks).toHaveBeenCalledOnce();
		// names hydrated alongside UUIDs (status/stage/owner/label all joined).
		expect(page.items[0]).toMatchObject({
			key: 'APO-1',
			status: { name: 'In Review' },
			stage: { name: 'In Progress' }, // derived from the status's stage_id
			owner: { display_name: 'Ann Smith' },
			labels: ['bug'],
		});
		// pagination surfaced, never truncated (DOC-DESIGN-RULES r8).
		expect(page.next_cursor).toBe('CUR-NEXT');
		expect(page.has_more).toBe(true);
	});

	it('caps the page with the requested limit, and never sends a `role` the server ignores', async () => {
		const op = operationsByName.get('list_my_tasks')!;
		const client = {
			listMyTasks: vi.fn(async (q: { role?: string; limit?: number; cursor?: string }) => {
				expect(q.limit).toBe(5);
				// `?role=` is accepted-and-ignored server-side, so we must not send it.
				expect(q).not.toHaveProperty('role');
				return { data: [], cursor: null };
			}),
		};
		const resolver = makeResolver();
		const page = (await op.run({ limit: 5 }, makeCtx(client, resolver))) as {
			next_cursor: string | null;
			has_more: boolean;
		};
		expect(client.listMyTasks).toHaveBeenCalledOnce();
		// null cursor -> last page.
		expect(page.next_cursor).toBeNull();
		expect(page.has_more).toBe(false);
	});

	it('exposes NO `role` input at all (the server ignores the filter)', () => {
		const op = operationsByName.get('list_my_tasks')!;
		expect(Object.keys(op.input.shape)).toEqual(['limit', 'cursor']);
	});
});

describe('operation: whoami (real registry)', () => {
	it('assembles user + pinned org + projects from three client calls', async () => {
		const op = operationsByName.get('whoami')!;
		const client = {
			getMe: vi.fn(async () => ({
				id: 'u-ann',
				display_name: 'Ann Smith',
				email: 'ann@example.com',
			})),
			listProjects: vi.fn(async () => [
				{ id: 'p-apollo', slug: 'apollo', name: 'Apollo', task_prefix: 'APO', role: 'admin' },
			]),
			listOrganizations: vi.fn(async () => [
				{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'owner' },
			]),
		};
		const resolver = makeResolver();

		const out = (await op.run({}, makeCtx(client, resolver))) as WhoAmI;
		expect(out.user).toMatchObject({ id: 'u-ann', email: 'ann@example.com' });
		expect(out.organization).toMatchObject({ id: 'org-1', slug: 'acme', role: 'owner' });
		expect(out.projects).toHaveLength(1);
		expect(out.projects[0]!.slug).toBe('apollo');
	});
});

// ============ FILE-OPERATIONS write/move/delete/reply contract (registry-shaped) ============
//
// These ops are not yet in src/operations/index.ts. The blocks below pin the
// FILE-OPERATIONS contract against representative Operation objects whose `run`
// mirrors the spec exactly (resolve names -> call client with UUIDs -> hydrate).
// They share the SAME OpContext seam, mock client+resolver, and McpError contract
// as the real ops, so when the write ops land these assertions transplant 1:1.

// --- task.create ----------------------------------------------------------
//
// Spec: resolveProject; resolve stage/status/owner/reporter/labels; stage w/o
// status -> first status of the stage by position; inconsistent stage+status ->
// status_not_in_stage; createTask called with resolved UUIDs; output hydrated.

interface CreateTaskInput {
	project: string;
	title: string;
	stage?: string;
	status?: string;
	owner?: string;
	labels?: string[];
}

const taskCreate: Operation<CreateTaskInput, TaskDetail> = {
	name: 'task.create',
	summary: 'Create a task (names in, hydrated detail out).',
	input: z.object({
		project: z.string(),
		title: z.string(),
		stage: z.string().optional(),
		status: z.string().optional(),
		owner: z.string().optional(),
		labels: z.array(z.string()).optional(),
	}) as never,
	async run(input, ctx): Promise<TaskDetail> {
		const project = await ctx.resolver.resolveProject(input.project);
		const wf = await ctx.resolver.getWorkflow(project.id);

		let statusId: string;
		if (input.status) {
			const status = await ctx.resolver.resolveStatus(project.id, input.status);
			// r3: status carries its stage. A stage+status pair that disagrees ->
			// status_not_in_stage, raised BEFORE the client call.
			if (input.stage) {
				const stage = await ctx.resolver.resolveStage(project.id, input.stage);
				if (status.stage_id !== stage.id) {
					throw new McpError(
						'status_not_in_stage',
						`Status "${status.name}" is not in stage "${stage.name}".`
					);
				}
			}
			statusId = status.id;
		} else if (input.stage) {
			// stage without status -> first status of that stage by position.
			const stage = await ctx.resolver.resolveStage(project.id, input.stage);
			const first = [...wf.statuses]
				.filter((s) => s.stage_id === stage.id)
				.sort((a, b) => a.position.localeCompare(b.position))[0]!;
			statusId = first.id;
		} else {
			statusId = wf.statuses[0]!.id;
		}

		const ownerId = input.owner
			? (await ctx.resolver.resolveUser(project.id, input.owner)).id
			: undefined;
		const labelIds: string[] = [];
		for (const l of input.labels ?? []) {
			labelIds.push((await ctx.resolver.resolveLabel(project.id, l)).id);
		}

		// client called with RESOLVED UUIDs (never the human names). Ownership is
		// FLAT: owner -> a top-level owner_id.
		const raw = await (
			ctx.client as never as {
				createTask: (
					projectId: string,
					body: {
						title: string;
						status_id: string;
						owner_id?: string;
						label_ids: string[];
					}
				) => Promise<unknown>;
			}
		).createTask(project.id, {
			title: input.title,
			status_id: statusId,
			...(ownerId ? { owner_id: ownerId } : {}),
			label_ids: labelIds,
		});

		return hydrateTaskDetail(raw, wf);
	},
};

describe('operation contract: task.create', () => {
	it('resolves project/status/owner/labels to UUIDs and calls createTask with a top-level owner_id, then hydrates', async () => {
		const resolver = makeResolver();
		const createTask = vi.fn(async () => ({
			id: 't-new',
			key: 'APO-7',
			title: 'Wire auth',
			status_id: 'st-review',
			owner_id: 'u-ann',
			labels: ['lb-bug'],
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const ctx = makeCtx({ createTask }, resolver);

		const out = await taskCreate.run(
			{
				project: 'apollo',
				title: 'Wire auth',
				status: 'In Review',
				owner: 'ann@example.com',
				labels: ['bug'],
			},
			ctx
		);

		// resolver turned every human token into an id.
		expect(resolver.resolveProject).toHaveBeenCalledWith('apollo');
		expect(resolver.resolveStatus).toHaveBeenCalledWith('p-apollo', 'In Review');
		expect(resolver.resolveUser).toHaveBeenCalledWith('p-apollo', 'ann@example.com');
		expect(resolver.resolveLabel).toHaveBeenCalledWith('p-apollo', 'bug');

		// client got UUIDs in the REAL flat shape: a top-level owner_id.
		expect(createTask).toHaveBeenCalledWith('p-apollo', {
			title: 'Wire auth',
			status_id: 'st-review',
			owner_id: 'u-ann',
			label_ids: ['lb-bug'],
		});

		// result hydrated: ids joined back to names, stage derived from status.
		expect(out).toMatchObject({
			key: 'APO-7',
			status: { id: 'st-review', name: 'In Review' },
			stage: { id: 'stg-doing', name: 'In Progress' },
			owner: { id: 'u-ann', display_name: 'Ann Smith' },
			labels: ['bug'],
		});
	});

	it('stage without status picks the first status of that stage by position', async () => {
		const resolver = makeResolver();
		const createTask = vi.fn(async (_p: string, body: { status_id: string }) => ({
			id: 't-new',
			key: 'APO-8',
			title: 'Triage',
			status_id: body.status_id,
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const ctx = makeCtx({ createTask }, resolver);

		await taskCreate.run({ project: 'apollo', title: 'Triage', stage: 'To Do' }, ctx);

		// "To Do" stage -> first status by position is Backlog (position '1').
		expect(createTask).toHaveBeenCalledWith(
			'p-apollo',
			expect.objectContaining({ status_id: 'st-backlog' })
		);
	});

	it('throws status_not_in_stage for an inconsistent stage+status pair, BEFORE any client call', async () => {
		const resolver = makeResolver();
		const createTask = vi.fn();
		const ctx = makeCtx({ createTask }, resolver);

		await expect(
			// "In Review" lives in stage In Progress, not To Do -> mismatch.
			taskCreate.run({ project: 'apollo', title: 'X', status: 'In Review', stage: 'To Do' }, ctx)
		).rejects.toMatchObject({ code: 'status_not_in_stage' });

		expect(createTask).not.toHaveBeenCalled();
	});
});

// --- task.move ------------------------------------------------------------
//
// Spec: resolveTask; resolveStatus (carries stage); resolveTask for the
// after/before neighbor; moveTask(taskId, { status_id, after_task_id? }).
// after+before together -> validation_failed.

interface MoveTaskInput {
	task: string;
	status: string;
	after_task?: string;
	before_task?: string;
}

const taskMove: Operation<MoveTaskInput, TaskDetail> = {
	name: 'task.move',
	summary: 'Move a task to a target status (and optional neighbor).',
	input: z.object({
		task: z.string(),
		status: z.string(),
		after_task: z.string().optional(),
		before_task: z.string().optional(),
	}) as never,
	async run(input, ctx): Promise<TaskDetail> {
		if (input.after_task && input.before_task) {
			throw new McpError('validation_failed', 'after_task and before_task are mutually exclusive.');
		}
		const task = await ext(ctx).resolveTask(input.task);
		const status = await ctx.resolver.resolveStatus(task.projectId, input.status);
		const wf = await ctx.resolver.getWorkflow(task.projectId);

		// Wire keys are before_id / after_id (DOC-BACKEND-CONTRACT).
		const body: {
			status_id: string;
			after_id?: string;
			before_id?: string;
		} = { status_id: status.id };
		if (input.after_task) {
			body.after_id = (await ext(ctx).resolveTask(input.after_task)).id;
		}
		if (input.before_task) {
			body.before_id = (await ext(ctx).resolveTask(input.before_task)).id;
		}

		// The move response is an envelope { task, previous } — hydrate raw.task.
		const raw = await (
			ctx.client as never as {
				moveTask: (taskId: string, body: unknown) => Promise<{ task: unknown }>;
			}
		).moveTask(task.id, body);
		return hydrateTaskDetail(raw.task, wf);
	},
};

describe('operation contract: task.move', () => {
	it('resolves the task + status (carrying stage) + neighbor and calls moveTask with UUIDs', async () => {
		const resolver = makeResolver();
		const moveTask = vi.fn(async () => ({
			task: {
				id: 'id-of-APO-42',
				key: 'APO-42',
				title: 'Ship it',
				status_id: 'st-review',
				updated_at: '2026-06-16T00:00:00Z',
			},
			previous: { status_id: 'st-backlog', position: '1', completed_at: null },
		}));
		const ctx = makeCtx({ moveTask }, resolver);

		const out = await taskMove.run(
			{ task: 'APO-42', status: 'In Review', after_task: 'APO-10' },
			ctx
		);

		expect(resolver.resolveTask).toHaveBeenCalledWith('APO-42');
		expect(resolver.resolveTask).toHaveBeenCalledWith('APO-10');
		expect(resolver.resolveStatus).toHaveBeenCalledWith('p-apollo', 'In Review');
		expect(moveTask).toHaveBeenCalledWith('id-of-APO-42', {
			status_id: 'st-review',
			after_id: 'id-of-APO-10',
		});
		expect(out).toMatchObject({ status: { name: 'In Review' } });
	});

	it('rejects after_task + before_task together with validation_failed (no client call)', async () => {
		const resolver = makeResolver();
		const moveTask = vi.fn();
		const ctx = makeCtx({ moveTask }, resolver);

		await expect(
			taskMove.run(
				{ task: 'APO-42', status: 'In Review', after_task: 'APO-10', before_task: 'APO-11' },
				ctx
			)
		).rejects.toMatchObject({ code: 'validation_failed' });

		expect(moveTask).not.toHaveBeenCalled();
	});
});

// --- task.delete (destructive gate) --------------------------------------
//
// Spec: resolveTask; if !config.allowDestructive -> throw
// destructive_action_disabled BEFORE any client call; else deleteTask(id, true).

interface DeleteTaskInput {
	task: string;
}

const taskDelete: Operation<DeleteTaskInput, { id: string; key: string; deleted: true }> = {
	name: 'task.delete',
	summary: 'Permanently delete a task (gated behind PYRAMID_ALLOW_DESTRUCTIVE).',
	input: z.object({ task: z.string() }) as never,
	meta: { destructive: true },
	async run(input, ctx) {
		const task = await ext(ctx).resolveTask(input.task);
		if (!ctx.config.allowDestructive) {
			throw new McpError(
				'destructive_action_disabled',
				'Deleting a task is destructive. Set PYRAMID_ALLOW_DESTRUCTIVE=1 to enable it.',
				{ hint: 'Set PYRAMID_ALLOW_DESTRUCTIVE=1.' }
			);
		}
		await (
			ctx.client as never as {
				deleteTask: (taskId: string, hard: boolean) => Promise<void>;
			}
		).deleteTask(task.id, true);
		return { id: task.id, key: task.key, deleted: true as const };
	},
};

describe('operation contract: task.delete (destructive gate)', () => {
	it('throws destructive_action_disabled and never calls the client when allowDestructive is false', async () => {
		const resolver = makeResolver();
		const deleteTask = vi.fn();
		const ctx = makeCtx({ deleteTask }, resolver, CONFIG_SAFE);

		let thrown: unknown;
		try {
			await taskDelete.run({ task: 'APO-42' }, ctx);
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeInstanceOf(McpError);
		expect((thrown as McpError).code).toBe('destructive_action_disabled');
		expect(deleteTask).not.toHaveBeenCalled();
	});

	it('calls deleteTask(id, true) when allowDestructive is true', async () => {
		const resolver = makeResolver();
		const deleteTask = vi.fn(async () => undefined);
		const ctx = makeCtx({ deleteTask }, resolver, CONFIG_DESTRUCTIVE);

		const out = await taskDelete.run({ task: 'APO-42' }, ctx);

		expect(deleteTask).toHaveBeenCalledWith('id-of-APO-42', true);
		expect(out).toEqual({ id: 'id-of-APO-42', key: 'APO-42', deleted: true });
	});
});

// --- comment.reply (one-level depth guard) -------------------------------
//
// Spec: validate the target is a ROOT comment (parent_id == null &&
// thread_root_id == null); replying to a reply -> reply_depth_exceeded BEFORE
// the client call.

interface ReplyCommentInput {
	comment_id: string;
	content: string;
}

/** A tiny fixture comment store the op consults to check reply depth. */
const COMMENTS: Record<string, { parent_id: string | null; thread_root_id: string | null }> = {
	'c-root': { parent_id: null, thread_root_id: null },
	'c-reply': { parent_id: 'c-root', thread_root_id: 'c-root' },
};

const commentReply: Operation<ReplyCommentInput, { id: string }> = {
	name: 'comment.reply',
	summary: 'Reply to a root comment (one level deep).',
	input: z.object({ comment_id: z.string(), content: z.string() }) as never,
	async run(input, ctx) {
		const c = await (
			ctx.client as never as {
				getComment: (
					id: string
				) => Promise<{ parent_id: string | null; thread_root_id: string | null }>;
			}
		).getComment(input.comment_id);
		if (c.parent_id != null || c.thread_root_id != null) {
			throw new McpError(
				'reply_depth_exceeded',
				'Replies are one level deep; reply to the root comment instead.'
			);
		}
		const raw = await (
			ctx.client as never as {
				replyComment: (id: string, body: { content: string }) => Promise<{ id: string }>;
			}
		).replyComment(input.comment_id, { content: input.content });
		return raw;
	},
};

describe('operation contract: comment.reply (one-level depth)', () => {
	it('replying to a reply throws reply_depth_exceeded BEFORE calling replyComment', async () => {
		const resolver = makeResolver();
		const getComment = vi.fn(async (id: string) => COMMENTS[id]!);
		const replyComment = vi.fn();
		const ctx = makeCtx({ getComment, replyComment }, resolver);

		await expect(
			commentReply.run({ comment_id: 'c-reply', content: 'me too' }, ctx)
		).rejects.toMatchObject({ code: 'reply_depth_exceeded' });

		expect(replyComment).not.toHaveBeenCalled();
	});

	it('replying to a root comment calls replyComment', async () => {
		const resolver = makeResolver();
		const getComment = vi.fn(async (id: string) => COMMENTS[id]!);
		const replyComment = vi.fn(async () => ({ id: 'c-new' }));
		const ctx = makeCtx({ getComment, replyComment }, resolver);

		const out = await commentReply.run({ comment_id: 'c-root', content: 'ack' }, ctx);
		expect(replyComment).toHaveBeenCalledWith('c-root', { content: 'ack' });
		expect(out).toEqual({ id: 'c-new' });
	});
});

// ============ Hydration sanity (names-in / names-out invariant) ============

describe('hydrateTaskSummary (invariant: no bare UUID surfaces in a named field)', () => {
	it('joins status/stage/owner/label ids to names via the workflow', () => {
		const summary = hydrateTaskSummary(
			{
				id: 't1',
				key: 'APO-1',
				title: 'x',
				status_id: 'st-review',
				owner_id: 'u-bob',
				labels: ['lb-bug'],
				updated_at: '2026-06-01T00:00:00Z',
			},
			APOLLO_WORKFLOW
		);
		expect(summary.status).toEqual({ id: 'st-review', name: 'In Review' });
		expect(summary.stage).toEqual({ id: 'stg-doing', name: 'In Progress' });
		expect(summary.owner).toEqual({ id: 'u-bob', display_name: 'Bob Jones' });
		expect(summary.labels).toEqual(['bug']);
	});
});

// ============ Phase-2 write surface against the REAL registry ============
//
// The spec-target write ops (task.create / task.move / task.delete /
// comment.reply) have now LANDED in src/operations/index.ts, so these blocks run
// the *shipped* `run` bodies (looked up by name on `operationsByName`) through the
// SAME OpContext seam used above — a fixture workflow + a mock resolver + a mock
// client. They assert the FILE-OPERATIONS contract on the real code:
//   - human names/keys resolve to UUIDs before the client call (names-in),
//   - the right client method is called with those UUIDs (never a fractional
//     position; neighbor tasks are passed by their resolved id),
//   - the result is hydrated back to names (names-out),
//   - the domain guards (status_not_in_stage / reply_depth_exceeded /
//     destructive_action_disabled) fire BEFORE any write.
//
// NOTE — task-ref resolution: unlike the representative harness above (which mocks
// a `resolver.resolveTask`), the shipped ops resolve a "WEB-42" key or UUID via
// the CLIENT (resolveTaskRef -> client.searchTasks for a key, client.getTask for a
// UUID). So the mocks here implement those client methods instead. A search row
// carries `{ id, key, project_id }`; we mint a stable `id-<KEY>` id per key so the
// assertions can name the exact UUID handed to the client.

/** A UUID-shaped string the real `resolveTaskRef` accepts via the UUID branch. */
const TASK_UUID = '11111111-1111-4111-8111-111111111111';

/**
 * A client mock whose task-ref reads (searchTasks for keys, getTask for UUIDs)
 * mirror the rows the real Pyramid server returns. `searchTasks` echoes a single
 * row whose `id` is `id-<KEY>` so a test can assert the exact resolved UUID; the
 * write method under test is injected per case.
 */
function makeRefClient(extra: Record<string, unknown>) {
	return {
		// key -> one matching row (id derived from the key, project_id = apollo).
		searchTasks: vi.fn(async (q: { q: string }) => ({
			data: [{ id: `id-${q.q}`, key: q.q, project_id: 'p-apollo' }],
			cursor: null,
		})),
		// UUID -> a task row carrying its project + key.
		getTask: vi.fn(async (id: string) => ({
			id,
			key: 'APO-1',
			project_id: 'p-apollo',
			status_id: 'st-review',
		})),
		...extra,
	};
}

// --- task.create (real op) ------------------------------------------------

describe('operation: create_task (real registry)', () => {
	it('resolves project/status/owner/labels to UUIDs, calls createTask with the REAL contract, and hydrates', async () => {
		const op = operationsByName.get('create_task')!;
		expect(op).toBeDefined();

		const resolver = makeResolver();
		const createTask = vi.fn(async () => ({
			id: 't-new',
			key: 'APO-7',
			title: 'Wire auth',
			status_id: 'st-review',
			owner_id: 'u-ann',
			labels: ['lb-bug'],
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const ctx = makeCtx({ createTask }, resolver);

		const out = (await op.run(
			{
				project: 'apollo',
				title: 'Wire auth',
				status: 'In Review',
				owner: 'ann@example.com',
				labels: ['bug'],
			},
			ctx
		)) as TaskDetail;

		// names in -> ids: every human token went through the resolver.
		expect(resolver.resolveProject).toHaveBeenCalledWith('apollo');
		expect(resolver.resolveStatus).toHaveBeenCalledWith('p-apollo', 'In Review');
		expect(resolver.resolveUser).toHaveBeenCalledWith('p-apollo', 'ann@example.com');
		expect(resolver.resolveLabel).toHaveBeenCalledWith('p-apollo', 'bug');

		// REAL contract: ownership is FLAT — owner resolves to a top-level owner_id,
		// with no stage anywhere. Labels are label_ids.
		expect(createTask).toHaveBeenCalledWith('p-apollo', {
			title: 'Wire auth',
			status_id: 'st-review',
			owner_id: 'u-ann',
			label_ids: ['lb-bug'],
		});
		const body = createTask.mock.calls[0]![1] as Record<string, unknown>;
		expect(body).not.toHaveProperty('stage_responsibilities');
		expect(body).not.toHaveProperty('custom_fields');

		// ids out -> names: the detail hydrates, deriving stage from the status.
		expect(out).toMatchObject({
			key: 'APO-7',
			status: { id: 'st-review', name: 'In Review' },
			stage: { id: 'stg-doing', name: 'In Progress' },
			owner: { id: 'u-ann', display_name: 'Ann Smith' },
			labels: ['bug'],
		});
	});

	it('maps custom_fields to a field_values MAP keyed by field UUID (not a custom_fields array)', async () => {
		const op = operationsByName.get('create_task')!;
		const resolver = makeResolver();
		// Give the workflow a template with one field so resolveFieldValues can map it.
		resolver.getWorkflow.mockResolvedValue({
			...APOLLO_WORKFLOW,
			templates: [
				{
					id: 'tpl',
					name: 'Default',
					fields: [{ id: 'fld-sev', key: 'severity', name: 'Severity', field_type: 'select' }],
				},
			],
		} as never);
		const createTask = vi.fn(async () => ({
			id: 't',
			key: 'APO-9',
			title: 'X',
			status_id: 'st-review',
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const ctx = makeCtx({ createTask }, resolver);

		await op.run(
			{
				project: 'apollo',
				title: 'X',
				status: 'In Review',
				custom_fields: [{ field: 'severity', value: 'high' }],
			},
			ctx
		);

		const body = createTask.mock.calls[0]![1] as Record<string, unknown>;
		expect(body.field_values).toEqual({ 'fld-sev': 'high' });
		expect(body).not.toHaveProperty('custom_fields');
	});

	it("stage without status picks the stage's first status by position (r3)", async () => {
		const op = operationsByName.get('create_task')!;
		const resolver = makeResolver();
		const createTask = vi.fn(async (_p: string, body: { status_id: string }) => ({
			id: 't',
			key: 'APO-8',
			title: 'Triage',
			status_id: body.status_id,
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const ctx = makeCtx({ createTask }, resolver);

		await op.run({ project: 'apollo', title: 'Triage', stage: 'To Do' }, ctx);

		// "To Do" -> first status by position is Backlog (position '1'); the resolver
		// maps a stage name where a status is expected (r3) to that first status.
		expect(createTask).toHaveBeenCalledWith(
			'p-apollo',
			expect.objectContaining({ status_id: 'st-backlog' })
		);
	});

	it('rejects an inconsistent stage+status pair with status_not_in_stage, BEFORE any client call', async () => {
		const op = operationsByName.get('create_task')!;
		const resolver = makeResolver();
		const createTask = vi.fn();
		const ctx = makeCtx({ createTask }, resolver);

		await expect(
			// "In Review" lives in stage "In Progress", not "To Do" -> mismatch.
			op.run({ project: 'apollo', title: 'X', status: 'In Review', stage: 'To Do' }, ctx)
		).rejects.toMatchObject({ code: 'status_not_in_stage' });

		expect(createTask).not.toHaveBeenCalled();
	});

	it('owner with NO status/stage is just a top-level owner_id (no stage is derived at all)', async () => {
		const op = operationsByName.get('create_task')!;
		const resolver = makeResolver();
		const createTask = vi.fn(async () => ({
			id: 't',
			key: 'APO-9',
			title: 'X',
			status_id: 'st-backlog',
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const ctx = makeCtx({ createTask }, resolver);

		await op.run({ project: 'apollo', title: 'X', owner: 'Bob Jones' }, ctx);

		// No status/stage named -> the backend picks the default status itself, and
		// ownership needs no stage to hang on, so the op resolves NOTHING extra.
		const body = createTask.mock.calls[0]![1] as Record<string, unknown>;
		expect(body.owner_id).toBe('u-bob');
		expect(body).not.toHaveProperty('stage_responsibilities');
		expect(body).not.toHaveProperty('status_id');
	});

	it('forwards priority / due_date / estimate_hours / client_* onto the create body', async () => {
		const op = operationsByName.get('create_task')!;
		const resolver = makeResolver();
		const createTask = vi.fn(async () => ({
			id: 't',
			key: 'APO-9',
			title: 'X',
			status_id: 'st-backlog',
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const ctx = makeCtx({ createTask }, resolver);

		await op.run(
			{
				project: 'apollo',
				title: 'X',
				priority: 'high',
				due_date: '2026-07-01',
				estimate_hours: 4,
				guest_visible: true,
			},
			ctx
		);

		const body = createTask.mock.calls[0]![1] as Record<string, unknown>;
		expect(body).toMatchObject({
			priority: 'high',
			due_date: '2026-07-01',
			estimate: 4, // estimate_hours -> the backend's `estimate`
			guest_visible: true,
		});
	});
});

// --- search_tasks (real op) -----------------------------------------------

describe('operation: search_tasks (real registry)', () => {
	it('searches full-text and hydrates each result against its own project workflow', async () => {
		const op = operationsByName.get('search_tasks')!;
		expect(op).toBeDefined();

		const resolver = makeResolver();
		const searchTasks = vi.fn(async () => ({
			data: [
				{ id: 't1', project_id: 'p-apollo', key: 'APO-1', title: 'Hit', status_id: 'st-review' },
			],
			cursor: null,
		}));
		const out = (await op.run({ query: 'hit' }, makeCtx({ searchTasks }, resolver))) as {
			items: Array<{ key: string }>;
		};

		expect(searchTasks).toHaveBeenCalledWith({ q: 'hit', limit: expect.any(Number) });
		expect(out.items).toHaveLength(1);
		expect(out.items[0]!.key).toBe('APO-1');
	});
});

// --- list_comments (real op) ----------------------------------------------

describe('operation: list_comments (real registry)', () => {
	it('resolves the task ref then lists + hydrates its comments', async () => {
		const op = operationsByName.get('list_comments')!;
		expect(op).toBeDefined();

		const TASK_UUID = '11111111-1111-1111-1111-111111111111';
		const resolver = makeResolver();
		const getTask = vi.fn(async () => ({
			id: TASK_UUID,
			project_id: 'p-apollo',
			key: 'APO-42',
			status_id: 'st-backlog',
		}));
		const listComments = vi.fn(async () => ({
			data: [
				{ id: 'c1', task_id: TASK_UUID, stage_id: 'stg-todo', content: 'hi', author_id: 'u-ann' },
			],
			cursor: null,
		}));
		const out = (await op.run(
			{ task: TASK_UUID },
			makeCtx({ getTask, listComments }, resolver)
		)) as { items: Array<{ id: string }> };

		expect(listComments).toHaveBeenCalled();
		expect(out.items).toHaveLength(1);
	});
});

// --- task.move (real op) --------------------------------------------------

describe('operation: move_task (real registry)', () => {
	// The move response is an ENVELOPE { task, previous }; the op hydrates raw.task.
	const moveEnvelope = {
		task: {
			id: 'id-APO-42',
			key: 'APO-42',
			title: 'Ship it',
			status_id: 'st-review',
			updated_at: '2026-06-16T00:00:00Z',
		},
		previous: { status_id: 'st-backlog', position: '1', completed_at: null },
	};

	it('passes the after_task NEIGHBOR via after_id and hydrates raw.task from the envelope', async () => {
		const op = operationsByName.get('move_task')!;
		expect(op).toBeDefined();

		const resolver = makeResolver();
		const moveTask = vi.fn(async () => moveEnvelope);
		const client = makeRefClient({ moveTask });
		const ctx = makeCtx(client, resolver);

		const out = (await op.run(
			{ task: 'APO-42', status: 'In Review', after_task: 'APO-10' },
			ctx
		)) as TaskDetail;

		// both the task and its neighbor were resolved via the client (key -> id).
		expect(client.searchTasks).toHaveBeenCalledWith(expect.objectContaining({ q: 'APO-42' }));
		expect(client.searchTasks).toHaveBeenCalledWith(expect.objectContaining({ q: 'APO-10' }));
		expect(resolver.resolveStatus).toHaveBeenCalledWith('p-apollo', 'In Review');

		// REAL contract: the body key is after_id (NOT after_task_id), never a
		// position key — positions are server-generated (DOC-DESIGN-RULES r6).
		expect(moveTask).toHaveBeenCalledWith('id-APO-42', {
			status_id: 'st-review',
			after_id: 'id-APO-10',
		});
		const body = moveTask.mock.calls[0]![1] as Record<string, unknown>;
		expect(body).not.toHaveProperty('position');
		expect(body).not.toHaveProperty('after_task_id');

		// hydrated from raw.task (the envelope's task), NOT the whole envelope.
		expect(out).toMatchObject({ key: 'APO-42', status: { name: 'In Review' } });
		expect(out).not.toHaveProperty('previous');
	});

	it('passes the before_task neighbor via before_id', async () => {
		const op = operationsByName.get('move_task')!;
		const resolver = makeResolver();
		const moveTask = vi.fn(async () => moveEnvelope);
		const client = makeRefClient({ moveTask });
		const ctx = makeCtx(client, resolver);

		await op.run({ task: 'APO-42', status: 'In Review', before_task: 'APO-11' }, ctx);

		expect(moveTask).toHaveBeenCalledWith('id-APO-42', {
			status_id: 'st-review',
			before_id: 'id-APO-11',
		});
	});

	it('rejects after_task + before_task together with validation_failed, before any resolve/move', async () => {
		const op = operationsByName.get('move_task')!;
		const resolver = makeResolver();
		const moveTask = vi.fn();
		const client = makeRefClient({ moveTask });
		const ctx = makeCtx(client, resolver);

		await expect(
			op.run(
				{
					task: 'APO-42',
					status: 'In Review',
					after_task: 'APO-10',
					before_task: 'APO-11',
				},
				ctx
			)
		).rejects.toMatchObject({ code: 'validation_failed' });

		// the guard fires first — no task-ref resolution, no move.
		expect(client.searchTasks).not.toHaveBeenCalled();
		expect(moveTask).not.toHaveBeenCalled();
	});

	it('a status that is not in the named stage yields status_not_in_stage on create (stage+status guard)', async () => {
		// The stage+status mismatch guard is shared (resolveStatusWithStage);
		// move_task takes a status alone (it carries its own stage), so the mismatch
		// surfaces on the stage+status surface — create_task — as status_not_in_stage.
		const op = operationsByName.get('create_task')!;
		const resolver = makeResolver();
		const createTask = vi.fn();
		const ctx = makeCtx({ createTask }, resolver);

		await expect(
			op.run({ project: 'apollo', title: 'X', status: 'In Review', stage: 'To Do' }, ctx)
		).rejects.toMatchObject({ code: 'status_not_in_stage' });
		expect(createTask).not.toHaveBeenCalled();
	});
});

// --- comment.reply (real op, one-level depth guard) -----------------------

describe('operation: reply_to_comment (real registry)', () => {
	it('replying to a reply throws reply_depth_exceeded BEFORE calling replyComment', async () => {
		const op = operationsByName.get('reply_to_comment')!;
		expect(op).toBeDefined();

		const resolver = makeResolver();
		// The target is itself a reply: a non-null parent_id (and a thread_root_id
		// pointing at a DIFFERENT comment) -> it is one level deep already.
		const getComment = vi.fn(async () => ({
			id: 'c-reply',
			task_id: TASK_UUID,
			parent_id: 'c-root',
			thread_root_id: 'c-root',
			author_id: 'u-ann',
			content: 'first reply',
		}));
		const replyComment = vi.fn();
		const ctx = makeCtx({ getComment, replyComment }, resolver);

		await expect(op.run({ comment_id: 'c-reply', content: 'me too' }, ctx)).rejects.toMatchObject({
			code: 'reply_depth_exceeded',
		});

		// validated before the call — no write attempted (r5).
		expect(replyComment).not.toHaveBeenCalled();
	});

	it('replying to a ROOT comment resolves its task project and calls replyComment, then hydrates', async () => {
		const op = operationsByName.get('reply_to_comment')!;
		const resolver = makeResolver();
		// A root comment: no parent, thread_root_id === its own id.
		const getComment = vi.fn(async () => ({
			id: 'c-root',
			task_id: TASK_UUID,
			parent_id: null,
			thread_root_id: 'c-root',
			author_id: 'u-ann',
			content: 'root',
		}));
		const replyComment = vi.fn(async () => ({
			id: 'c-new',
			task_id: TASK_UUID,
			stage_id: 'stg-doing',
			author_id: 'u-ann',
			content: 'ack',
			created_at: '2026-06-16T00:00:00Z',
		}));
		const client = makeRefClient({ getComment, replyComment });
		const ctx = makeCtx(client, resolver);

		const out = (await op.run({ comment_id: 'c-root', content: 'ack' }, ctx)) as {
			id: string;
			author: { display_name: string };
			stage: { name: string };
		};

		expect(replyComment).toHaveBeenCalledWith('c-root', { content: 'ack' });
		expect(out.id).toBe('c-new');
		// hydrated: author id + stage id joined to names via the workflow.
		// a comment author is a person too — same stub, job_title included.
		expect(out.author).toEqual({
			id: 'u-ann',
			display_name: 'Ann Smith',
			job_title: 'Design Lead',
		});
		expect(out.stage).toEqual({ id: 'stg-doing', name: 'In Progress' });
	});
});

// --- task.delete (real op, destructive gate) ------------------------------

describe('operation: delete_task (real registry)', () => {
	it('throws destructive_action_disabled and never touches the client when allowDestructive is false', async () => {
		const op = operationsByName.get('delete_task')!;
		expect(op).toBeDefined();
		expect(op.meta?.destructive).toBe(true);

		const resolver = makeResolver();
		const deleteTask = vi.fn();
		const client = makeRefClient({ deleteTask });
		const ctx = makeCtx(client, resolver, CONFIG_SAFE);

		let thrown: unknown;
		try {
			await op.run({ task: 'APO-42' }, ctx);
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeInstanceOf(McpError);
		expect((thrown as McpError).code).toBe('destructive_action_disabled');
		// the gate fires before resolution — neither the ref lookup nor delete ran.
		expect(client.searchTasks).not.toHaveBeenCalled();
		expect(deleteTask).not.toHaveBeenCalled();
	});

	it('resolves the key and calls deleteTask(id, true) when allowDestructive is true', async () => {
		const op = operationsByName.get('delete_task')!;
		const resolver = makeResolver();
		const deleteTask = vi.fn(async () => undefined);
		const client = makeRefClient({ deleteTask });
		const ctx = makeCtx(client, resolver, CONFIG_DESTRUCTIVE);

		const out = (await op.run({ task: 'APO-42' }, ctx)) as {
			id: string;
			key: string;
			deleted: true;
		};

		// key -> id via the client, then a HARD delete (hard = true).
		expect(client.searchTasks).toHaveBeenCalledWith(expect.objectContaining({ q: 'APO-42' }));
		expect(deleteTask).toHaveBeenCalledWith('id-APO-42', true);
		expect(out).toEqual({ id: 'id-APO-42', key: 'APO-42', deleted: true });
	});
});

// --- update_task (real op, PATCH + label/field fan-out) --------------------
//
// REAL contract: the PATCH body carries the content fields AND owner_id/
// reporter_id (an explicit null clears one). Only labels and field_values still
// FAN OUT to their dedicated endpoints. The op re-fetches + hydrates the task at
// the end. (The If-Match read-first flow lives inside the client's updateTask/
// deleteTask and is tested at the client level.)

describe('operation: update_task (real registry)', () => {
	it('sends owner/reporter ON the PATCH and fans only labels/fields out to dedicated endpoints', async () => {
		const op = operationsByName.get('update_task')!;
		expect(op).toBeDefined();

		const resolver = makeResolver();
		// Workflow with a custom-field so field_values can resolve.
		resolver.getWorkflow.mockResolvedValue({
			...APOLLO_WORKFLOW,
			templates: [
				{
					id: 'tpl',
					name: 'Default',
					fields: [{ id: 'fld-sev', key: 'severity', name: 'Severity', field_type: 'select' }],
				},
			],
		} as never);

		const updateTask = vi.fn(async () => ({ id: TASK_UUID }));
		const addTaskLabel = vi.fn(async () => ({}));
		const removeTaskLabel = vi.fn(async () => undefined);
		const setFieldValues = vi.fn(async () => ({}));
		// getTask: the ref lookup (UUID branch) + the final re-fetch both call it.
		const getTask = vi.fn(async (id: string) => ({
			id,
			key: 'APO-1',
			project_id: 'p-apollo',
			status_id: 'st-review',
			title: 'Renamed',
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const client = {
			getTask,
			updateTask,
			addTaskLabel,
			removeTaskLabel,
			setFieldValues,
		};
		const ctx = makeCtx(client, resolver);

		const out = (await op.run(
			{
				task: TASK_UUID,
				title: 'Renamed',
				priority: 'high',
				owner: 'ann@example.com',
				add_labels: ['bug'],
				custom_fields: [{ field: 'severity', value: 'high' }],
			},
			ctx
		)) as TaskDetail;

		// 1) ONE patch carries the content keys AND the resolved owner_id — no
		// separate ownership write, so it is covered by the same If-Match.
		expect(updateTask).toHaveBeenCalledWith(TASK_UUID, {
			title: 'Renamed',
			priority: 'high',
			owner_id: 'u-ann',
		});
		const patch = updateTask.mock.calls[0]![1] as Record<string, unknown>;
		expect(patch).not.toHaveProperty('add_label_ids');
		expect(patch).not.toHaveProperty('field_values');
		expect(patch).not.toHaveProperty('stage_id');

		// 2) labels -> POST /labels per resolved id.
		expect(addTaskLabel).toHaveBeenCalledWith(TASK_UUID, 'lb-bug');
		// custom_fields -> PATCH /field-values keyed by field UUID.
		expect(setFieldValues).toHaveBeenCalledWith(TASK_UUID, {
			field_values: { 'fld-sev': 'high' },
		});

		// 3) the op re-fetched + hydrated the final task.
		expect(out).toMatchObject({ key: 'APO-1', title: 'Renamed' });
	});

	it('surfaces WHICH sub-update failed (add_label) with its code', async () => {
		const op = operationsByName.get('update_task')!;
		const resolver = makeResolver();
		const getTask = vi.fn(async (id: string) => ({
			id,
			key: 'APO-1',
			project_id: 'p-apollo',
			status_id: 'st-review',
		}));
		const addTaskLabel = vi.fn(async () => {
			throw new McpError('permission_denied', 'nope');
		});
		const client = { getTask, addTaskLabel };
		const ctx = makeCtx(client, resolver);

		const err = await op
			.run({ task: TASK_UUID, add_labels: ['bug'] }, ctx)
			.then(() => undefined)
			.catch((e) => e as McpError);
		expect(err).toBeInstanceOf(McpError);
		expect(err.code).toBe('permission_denied');
		expect(err.message).toMatch(/add_label/);
	});

	it('clears an owner with an explicit null (the null must SURVIVE onto the patch)', async () => {
		const op = operationsByName.get('update_task')!;
		const resolver = makeResolver();
		const updateTask = vi.fn(async () => ({ id: TASK_UUID }));
		const getTask = vi.fn(async (id: string) => ({
			id,
			key: 'APO-1',
			project_id: 'p-apollo',
			status_id: 'st-review',
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const ctx = makeCtx({ getTask, updateTask }, resolver);

		await op.run({ task: TASK_UUID, owner: null, reporter: 'Bob Jones' }, ctx);

		// null clears; it must not be dropped as "unset", and must not be resolved.
		expect(updateTask).toHaveBeenCalledWith(TASK_UUID, {
			owner_id: null,
			reporter_id: 'u-bob',
		});
		expect(resolver.resolveUser).toHaveBeenCalledTimes(1);
	});
});

// --- create_tasks_bulk (real op) ------------------------------------------

describe('operation: create_tasks_bulk (real registry)', () => {
	it('resolves the template, sends top-level project_id + template_id, and hydrates `created`', async () => {
		const op = operationsByName.get('create_tasks_bulk')!;
		expect(op).toBeDefined();

		const resolver = makeResolver();
		resolver.getWorkflow.mockResolvedValue({
			...APOLLO_WORKFLOW,
			templates: [{ id: 'tpl-default', name: 'Default', fields: [] }],
		} as never);

		const bulkCreate = vi.fn(async () => ({
			created: [
				{
					id: 't1',
					key: 'APO-10',
					title: 'One',
					status_id: 'st-review',
					updated_at: '2026-06-16T00:00:00Z',
				},
			],
			errors: [],
		}));
		const ctx = makeCtx({ bulkCreate }, resolver);

		const out = (await op.run(
			{
				project: 'apollo',
				template: 'Default',
				tasks: [{ title: 'One', status: 'In Review', owner: 'ann@example.com' }],
			},
			ctx
		)) as TaskDetail[];

		const body = bulkCreate.mock.calls[0]![0] as {
			project_id: string;
			template_id: string;
			tasks: Record<string, unknown>[];
		};
		// TOP-LEVEL project_id + template_id (resolved from the template name).
		expect(body.project_id).toBe('p-apollo');
		expect(body.template_id).toBe('tpl-default');
		// per-row: a flat owner_id (+ label_ids / field_values where given).
		expect(body.tasks[0]).toMatchObject({
			title: 'One',
			status_id: 'st-review',
			owner_id: 'u-ann',
		});
		expect(body.tasks[0]).not.toHaveProperty('stage_responsibilities');
		// hydrated from `created`.
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ key: 'APO-10', status: { name: 'In Review' } });
	});

	it('requires a template — a missing one is a clear validation_failed (no write)', async () => {
		const op = operationsByName.get('create_tasks_bulk')!;
		const resolver = makeResolver();
		const bulkCreate = vi.fn();
		const ctx = makeCtx({ bulkCreate }, resolver);

		await expect(
			op.run({ project: 'apollo', tasks: [{ title: 'One' }] }, ctx)
		).rejects.toMatchObject({ code: 'validation_failed' });
		expect(bulkCreate).not.toHaveBeenCalled();
	});
});

// --- create_task: custom-field validation (r7) + flat ownership --------------

describe('create_task: field validation + ownership', () => {
	it('rejects a value whose type mismatches the field_type (r7) before any client call', async () => {
		const op = operationsByName.get('create_task')!;
		const resolver = makeResolver();
		resolver.getWorkflow.mockResolvedValue({
			...APOLLO_WORKFLOW,
			templates: [
				{
					id: 'tpl',
					name: 'Default',
					fields: [{ id: 'fld-pts', key: 'points', name: 'Points', field_type: 'number' }],
				},
			],
		} as never);
		const createTask = vi.fn();
		const ctx = makeCtx({ createTask }, resolver);

		await expect(
			op.run(
				{
					project: 'apollo',
					title: 'X',
					status: 'In Review',
					custom_fields: [{ field: 'points', value: 'three' }],
				},
				ctx
			)
		).rejects.toMatchObject({ code: 'invalid_field_value' });
		expect(createTask).not.toHaveBeenCalled();
	});

	it('resolves owner AND reporter to top-level ids; rejects the removed assignments[] input', async () => {
		const op = operationsByName.get('create_task')!;
		const resolver = makeResolver();
		const createTask = vi.fn(async () => ({
			id: 't',
			key: 'APO-9',
			title: 'X',
			status_id: 'st-review',
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const ctx = makeCtx({ createTask }, resolver);

		await op.run(
			{
				project: 'apollo',
				title: 'X',
				status: 'In Review',
				owner: 'Ann Smith',
				reporter: 'Bob Jones',
			},
			ctx
		);

		const body = createTask.mock.calls[0]![1] as Record<string, unknown>;
		expect(body.owner_id).toBe('u-ann');
		expect(body.reporter_id).toBe('u-bob');
		expect(body).not.toHaveProperty('stage_responsibilities');

		// `assignments` is gone from the schema, not silently ignored.
		expect(op.input.shape).not.toHaveProperty('assignments');
	});
});

// --- list_tasks: Owner / Reporter filters (never "assignee") ----------------

describe('list_tasks: owner/reporter filters', () => {
	it('resolves --owner and --reporter to owner_id/reporter_id, and has no assignee input', async () => {
		const op = operationsByName.get('list_tasks')!;
		const resolver = makeResolver();
		const listTasks = vi.fn(async () => ({ data: [], cursor: null }));
		const ctx = makeCtx({ listTasks }, resolver);

		await op.run({ project: 'apollo', owner: 'ann@example.com', reporter: 'Bob Jones' }, ctx);

		expect(listTasks.mock.calls[0]![1]).toMatchObject({
			owner_id: 'u-ann',
			reporter_id: 'u-bob',
		});
		// the product says Owner and Reporter; "assignee" is gone from the surface.
		expect(op.input.shape).not.toHaveProperty('assignee');
		expect(op.input.shape).toHaveProperty('owner');
		expect(op.input.shape).toHaveProperty('reporter');
	});

	it('labels a hydrated owner with the job_title the workflow already knows', async () => {
		const op = operationsByName.get('get_task')!;
		const resolver = makeResolver();
		// A LEAN row (no ?expand): only owner_id. The job_title still lands, because
		// the cached workflow's member rows carry it.
		const getTask = vi.fn(async () => ({
			id: 't1',
			key: 'APO-1',
			project_id: 'p-apollo',
			status_id: 'st-review',
			owner_id: 'u-ann',
			reporter_id: 'u-bob',
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const out = (await op.run(
			{ task: '33333333-3333-3333-3333-333333333333' },
			makeCtx({ getTask }, resolver)
		)) as TaskDetail;

		expect(out.owner).toMatchObject({ display_name: 'Ann Smith', job_title: 'Design Lead' });
		// no title known -> the key is simply absent, not an empty string.
		expect(out.reporter).toMatchObject({ display_name: 'Bob Jones' });
		expect(out.reporter).not.toHaveProperty('job_title');
	});

	it('keeps the expanded stub profile fields when the server sends them', async () => {
		const op = operationsByName.get('get_task')!;
		const resolver = makeResolver();
		const getTask = vi.fn(async () => ({
			id: 't1',
			key: 'APO-1',
			project_id: 'p-apollo',
			status_id: 'st-review',
			owner: {
				id: 'u-ann',
				display_name: 'Ann Smith',
				first_name: 'Ann',
				last_name: 'Smith',
				avatar_url: 'https://example.test/a.png',
				job_title: 'Staff Designer',
			},
			updated_at: '2026-06-16T00:00:00Z',
		}));
		const out = (await op.run(
			{ task: '33333333-3333-3333-3333-333333333333', expand: true },
			makeCtx({ getTask }, resolver)
		)) as TaskDetail;

		// the ref lookup reads the task lean; the expand ride-along is the 2nd call.
		expect(getTask).toHaveBeenLastCalledWith('t1', 'owner,reporter,labels');
		// the expanded row wins over the workflow's copy.
		expect(out.owner).toMatchObject({
			first_name: 'Ann',
			last_name: 'Smith',
			avatar_url: 'https://example.test/a.png',
			job_title: 'Staff Designer',
		});
	});
});

// --- get_task_timeline (real op) -------------------------------------------

describe('operation: get_task_timeline (real registry)', () => {
	const TASK_UUID = '22222222-2222-2222-2222-222222222222';
	const taskRow = { id: TASK_UUID, project_id: 'p-apollo', key: 'APO-1', status_id: 'st-review' };

	it('resolves the task ref, passes limit/cursor/event_type, and hydrates the actor', async () => {
		const op = operationsByName.get('get_task_timeline')!;
		expect(op).toBeDefined();

		const resolver = makeResolver();
		const getTask = vi.fn(async () => taskRow);
		const getTaskTimeline = vi.fn(async () => ({
			data: [
				{
					id: 'ev-1',
					task_id: TASK_UUID,
					event_type: 'owner_changed',
					actor_id: 'u-ann',
					old_value: null,
					new_value: 'u-bob',
					data: { task_id: TASK_UUID },
					created_at: '2026-06-16T00:00:00Z',
				},
			],
			cursor: 'CUR-2',
		}));
		const ctx = makeCtx({ getTask, getTaskTimeline }, resolver);

		const page = (await op.run(
			{ task: TASK_UUID, event_type: 'owner_changed', limit: 10 },
			ctx
		)) as { items: Record<string, unknown>[]; next_cursor: string | null; has_more: boolean };

		expect(getTaskTimeline).toHaveBeenCalledWith(TASK_UUID, {
			limit: 10,
			cursor: undefined,
			event_type: 'owner_changed',
		});

		// the actor is joined to a name, and so are the values of the event types whose
		// shape we KNOW is a bare user uuid (owner_changed / reporter_changed) — a raw
		// uuid in a history line is unreadable. null stays null.
		expect(page.items[0]).toMatchObject({
			id: 'ev-1',
			event_type: 'owner_changed',
			actor: { id: 'u-ann', display_name: 'Ann Smith' },
			old_value: null,
			new_value: { id: 'u-bob', display_name: 'Bob Jones' },
		});

		// pagination surfaced, never truncated (r8).
		expect(page.next_cursor).toBe('CUR-2');
		expect(page.has_more).toBe(true);
	});

	it('defaults the limit to 50 and tolerates a system event with no actor', async () => {
		const op = operationsByName.get('get_task_timeline')!;
		const resolver = makeResolver();
		const getTask = vi.fn(async () => taskRow);
		const getTaskTimeline = vi.fn(async () => ({
			data: [{ id: 'ev-2', event_type: 'created', data: { task_id: TASK_UUID } }],
			cursor: null,
		}));
		const page = (await op.run(
			{ task: TASK_UUID },
			makeCtx({ getTask, getTaskTimeline }, resolver)
		)) as { items: Record<string, unknown>[]; has_more: boolean };

		expect(getTaskTimeline.mock.calls[0]![1]).toMatchObject({ limit: 50 });
		expect(page.items[0]).toMatchObject({ id: 'ev-2', actor: null, task_id: TASK_UUID });
		expect(page.has_more).toBe(false);
	});

	it('is a read: it carries no destructive flag', () => {
		const op = operationsByName.get('get_task_timeline')!;
		expect(op.meta?.destructive).toBeFalsy();
		expect(op.meta?.cli).toMatchObject({ group: 'task', verb: 'timeline' });
	});

	it('leaves an unknown event kind, and an unknown user, exactly as the server sent it', async () => {
		const op = operationsByName.get('get_task_timeline')!;
		const getTask = vi.fn(async () => taskRow);
		const getTaskTimeline = vi.fn(async () => ({
			data: [
				// A kind this client has never heard of: the values are NOT ours to
				// interpret, and it must not crash.
				{
					id: 'ev-3',
					event_type: 'sprint_rolled_over',
					old_value: { sprint: 7 },
					new_value: [1, 2, 3],
					data: { task_id: TASK_UUID },
				},
				// A known kind, but a user the cached workflow has never seen: the raw
				// uuid survives rather than collapsing to a blank name.
				{
					id: 'ev-4',
					event_type: 'reporter_changed',
					old_value: 'u-stranger',
					new_value: null,
					data: { task_id: TASK_UUID },
				},
			],
			cursor: null,
		}));
		const page = (await op.run(
			{ task: TASK_UUID },
			makeCtx({ getTask, getTaskTimeline }, makeResolver())
		)) as { items: Record<string, unknown>[] };

		expect(page.items[0]).toMatchObject({
			event_type: 'sprint_rolled_over',
			old_value: { sprint: 7 },
			new_value: [1, 2, 3],
		});
		expect(page.items[1]).toMatchObject({ old_value: 'u-stranger', new_value: null });
	});
});

// --- list_comments: stage scoping (default current, "all") -------------------

describe('list_comments: stage scoping', () => {
	const TASK_UUID = '22222222-2222-2222-2222-222222222222';
	const taskRow = { id: TASK_UUID, project_id: 'p-apollo', key: 'APO-1', status_id: 'st-review' };

	it("defaults to the task's CURRENT stage (r4)", async () => {
		const op = operationsByName.get('list_comments')!;
		const resolver = makeResolver();
		const getTask = vi.fn(async () => taskRow);
		const listComments = vi.fn(async () => ({ data: [], cursor: null }));
		await op.run({ task: TASK_UUID }, makeCtx({ getTask, listComments }, resolver));
		// st-review lives in stg-doing -> default stage_id = stg-doing.
		expect(listComments.mock.calls[0]![1].stage_id).toBe('stg-doing');
	});

	it('lists ALL stages when stage: "all"', async () => {
		const op = operationsByName.get('list_comments')!;
		const resolver = makeResolver();
		const getTask = vi.fn(async () => taskRow);
		const listComments = vi.fn(async () => ({ data: [], cursor: null }));
		await op.run({ task: TASK_UUID, stage: 'all' }, makeCtx({ getTask, listComments }, resolver));
		expect(listComments.mock.calls[0]![1].stage_id).toBeUndefined();
	});
});
