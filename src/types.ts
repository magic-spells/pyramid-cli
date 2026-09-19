// Shared data types for @magic-spells/pyramid (the DATATYPE-* cards).
//
// Pure type declarations — no runtime code and no imports of implementation
// classes live in this file. Every other module imports its shapes from here,
// so these are the canonical interfaces; match them exactly.

export interface PyramidConfig {
	apiKey: string;
	baseUrl: string;
	allowDestructive: boolean;
}

export type McpErrorCode =
	| 'auth_invalid'
	| 'auth_expired'
	| 'project_not_found'
	| 'ambiguous_project_name'
	| 'task_not_found'
	| 'task_archived'
	| 'status_not_found'
	| 'stage_not_found'
	| 'status_not_in_stage'
	| 'user_not_found'
	| 'ambiguous_user_name'
	| 'label_not_found'
	| 'ambiguous_label_name'
	| 'field_not_found'
	| 'invalid_field_value'
	| 'reply_depth_exceeded'
	| 'permission_denied'
	| 'validation_failed'
	| 'rate_limited'
	| 'conflict'
	| 'destructive_action_disabled'
	| 'network'
	| 'unknown';

export interface ProjectSummary {
	id: string;
	slug: string;
	name: string;
	task_prefix: string;
	role: 'admin' | 'pm' | 'member' | 'viewer' | 'guest';
	archived: boolean;
}

export interface WorkflowStage {
	id: string;
	key: string;
	name: string;
	position: string;
	category?: string;
}
export interface WorkflowStatus {
	id: string;
	key: string;
	name: string;
	stage_id: string;
	position: string;
	category?: string;
}
export interface WorkflowMember {
	id: string;
	display_name: string;
	email: string;
	/** Project role (permission): admin | pm | member | viewer | guest. */
	role: string;
	/** The person's own title ("Design Lead") — NOT the permission role. */
	job_title?: string;
}
export interface CustomFieldDef {
	id: string;
	key: string;
	name: string;
	field_type: string;
	options?: string[];
}
export interface Workflow {
	project: ProjectSummary;
	stages: WorkflowStage[];
	statuses: WorkflowStatus[];
	labels: { id: string; name: string; color: string }[];
	members: WorkflowMember[];
	templates: { id: string; name: string; fields: CustomFieldDef[] }[];
}

/**
 * A person as every hydrated surface shows them. `display_name` is always joined
 * (never a bare UUID); the rest arrive from `?expand=owner,reporter` — except
 * `job_title`, which the workflow's member rows also carry, so an Owner can be
 * labelled without paying for expand.
 */
export interface UserStub {
	id: string;
	display_name: string;
	first_name?: string | null;
	last_name?: string | null;
	avatar_url?: string | null;
	job_title?: string | null;
}

export interface TaskSummary {
	id: string;
	key: string;
	title: string;
	description: string | null;
	status: { id: string; name: string };
	stage: { id: string; name: string };
	owner: UserStub | null;
	reporter: UserStub | null;
	labels: string[];
	archived: boolean;
	updated_at: string;
}

export interface TaskReference {
	id: string;
	reference_type:
		| 'github_pr'
		| 'github_commit'
		| 'github_branch'
		| 'github_issue'
		| 'figma'
		| 'url';
	title: string;
	url: string;
	external_status: string | null;
	external_sub_id: string | null;
}

export interface TaskComment {
	id: string;
	task_id: string;
	stage: { id: string; name: string };
	author: UserStub;
	content: string;
	mentions: UserStub[];
	replies: Omit<TaskComment, 'replies'>[];
	created_at: string;
}

export interface TaskDetail extends TaskSummary {
	field_values?: { field: string; value: unknown }[];
	estimates?: { total_hours: number; by_stage: Record<string, number> };
	comments?: TaskComment[];
	references?: TaskReference[];
	followers?: UserStub[];
	dependencies?: { id: string; key: string; type: string }[];
}

/**
 * One hydrated row of a task's history (DATATYPE-TIMELINE-EVENT). The values are
 * deliberately `unknown`: their shape depends on `event_type` (for
 * owner_changed/reporter_changed they are a BARE user uuid or null, not an
 * object), and the server adds event types without a client change.
 */
export interface TimelineEvent {
	id: string;
	task_id: string;
	event_type: string;
	actor: UserStub | null;
	old_value: unknown;
	new_value: unknown;
	data: Record<string, unknown>;
	created_at: string;
}

export interface WhoAmI {
	user: { id: string; display_name: string; email: string };
	workspace: { id: string; slug: string; name: string; role: 'owner' | 'admin' | 'member' };
	projects: ProjectSummary[];
}

export interface Page<T> {
	items: T[];
	next_cursor: string | null;
	has_more: boolean;
}

// ============ Operation inputs (DATATYPE-*-INPUT; mirror the zod schemas) ============
// Human names/keys in; the resolver turns them into UUIDs before they reach the
// client. These are the typed shapes the Phase-2 write/comment operations build.

export interface CustomFieldValue {
	field: string;
	value: unknown;
}

export type TaskPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface CreateTaskInput {
	project: string;
	title: string;
	description?: string;
	stage?: string;
	status?: string;
	owner?: string;
	reporter?: string;
	labels?: string[];
	priority?: TaskPriority;
	due_date?: string;
	estimate_hours?: number;
	guest_visible?: boolean;
	guest_title?: string;
	guest_description?: string;
	custom_fields?: CustomFieldValue[];
}

export interface CreateTasksBulkInput {
	project: string;
	template: string; // resolved to template_id (required by the backend)
	defaults?: { stage?: string; status?: string; labels?: string[] };
	tasks: Omit<CreateTaskInput, 'project'>[];
}

export interface UpdateTaskInput {
	task: string; // "WEB-42" or UUID
	title?: string;
	description?: string | null;
	priority?: TaskPriority;
	due_date?: string | null;
	start_date?: string | null;
	estimate?: number;
	guest_visible?: boolean;
	guest_title?: string;
	guest_description?: string;
	// owner/reporter ride the SAME PATCH as the content fields; null clears.
	owner?: string | null;
	reporter?: string | null;
	// Convenience fields the PATCH does not accept — the op fans them out to the
	// dedicated labels / field-values endpoints.
	add_labels?: string[];
	remove_labels?: string[];
	custom_fields?: CustomFieldValue[];
}

export interface MoveTaskInput {
	task: string;
	status: string; // carries its stage
	after_task?: string;
	before_task?: string;
}

export interface AddCommentInput {
	task: string;
	content: string;
	stage?: string; // default = task's current stage
	mentions?: string[];
}

export interface ReplyCommentInput {
	comment_id: string; // ROOT comment
	content: string;
	mentions?: string[];
}
