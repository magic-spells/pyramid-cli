---
name: ProjectSummary
status: built
connections:
  - DATATYPE-WORKFLOW
notes:
  - kind: gotcha
    text: >-
      2026-09-20 — The field was `slug` until today, but the server renamed project/group `slug` →
      `handle` (magic-spells/pyramid PRs #40/#41; `model.Project` emits only `handle`), so `slug`
      had been reading empty in live mode. Renamed to `handle` here and through the resolver, the
      `pyramid://projects/{handle}/workflow` resource URI, and `pyramid doctor`. Resolution
      precedence is unchanged: handle (ci exact) → name (ci exact) → unique fuzzy contains.
---

Compact project shape for `list_projects` and the `pyramid://projects` resource.

```ts
interface ProjectSummary {
  id: string;
  handle: string;
  name: string;
  task_prefix: string; // e.g. "WEB" — the human-key prefix
  role: "admin" | "pm" | "member" | "viewer" | "guest"; // caller's project role
  archived: boolean;
}
```
