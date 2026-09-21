---
name: bulk_update_tasks / bulk_set_status
kind: mcp-tool
status: planned
connections:
  - FILE-TOOLS-TASKS
  - FILE-OPERATIONS
  - DOC-DESIGN-RULES
  - DATATYPE-TASK-SUMMARY
  - PLAN-PHASE-3-COLLAB-ADMIN
---

`bulk_update_tasks` / `bulk_set_status` — edit many existing tasks in one call. **The Pyramid API has
NO bulk-update/move/status endpoint** (only bulk *create* is atomic), so this is a **NON-ATOMIC
fan-out**: it loops `N × PATCH /v1/tasks/{id}` (or `/move` for status+placement). Decision:
[[DOC-DESIGN-RULES]] — ship the fan-out now; a tracked Pyramid server follow-up (atomic
`PATCH /v1/tasks/bulk`) would upgrade it without changing this shape.

- Input: a shared patch + `task_ids` (or a list of `{ task, fields }`). `confirm` (default false) →
  returns a preview of resolved targets ([[DOC-DESIGN-RULES]] rule 11); executes only on `confirm:true`.
- Returns a per-task result array `{ task, ok, error }` — "7 updated, 1 failed: MOGO-19
  permission_denied" — never throws on first failure. Document that it can PARTIALLY apply (unlike
  the atomic [[API-TOOL-CREATE-TASKS-BULK]]) and is safe to re-run only for idempotent fields.
- `bulk_archive_tasks` is the same fan-out family (single-task `archive` looped).
