---
name: CreateTaskInput
status: built
connections:
  - DOC-NAME-RESOLUTION
  - DATATYPE-TASK-DETAIL
---

Input for [[API-TOOL-CREATE-TASK]]. All references are **names**, resolved to UUIDs before the call
([[DOC-NAME-RESOLUTION]]). Only `title` is required. Placement is by `status` (stage is derived — a
`stage` only picks that stage's first status when `status` is omitted; an inconsistent pair →
`status_not_in_stage`).

```ts
interface CreateTaskInput {
  project: string;            // slug / name / fuzzy
  title: string;              // the ONLY required field
  description?: string;
  status?: string;            // name/key/category — drives placement (carries the stage)
  stage?: string;             // name/key — only used to derive a default status
  priority?: "none" | "low" | "medium" | "high" | "urgent";
  due_date?: string;          // YYYY-MM-DD or RFC3339 (stored as a date)
  estimate_hours?: number;
  labels?: string[];          // label names
  owner?: string;             // member name/email -> owner_id
  reporter?: string;          // member name/email -> reporter_id
  custom_fields?: { field: string; value: unknown }[]; // MCP validates value against field_type
  guest_visible?: boolean; guest_title?: string; guest_description?: string;
}
```

**Ownership is flat.** A task has one owner and one reporter; `owner`/`reporter` resolve to
top-level `owner_id`/`reporter_id` on the create body ([[DOC-BACKEND-CONTRACT]]). There is no
stage to derive and no `assignments[]` — the per-stage `stage_responsibilities` model, and the
`assignments[]` input that fed it, were both removed when the server dropped per-stage
ownership. A name that resolves to a non-member of the project → 422 `validation_failed`.

**Dependencies are NOT settable at create.** Custom-field values are resolved to field UUIDs and
validated against the field's `field_type` before the write ([[DOC-DESIGN-RULES]] rule 8).
