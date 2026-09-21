---
name: Auth & workspace model
kind: rule
status: built
connections:
  - EXTERNAL-PYRAMID-API
  - DATATYPE-WHOAMI
  - DATATYPE-MCP-ERROR
  - DATATYPE-MCP-CONFIG
notes:
  - kind: decision
    text: >-
      2026-09-20 — Pyramid workspaces are distinct from account-service organizations: one account
      can own several workspaces. Pyramid is not live, so this is a full rename with no compatibility
      aliases or dual-read headers. The API key is workspace-pinned server-side and the CLI never
      sends `X-Workspace-Handle`.
---

# Auth & workspace model (the rule that shapes the tool surface)

Settled and shipped server-side ([[EXTERNAL-PYRAMID-API]]; `pyramid-server` `FLOW-APIKEY-AUTH`).
The MCP must honor it:

- A `pyk_<prefix>_<secret>` key resolves to exactly **one user** (the security boundary) and
  is **pinned to exactly one workspace**. Bearer requests are forced to that workspace;
  client `X-Workspace-*` hints are ignored.
- **Consequence — the MCP is single-workspace per key.** There is **no** `list_workspaces` /
  `set_active_workspace` tool (the early sketch's switching tools are dropped). `whoami`
  ([[DATATYPE-WHOAMI]]) reports the one workspace the key acts in. A user who needs two
  workspaces mints two keys and configures two MCP servers.
- The key **inherits exactly its owner's access** within that workspace — workspace role,
  project roles, and guest-visibility limits all apply unchanged. No super-keys.
- **Key management is browser-only.** `GET/POST/DELETE/regenerate /v1/api-keys` reject
  API-key auth (403), so this MCP can never mint or revoke keys. Keys are created in
  `pyramid-web` → Settings → API Keys ([[DOC-ONBOARDING]]).
- A revoked / expired / unknown key → **401**. The client surfaces `auth_invalid` /
  `auth_expired` with a hint to regenerate ([[DATATYPE-MCP-ERROR]]).
