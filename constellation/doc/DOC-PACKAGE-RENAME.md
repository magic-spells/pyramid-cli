---
name: Decision — one package @magic-spells/pyramid, one pyramid bin
kind: decision
status: built
connections:
  - DOC-PACKAGING
  - DOC-ONBOARDING
  - FILE-BIN
  - DATATYPE-MCP-CONFIG
  - DOC-CLI
---

# Decision — one package `@magic-spells/pyramid`, one `pyramid` bin

**Context.** The package ships two surfaces over one core — the MCP server and the CLI ([[DOC-CLI]]). It is also the only public package in the Pyramid ecosystem (the `pyramid` product repo stays private), so the bare scoped name is free and idiomatic for the public client/toolkit.

**Implemented decision:**

- **Package:** `@magic-spells/pyramid` (`publishConfig.access: "public"`).
- **One bin:** `bin: { "pyramid": "dist/bin/pyramid.js" }`.
- **Dispatch:** `pyramid mcp` -> stdio MCP server; `pyramid doctor` -> setup check; `pyramid version` -> package version; local credential commands run before config load; anything else -> CLI.
- **MCP client config:** `command: "npx", args: ["-y", "@magic-spells/pyramid", "mcp"]`.
- **Env var:** destructive gate is `PYRAMID_ALLOW_DESTRUCTIVE`; `PYRAMID_API_KEY` and `PYRAMID_BASE_URL` keep their names.
- **Repo:** the on-disk repo is `pyramid-cli/`; the merged `pyramid/` product repo (`server/` + `web/`) is the connected sibling repo.

**Why.** One install, one version, one test suite, and a guaranteed-shared core. A future programmatic SDK is a library export from this same package, not another package name.

**Legacy mapping retained for context:**

| Legacy | Current |
| --- | --- |
| `@magic-spells/pyramid-mcp` | `@magic-spells/pyramid` |
| `bin/pyramid-mcp.ts` -> `dist/bin/pyramid-mcp.js` | `bin/pyramid.ts` -> `dist/bin/pyramid.js` |
| `npx -y @magic-spells/pyramid-mcp` | `npx -y @magic-spells/pyramid mcp` |
| `pyramid-mcp doctor` | `pyramid doctor` |
| `PYRAMID_MCP_ALLOW_DESTRUCTIVE` | `PYRAMID_ALLOW_DESTRUCTIVE` |
