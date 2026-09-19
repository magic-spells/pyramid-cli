---
name: TaskDetail
status: built
connections:
  - DATATYPE-TASK-SUMMARY
  - DATATYPE-COMMENT
  - DATATYPE-TASK-REFERENCE
  - PLAN-V2-ROADMAP
  - API-TOOL-GET-TASK-TIMELINE
---

Full task shape returned by `get_task` and by create / update / move ops. The backend's only
drill-in on the task endpoint is **`?expand`**, which inlines the related **owner / reporter /
labels** ([[DOC-BACKEND-CONTRACT]]); `get_task` exposes it as a boolean `expand`. The heavier
relations below are **not** part of `get_task` — each is its own tool / endpoint and merges into
this shape when fetched.

```ts
interface TaskDetail extends TaskSummary {
  description: string | null;
  // owner/reporter/labels are inlined by get_task(expand: true).
  field_values?: { field: string; value: unknown }[];     // from the /editor endpoint
  estimates?: { total_hours: number; by_stage: Record<string, number> }; // from /estimates
  comments?: TaskComment[];          // via the `list_comments` tool
  references?: TaskReference[];      // via `list_task_references` ([[DATATYPE-TASK-REFERENCE]])
  followers?: { id: string; display_name: string }[];     // from /followers
  dependencies?: { id: string; key: string; type: string }[];
}
```

`timeline` is **not** a field on this shape — the task history is its own paginated tool,
[[API-TOOL-GET-TASK-TIMELINE]] over `GET /v1/tasks/{id}/timeline` (now built server-side; the
earlier note deferring it to [[PLAN-V2-ROADMAP]] is obsolete). `field_values` come from the
separate `/editor` endpoint, not the base task. `references` = [[DATATYPE-TASK-REFERENCE]].
