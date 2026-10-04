---
name: create_tasks_bulk
kind: mcp-tool
status: built
methods:
  POST:
    request_schema: DATATYPE-CREATE-TASKS-BULK-INPUT
    response_schema: DATATYPE-TASK-DETAIL
connections:
  - FILE-TOOLS-TASKS
  - PLAN-PHASE-2-CORE-TOOLS
---

`create_tasks_bulk` — create many tasks atomically ([[DATATYPE-CREATE-TASKS-BULK-INPUT]]).
Handles "create these tasks and put them in the ready-for-design phase". Wraps
`POST /v1/tasks/bulk`, which requires a **top-level `project_id` + `template_id`** (one
template for the whole batch) and per-row `{title, status_id?, owner_id?, reviewer_id?,
label_ids, field_values}` ([[DOC-BACKEND-CONTRACT]]) — so the tool input resolves a single
project + template, not per row. Each row's `owner`/`reviewer` name resolves to the row's
top-level `owner_id`/`reviewer_id`; the old per-row `stage_responsibilities` array is gone.
Cap **100** rows; any row's validation failure rolls back the whole batch; returns
`{created:[…], errors:[]}` → the created [[DATATYPE-TASK-DETAIL]] list.
