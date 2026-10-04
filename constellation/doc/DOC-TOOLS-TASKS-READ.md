---
name: Task read tools
kind: guide
status: built
connections:
  - DATATYPE-TASK-SUMMARY
  - DATATYPE-TASK-DETAIL
  - DOC-NAME-RESOLUTION
  - FILE-TOOLS-TASKS
  - PLAN-PHASE-2-CORE-TOOLS
  - DATATYPE-TIMELINE-EVENT
---

# Task read tools

Built in [[FILE-OPERATIONS]]; the writes are the per-tool `API-TOOL-*` cards.

| Tool | Returns | Notes |
|---|---|---|
| `list_tasks(project, filter?)` | [[DATATYPE-TASK-SUMMARY]] page | filter by status/stage/**owner**/**reviewer**/label/query; `archived=false` default ([[DOC-DESIGN-RULES]] rule 9); paginated |
| `get_task(task, expand?)` | [[DATATYPE-TASK-DETAIL]] | `task` = `WEB-42` or UUID; `expand: true` requests owner/reviewer/labels |
| `get_task_timeline(task, …)` | [[DATATYPE-TIMELINE-EVENT]] page | task history, **oldest first** ([[API-TOOL-GET-TASK-TIMELINE]]) |
| `search_tasks(query, limit?)` | [[DATATYPE-TASK-SUMMARY]] page | full-text workspace search; wraps `GET /v1/search/tasks` |

The people filters are `owner` and `reviewer` — the words the product uses. The older
`assignee` alias is gone; it was a single knob over a per-stage ownership model that no longer
exists, and it mapped silently to `owner_id` anyway ([[DOC-BACKEND-CONTRACT]]).

All inputs accept names; all outputs hydrate ([[DOC-NAME-RESOLUTION]]).
