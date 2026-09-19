---
name: get_task_timeline
kind: mcp-tool
status: built
connections:
  - FILE-TOOLS-TASKS
  - DATATYPE-TIMELINE-EVENT
  - DOC-TOOLS-TASKS-READ
  - DOC-BACKEND-CONTRACT
---

`get_task_timeline` — one page of a task's history: who changed what, when. Wraps
`GET /v1/tasks/{taskId}/timeline` and returns a page of [[DATATYPE-TIMELINE-EVENT]]. CLI:
`pyramid task timeline <KEY>`.

```
get_task_timeline(task, event_type?, limit?, cursor?)
```

`task` is a human key or UUID like every other task tool. `event_type` narrows to one kind
(`owner_changed`, `status_changed`, …); `limit` defaults to 50 and the server caps it at 200.
The page is **oldest first** — the reverse of `list_tasks` / `list_comments` — because history
reads forward; the render notes the remaining pages rather than truncating silently
([[DOC-DESIGN-RULES]] rule 8).

Read-only and never gated. It answers "when did this move to QA", "who handed this to Ann" and,
now that ownership is a plain field, it is the *only* record of a reassignment — the old
per-stage responsibility rows no longer exist to reconstruct one from ([[DOC-BACKEND-CONTRACT]]).
