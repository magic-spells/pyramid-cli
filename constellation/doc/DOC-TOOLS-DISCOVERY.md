---
name: Discovery & profile tools
kind: guide
status: built
connections:
  - DATATYPE-WHOAMI
  - DATATYPE-PROJECT-SUMMARY
  - DATATYPE-WORKFLOW
  - DATATYPE-TASK-SUMMARY
  - FILE-TOOLS-DISCOVERY
  - PLAN-PHASE-2-CORE-TOOLS
---

Grouped read operations that orient the AI. Built in [[FILE-OPERATIONS]] and surfaced through
[[FILE-SERVER]] / [[FILE-CLI]].

| Tool | Returns | Notes |
|---|---|---|
| `whoami()` | [[DATATYPE-WHOAMI]] | current user + the key's one workspace + accessible projects |
| `list_projects()` | [[DATATYPE-PROJECT-SUMMARY]][] | projects in the workspace |
| `get_project_workflow(project)` | [[DATATYPE-WORKFLOW]] | stages/statuses/labels/members/templates; warms the resolver cache (60s) |
| `list_my_tasks(limit?, cursor?)` | [[DATATYPE-TASK-SUMMARY]] page | tasks I own **or** review, across accessible projects |

`list_my_tasks` has no `role` filter. `GET /v1/me/tasks?role=` is accepted and ignored
server-side ([[DOC-BACKEND-CONTRACT]]), so offering the parameter would have promised a
narrowing that never happened — worse than not offering it. The feed is owned-or-reviewed; to
narrow to one, filter a project with `list_tasks(owner:)` / `list_tasks(reviewer:)`.

Also surfaced as resources ([[FILE-RESOURCES]]).
