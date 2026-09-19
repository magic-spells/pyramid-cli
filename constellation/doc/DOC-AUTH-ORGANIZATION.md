---
name: Auth & organization model
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
      2026-09-18 — Renamed from DOC-AUTH-WORKSPACE. One word across Magic Spells: the tenant noun is
      "organization" in code, DB and API; user-facing copy uses the short label "org"/"Org" and the
      full word only where it reads better. Pyramid is not live, so this was a full rename with no
      compatibility aliases and no dual-read headers. Rejected: keeping "workspace" (the account app
      already says organization); shipping aliases (dead weight pre-launch). In this repo the change
      is path-only plus the whoami output key — `GET /v1/workspaces` → `GET /v1/organizations`,
      `WhoAmI.workspace` → `WhoAmI.organization` — because the API key is org-pinned server-side and
      the CLI never sends `X-Workspace-Slug`. DO NOT publish this package until the Pyramid server
      rename ships.
---

# Auth & organization model (the rule that shapes the tool surface)

Settled and shipped server-side ([[EXTERNAL-PYRAMID-API]]; `pyramid-server` `FLOW-APIKEY-AUTH`).
The MCP must honor it:

- A `pyk_<prefix>_<secret>` key resolves to exactly **one user** (the security boundary) and
  is **pinned to exactly one organization**. Bearer requests are forced to that org;
  client `X-Organization-*` hints are ignored.
- **Consequence — the MCP is single-org per key.** There is **no** `list_organizations` /
  `set_active_organization` tool (the early sketch's switching tools are dropped). `whoami`
  ([[DATATYPE-WHOAMI]]) reports the one org the key acts in. A user who needs two
  orgs mints two keys and configures two MCP servers.
- The key **inherits exactly its owner's access** within that org — organization role,
  project roles, and guest-visibility limits all apply unchanged. No super-keys.
- **Key management is browser-only.** `GET/POST/DELETE/regenerate /v1/api-keys` reject
  API-key auth (403), so this MCP can never mint or revoke keys. Keys are created in
  `pyramid-web` → Settings → API Keys ([[DOC-ONBOARDING]]).
- A revoked / expired / unknown key → **401**. The client surfaces `auth_invalid` /
  `auth_expired` with a hint to regenerate ([[DATATYPE-MCP-ERROR]]).
