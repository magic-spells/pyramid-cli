---
name: Real pyramid-server HTTP contract (audited)
kind: reference
status: built
connections:
  - EXTERNAL-PYRAMID-API
  - DOC-ERROR-MODEL
  - DOC-CONCURRENCY
  - DATATYPE-WORKFLOW
  - DOC-NAME-RESOLUTION
notes:
  - kind: decision
    text: >-
      2026-09-18 — Per-stage ownership is gone. pyramid-server PR #24 removed `GET/PATCH
      /tasks/{id}/stage-responsibilities` and `stage_responsibilities` from task create/bulk and the
      task bundle, replacing them with top-level nullable `owner_id`/`reporter_id` on create, bulk
      and PATCH. It also shipped `GET /tasks/{id}/timeline` and `job_title` on workspace-member
      rows, and made `/me/tasks?role=` accepted-and-ignored. This card was rewritten against that
      contract; the CLI/MCP followed in feat/drop-stage-responsibilities. Rejected: a compatibility
      shim that kept fanning owner/reporter out to the old route — the route no longer exists, so
      the shim would only 404.
---

# Real pyramid-server HTTP contract (audited)

Ground truth read directly from the Go source (`../pyramid-server`, `app/internal/{router,handlers,service,model}`), not inferred from the plan. This supersedes earlier
guesses where they differ. All routes are under `/v1`, bearer `pyk_…`, key pinned to one
organization (`X-Organization-*` ignored for keys).

## Endpoints the MCP uses

| Op | Method · path | Notes |
|---|---|---|
| getMe | `GET /v1/me` | bare `User`; no embedded organization |
| listOrganizations | `GET /v1/organizations` | `{data:[Organization]}`, **no cursor**; effectively one entry (the key's pinned org) |
| listProjects | `GET /v1/projects` | `{data:[Project], cursor}`; cursor = next project UUID or null |
| getWorkflow | `GET /v1/projects/{projectId}/workflow` | **only** `{stages:[{…Stage, statuses:[Status]}]}` |
| listLabels | `GET /v1/projects/{projectId}/labels` | separate — not in /workflow |
| listMembers | `GET /v1/projects/{projectId}/members` | separate; `ProjectMember.user` carries name/email; the membership row carries `job_title` |
| getTaskSchema | `GET /v1/projects/{projectId}/task-schema` | `{templates:[…], fields_by_template:{tplId:[CustomField]}}` |
| listTasks | `GET /v1/projects/{projectId}/tasks` | `{data:[Task], cursor}`; query `status`(UUID, **not** status_id), `stage_id`, `owner_id`, `reporter_id`, `label_id`, `q`, `limit`(≤100), `cursor`, `expand` |
| listArchived | `GET /v1/projects/{projectId}/tasks/archived` | **separate route**; query `archived_after`, `limit`, `cursor` |
| getTask | `GET /v1/tasks/{taskId}` | `Task` (or `TaskWithRelations` w/ `?expand=owner,reporter,labels`); **sets `ETag` header** |
| getTaskTimeline | `GET /v1/tasks/{taskId}/timeline` | `{data:[TaskTimelineEvent], cursor}`, **oldest-first**; query `limit` (50 default, 200 max), `cursor`, `event_type` |
| listMyTasks | `GET /v1/me/tasks` | `{data:[Task], cursor}`; `?role=` is **accepted and ignored** — never send it |
| searchTasks | `GET /v1/search/tasks` | `{data:[Task+rank]}`, **no cursor**; query `q`, `limit`, `owner_id`, `reporter_id` |
| createTask | `POST /v1/projects/{projectId}/tasks` | 201 `Task`; **no If-Match** |
| bulkCreate | `POST /v1/tasks/bulk` | 201 `{created:[Task], errors:[]}`; **no If-Match**; cap 100 |
| updateTask | `PATCH /v1/tasks/{taskId}` | 200 `Task`; **If-Match REQUIRED**; accepts `owner_id`/`reporter_id` |
| moveTask | `PATCH /v1/tasks/{taskId}/move` | 200 **`{task, previous}`**; **no If-Match** |
| archiveTask | `POST /v1/tasks/{taskId}/archive` | 200 `Task`; needs role ≥ PM; no If-Match |
| unarchiveTask | `POST /v1/tasks/{taskId}/unarchive` | 200 `Task` |
| deleteTask | `DELETE /v1/tasks/{taskId}?hard=true` | 204; **If-Match REQUIRED**; soft=Member, hard=Admin |
| addLabel/removeLabel | `POST` / `DELETE /v1/tasks/{taskId}/labels[/{labelId}]` | label mutation on existing tasks |
| setFieldValues | `PATCH /v1/tasks/{taskId}/field-values` (bulk) · `…/custom-fields/{fieldId}` | custom-field mutation on existing tasks |
| listComments | `GET /v1/tasks/{taskId}/comments` | `{data:[Comment], cursor}`; query `stage_id`, `limit`, `cursor` |
| addComment | `POST /v1/tasks/{taskId}/comments` | 201 `Comment` |
| replyComment | `POST /v1/comments/{commentId}/replies` | 201 `Comment` |

`GET/PATCH /v1/tasks/{id}/stage-responsibilities` **no longer exists** — it was removed
server-side together with the per-stage ownership model (see below).

## Tenancy keys on the wire

The tenant noun is **organization** everywhere (renamed 2026-09-18):
`/v1/workspaces…` → `/v1/organizations…`; JSON keys `workspace_id` →
`organization_id`, `workspace_members` → `organization_members`,
`workspace_role` → `organization_role`; header `X-Workspace-Slug` →
`X-Organization-Slug` (this client never sends it — the key is org-pinned
server-side); error code `workspace_not_found` → `organization_not_found`.
`is_personal`, `personal_owner_id` and the role values `owner`/`admin`/`member`
are unchanged. In this package the only wire change is the path, because it
reads no `workspace_*` JSON keys and sends no tenancy header.

## Write bodies (exact json fields)

- **createTask** `{ title*, description?, template_id?, status_id?, stage_id?(IGNORED — stage derived from status), owner_id?, reporter_id?, label_ids:[uuid], due_date?, estimate?(float→hours), guest_visible?, guest_title?, guest_description?, priority?, field_values:{fieldId: value} }`.
- **updateTask** `{ title?, description?, status_id?, stage_id?(IGNORED), owner_id?, reporter_id?, due_date?, start_date?, estimate?, priority?, guest_visible?, guest_title?, guest_description? }`. Owner/reporter ride the PATCH; an explicit `null` clears. **Still accepts NO labels and NO field_values** — those keep their dedicated endpoints.
- **moveTask** `{ status_id?, before_id?, after_id?, project_id?(IGNORED) }` → returns `{task, previous:{status_id, position, completed_at}}`. Hydrate `raw.task`.
- **bulkCreate** `{ project_id*, template_id*, idempotency_key?, tasks:[{ title*, description?, status_id?, owner_id?, reporter_id?, label_ids, field_values }] }`.
- **addComment** `{ body_md OR content (req), stage_id?(defaults to task's current stage), mention_user_ids:[uuid] }`.
- **replyComment** `{ body_md OR content (req), mention_user_ids:[uuid] }` — `stage_id` ignored (inherits parent root's stage); reply-to-reply → 422 validation_failed.

An `owner_id`/`reporter_id` naming a user who is not a member of the task's project → **422
`validation_failed`** with `details.field` naming the offending field.

## Ownership model (load-bearing)

A task has **one owner and one reporter**, both top-level and both nullable. `owner_id` and
`reporter_id` are ordinary writable fields on create, bulk-create and `PATCH /tasks/{id}`;
sending an explicit `null` clears one. There is no stage dimension to ownership any more.

This replaces the old per-stage model: `stage_responsibilities` on the create/bulk bodies, the
same field in the task bundle, and the whole `GET/PATCH /tasks/{id}/stage-responsibilities`
route were **removed server-side**. The MCP therefore resolves `owner`/`reporter` names
straight to `owner_id`/`reporter_id` on the one write it is already making — no fan-out, no
stage to derive, and ownership changes are covered by the update's `If-Match` like any other
field.

A non-member user id → 422 `validation_failed` (`details.field` = `owner_id`/`reporter_id`).
Ownership changes are recorded on the task timeline as `owner_changed` / `reporter_changed`.

## DTO hydration anchors

- `Task`: `key` (e.g. `WEB-42`) is **computed** from project `task_prefix` + `number`, not stored. `status_id` only (no inline name → hydrate from /workflow). `owner_id`/`reporter_id` are bare uuids or null; names arrive only via `?expand=owner,reporter` → `TaskWithRelations{owner, reporter, labels}`.
- **User stub** (the expanded `owner`/`reporter`): `{ id, display_name, first_name, last_name, avatar_url, job_title }` — every field but `id` nullable. `job_title` is the person's role in the organization (`organization_members.job_title`), and the same value rides each `/projects/{id}/members` row, so the MCP can label an owner even without `?expand`.
- `TaskTimelineEvent`: `{ id, task_id, event_type, actor_id, data, old_value, new_value, project_id, created_at, is_deleted }`. For `owner_changed`/`reporter_changed`, `old_value`/`new_value` are a **bare uuid or null** (not an object) and `data.task_id` carries the task.
- `Comment`: body wire field is `content` (+ `content_html`); `mentions:[uuid]`; `stage_id`, `parent_id`, `thread_root_id`, `author_id`, `updated_at`.
- Workflow: `Stage{id,name,key,category,position,…}` + nested `Status{id,name,key,category,stage_id,position,…}`. Labels/members/templates fetched separately.

See [[DOC-ERROR-MODEL]] for the error/status mapping and [[DOC-CONCURRENCY]] for the
ETag/If-Match flow.
