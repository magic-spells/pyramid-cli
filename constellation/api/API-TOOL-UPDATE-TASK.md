---
name: update_task
kind: mcp-tool
status: built
methods:
  POST:
    request_schema: DATATYPE-UPDATE-TASK-INPUT
    response_schema: DATATYPE-TASK-DETAIL
connections:
  - FILE-TOOLS-TASKS
  - PLAN-PHASE-2-CORE-TOOLS
---

`update_task` — sparse patch of a task's content **plus its owner and reporter**: title,
description, priority, dates, estimate, guest_*, `owner`, `reporter`
([[DATATYPE-UPDATE-TASK-INPUT]] → [[DATATYPE-TASK-DETAIL]]). Wraps `PATCH /v1/tasks/{id}`,
which **requires an `If-Match` ETag** — the client does a read-first to get it
([[DOC-CONCURRENCY]]).

Owner/reporter are top-level nullable fields on that PATCH ([[DOC-BACKEND-CONTRACT]]): names
resolve to `owner_id`/`reporter_id`, an explicit `null` clears one, and a non-member comes back
as a typed `validation_failed`. They used to be a separate `PATCH …/stage-responsibilities`
call; that route is gone, so ownership now moves atomically with the rest of the patch.

The PATCH body still accepts **neither** labels nor custom-field values — those keep their
dedicated endpoints and ride along as a fan-out: labels → `POST`/`DELETE …/labels`, fields →
`PATCH …/field-values`. Status/stage and ordering go through [[API-TOOL-MOVE-TASK]], not here.
