---
name: TaskSummary
status: built
connections:
  - DATATYPE-WORKFLOW
  - DOC-RENDERING
---

Hydrated list-row shape for `list_tasks` / `search_tasks` / `list_my_tasks`. Every UUID is hydrated
to a name by the MCP ([[DOC-DESIGN-RULES]] rule 4) — the server returns only `status_id`/`owner_id`
and **no stage**, so the MCP joins via the cached [[DATATYPE-WORKFLOW]]. Carries everything the task
card needs ([[DOC-RENDERING]]).

```ts
interface TaskSummary {
  id: string;
  key: string;            // derived human key, e.g. "WEB-42" (task_prefix + "-" + number)
  title: string;
  description: string | null;             // truncated to one line in list render
  status: { id: string; name: string };
  stage: { id: string; name: string };    // derived from status, hydrated by the MCP
  owner: UserStub | null;
  reviewer: UserStub | null;
  labels: string[];
  archived: boolean;
  updated_at: string;     // ISO 8601 — rendered UTC-labeled (rule 12)
}

interface UserStub {
  id: string;
  display_name: string;   // always joined — never a bare UUID
  first_name?: string | null;
  last_name?: string | null;
  avatar_url?: string | null;
  job_title?: string | null;  // the person's role in the workspace, e.g. "Design Lead"
}
```

**Owner and Reviewer, never "assignee."** A task has exactly one of each, both nullable; they
are top-level fields on the wire ([[DOC-BACKEND-CONTRACT]]). `first_name` / `last_name` /
`avatar_url` / `job_title` arrive only when the caller asked for `expand`, except `job_title`,
which the MCP can also fill from the cached workflow's member rows. Renderers show
`display_name` plus `job_title` when it is known.
