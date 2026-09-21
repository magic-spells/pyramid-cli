---
name: Workflow
status: built
connections:
  - DATATYPE-PROJECT-SUMMARY
  - DOC-NAME-RESOLUTION
---

The cached per-project schema behind `get_project_workflow` and the
`pyramid://projects/{handle}/workflow` resource — the in-memory shape the resolver uses to turn
names into UUIDs ([[DOC-NAME-RESOLUTION]]); cached 60s.

**Assembled from multiple backend endpoints** (the real `/workflow` returns *only* stages +
statuses, [[DOC-BACKEND-CONTRACT]]): `GET …/workflow` (stages+statuses) + `GET …/labels` +
`GET …/members` + `GET …/task-schema` (templates + `fields_by_template`). The resolver fans
these out (in parallel) on first use and caches the merged result; a partial failure degrades
that kind only (e.g. labels unavailable → `label_*` resolution errors, names still resolve).

```ts
interface Workflow {
  project: ProjectSummary;
  stages: { id: string; key: string; name: string; position: string }[];
  statuses: { id: string; key: string; name: string; stage_id: string; position: string }[];
  labels: { id: string; name: string; color: string }[];
  members: WorkflowMember[];
  templates: { id: string; name: string; fields: CustomFieldDef[] }[];
}

interface WorkflowMember {
  id: string;             // the USER id — what owner_id/reporter_id/author_id reference
  display_name: string;
  email: string;
  role: string;           // project role: admin | pm | member | viewer | guest
  job_title?: string;     // the person's own title, e.g. "Design Lead" — NOT the role
}

interface CustomFieldDef {
  id: string; key: string; name: string;
  field_type: "text" | "number" | "date" | "select" | "multiselect" | "checkbox" | "user";
  options?: string[];
}
```

`role` and `job_title` are different things and both matter: `role` is permission (what they may
do), `job_title` is the human label a renderer shows beside an Owner's name. The members
endpoint carries `job_title`, which is why a task's owner can be labelled without paying for
`?expand` on every row.
