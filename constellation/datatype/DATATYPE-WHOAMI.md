---
name: WhoAmI
status: built
connections:
  - DOC-AUTH-WORKSPACE
  - DATATYPE-PROJECT-SUMMARY
---

Output of `whoami` and the `pyramid://me` resource. **One** workspace — the key's pinned
workspace ([[DOC-AUTH-WORKSPACE]]).

```ts
interface WhoAmI {
  user: { id: string; display_name: string; email: string };
  workspace: { id: string; handle: string; name: string; role: "owner" | "admin" | "member" };
  projects: ProjectSummary[]; // accessible projects in this workspace
}
```
