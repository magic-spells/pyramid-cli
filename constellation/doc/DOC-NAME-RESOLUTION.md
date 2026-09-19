---
name: Name → ID resolution
kind: rule
status: built
connections:
  - DATATYPE-MCP-ERROR
  - DATATYPE-WORKFLOW
---

# Name → ID resolution

Inputs accept names; the resolver maps project/workflow names to UUIDs with **deterministic
precedence** — the same input always resolves the same way. Backed by [[FILE-RESOLVER]] and the
cached [[DATATYPE-WORKFLOW]]. Task key/UUID lookup is handled by [[FILE-OPERATIONS]]'s
`resolveTaskRef` helper because it needs task search / task detail endpoints, not workflow data.

| Kind | Precedence |
|---|---|
| Project | slug (ci exact) → name (ci exact) → unique fuzzy contains |
| Stage | per project: key → name (ci) → unique fuzzy |
| Status | per project: key → name (ci); a stage name where a status is expected → first status of that stage by position |
| User | email exact → `display_name` exact → unique fuzzy |
| Label | per project: name exact → unique fuzzy |
| Custom field | per template: key → name |
| Task | human key `WEB-42` → search exact key → UUID; raw UUID → `GET /v1/tasks/{id}` |

- **Ambiguity is an error, not a guess** — two labels matching "bug" → `ambiguous_label_name`
  with `candidates` ([[DATATYPE-MCP-ERROR]]); the AI asks or picks.
- **Cache:** in-process 60s TTL keyed by project workflow plus an org-wide project-list cache,
  lazy-populated and invalidated by `Resolver.invalidate(...)`.
- **Force-refresh:** `--no-cache` is parsed by the CLI as a reserved debug flag, but no shipped
  operation consumes it yet.
