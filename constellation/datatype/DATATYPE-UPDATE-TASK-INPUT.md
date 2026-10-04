---
name: UpdateTaskInput
status: built
connections:
  - DATATYPE-TASK-DETAIL
---

Input for [[API-TOOL-UPDATE-TASK]] — a sparse patch; only present fields change. `task`
accepts a human key or UUID. To change status/stage or ordering use [[API-TOOL-MOVE-TASK]],
not this.

```ts
interface UpdateTaskInput {
  task: string;         // "WEB-42" or UUID
  title?: string;
  description?: string | null;
  priority?: "none" | "low" | "medium" | "high" | "urgent";
  due_date?: string | null;
  start_date?: string | null;
  estimate?: number;
  guest_visible?: boolean;
  owner?: string | null;    // member name/email; explicit null clears
  reviewer?: string | null; // same
  // Convenience fields the backend PATCH does NOT accept — the MCP fans each out (see below):
  add_labels?: string[];
  remove_labels?: string[];
  custom_fields?: { field: string; value: unknown }[];
}
```

**Wire mapping ([[DOC-BACKEND-CONTRACT]]).** `owner`/`reviewer` resolve to `owner_id`/
`reviewer_id` and ride the **same** `PATCH /v1/tasks/{id}` as the content fields — one write,
covered by the read-first `If-Match` ([[DOC-CONCURRENCY]]), so an ownership change can no longer
half-succeed. Passing `null` clears the field; a name that resolves to a non-member → 422
`validation_failed`.

Labels and custom fields still fan out to their dedicated endpoints in the same tool call:
`add_labels`/`remove_labels` → `POST`/`DELETE …/labels`, `custom_fields` →
`PATCH …/field-values`. A partial failure reports which sub-update failed; the AI still passes
names, never UUIDs or endpoints.
