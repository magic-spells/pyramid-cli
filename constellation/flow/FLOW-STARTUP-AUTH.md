---
name: Startup & auth
status: built
triggers:
  - kind: manual
connections:
  - FILE-BIN
  - FILE-SERVER
  - FILE-CONFIG
  - DATATYPE-MCP-CONFIG
  - EXTERNAL-PYRAMID-API
  - DOC-AUTH-WORKSPACE
  - FLOW-CREDENTIAL-RESOLUTION
  - FILE-AUTH-COMMANDS
  - FILE-VERSION
  - FILE-CLI
---

# Startup & auth

1. Process starts through [[FILE-BIN]]: `pyramid ...`, `npx -y @magic-spells/pyramid ...`, or an MCP client running `npx -y @magic-spells/pyramid mcp`.
2. Branches handled **before config load**:
   - `pyramid version` / `v` / `-v` / `--version` prints the package version from [[FILE-VERSION]].
   - `pyramid set-key`, `set-api-key`, `set-token`, `show-key`, `logout`, and `login` run local credential commands from [[FILE-AUTH-COMMANDS]]. They do not require an existing Pyramid API key; `login` opens the web app and waits for a loopback callback.
3. CLI commands other than `mcp` / `doctor` hand off to [[FILE-CLI]], which parses globals, loads config, invokes the operation registry, and renders output.
4. `pyramid mcp` and `pyramid doctor` load [[DATATYPE-MCP-CONFIG]] through [[FILE-CONFIG]]. Credential resolution is `PYRAMID_API_KEY` env -> OS keychain -> clear error ([[FLOW-CREDENTIAL-RESOLUTION]]).
5. `pyramid mcp` constructs [[FILE-SERVER]] with a `PyramidClient` (bearer `pyk_...`) and `Resolver`, then connects `StdioServerTransport`; SIGINT/SIGTERM/stdin-close shut down cleanly.
6. `pyramid doctor` calls `getMe`, `listProjects`, `listWorkspaces`, and a first-project workflow ping against [[EXTERNAL-PYRAMID-API]], prints user/workspace/projects, and exits by outcome. `listWorkspaces` (`GET /v1/workspaces`) is best-effort — its failure degrades the workspace line rather than the command.
   - 401 -> print `auth_invalid` / `auth_expired` guidance from [[DOC-AUTH-WORKSPACE]], exit non-zero.
