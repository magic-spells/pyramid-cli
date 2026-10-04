---
name: Pyramid HTTP API
kind: external-microservice
status: built
vendor: Pyramid (the `pyramid` repo, `server/`)
purpose: The upstream project-management API the MCP drives, as the key's user.
docs_url: https://github.com/magic-spells/pyramid
credentials_envs:
  - PYRAMID_API_KEY
connections:
  - DOC-AUTH-WORKSPACE
  - DOC-ERROR-MODEL
---

The upstream Pyramid HTTP API — the fixed boundary this package adapts to. Owned by the `pyramid` repo, in its `server/` Go module; this MCP/CLI package never changes it. Read exact endpoint shapes from that repo's plan via the `repo:` selector (`repo: "pyramid"`, its `API-*` / `DATATYPE-*` cards) when wiring a tool.

- **Base URL:** `PYRAMID_BASE_URL` (`https://api.pyramid.magicspells.io` prod / `http://localhost:8080` dev). Versioned resources under **`/v1`**.
- **Auth:** `Authorization: Bearer pyk_<prefix>_<secret>` on every call; CSRF-exempt header auth. See [[DOC-AUTH-WORKSPACE]].
- **Workspace:** the key is pinned to one workspace server-side; `X-Workspace-*` hints are ignored. The package is single-workspace per key.
- **Errors:** `{ "error": { code, message, details } }` (`details` always an object). Status codes: 401 `unauthorized`, 403 `forbidden`, 404 `*_not_found` (incl. `workspace_not_found`), 422 `validation_failed` (400 only for malformed JSON), 409 `conflict` (handle/prefix collisions and If-Match precondition). No 429 exists today. Mapped by [[DOC-ERROR-MODEL]].
- **Optimistic concurrency:** update + delete (task & comment) require an `If-Match` ETag — see [[DOC-CONCURRENCY]].
- **Workflow is multi-endpoint:** `/workflow` returns only stages+statuses; labels, members, and custom-field templates are separate routes (matters for the resolver, [[DOC-NAME-RESOLUTION]]).
- **Ownership is flat:** a task has one nullable `owner_id` and one nullable `reviewer_id`, writable on create, bulk and PATCH. The per-stage `stage_responsibilities` model and its endpoint were removed upstream — see [[DOC-BACKEND-CONTRACT]].
- **Surface:** Workspace -> Folder(Guest) -> Project -> Stage -> Status -> Task, plus comments / timeline / followers / notifications / search. The audited route + payload contract is [[DOC-BACKEND-CONTRACT]]; quirks (`task`==`task`, derived human keys, stage-scoped comments, fractional ordering) live in [[DOC-DESIGN-RULES]].
