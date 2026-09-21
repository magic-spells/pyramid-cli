---
name: Test plan
status: built
connections:
  - FILE-RESOLVER
  - FILE-ERRORS
  - FILE-PYRAMID-CLIENT
  - API-TOOL-CREATE-TASK
  - FLOW-CREATE-TASK
  - PLAN-PHASE-1-FOUNDATION
---

# Test plan

- **Resolver unit tests** ([[FILE-RESOLVER]]) — every kind: exact / ambiguity / miss, plus
  cache TTL + invalidation.
- **Error-mapping unit tests** ([[FILE-ERRORS]]) — each HTTP status/envelope → expected
  [[DATATYPE-MCP-ERROR]] `code`.
- **Operation registry unit tests** ([[FILE-OPERATIONS]]) — discovery, task read/write/move/archive/delete,
  comments, custom-field validation, and destructive gating against mocked client/resolver seams.
- **CLI unit tests** ([[FILE-CLI]], [[DOC-CLI-OUTPUT]]) — JSON-vs-human rendering, stderr/stdout
  separation, usage errors, and exit-code mapping.
- **Package checks** — `npm run build`, `npm test`, and `npm pack --dry-run` before publish.

Still not verified live: an integration smoke against a real/local Pyramid server with a test
`pyk_` key: list projects, list my tasks, create/move through a real workflow, comment + mention,
reply, archive/unarchive, and `doctor`.

Implemented with `vitest` + `tsx`; the live smoke is what would move this from built to verified.
