---
name: WhoAmI
status: built
connections:
  - DOC-AUTH-ORGANIZATION
  - DATATYPE-PROJECT-SUMMARY
---

Output of `whoami` and the `pyramid://me` resource. **One** organization — the key's pinned
org ([[DOC-AUTH-ORGANIZATION]]).

```ts
interface WhoAmI {
  user: { id: string; display_name: string; email: string };
  organization: { id: string; slug: string; name: string; role: "owner" | "admin" | "member" };
  projects: ProjectSummary[]; // accessible projects in this org
}
```
