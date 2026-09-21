---
name: Onboarding
kind: guide
status: built
connections:
  - DATATYPE-MCP-CONFIG
  - EXTERNAL-PYRAMID-API
  - DOC-AUTH-WORKSPACE
  - DOC-PACKAGE-RENAME
  - DOC-CLI
  - DOC-CREDENTIAL-STORAGE
  - FILE-AUTH-COMMANDS
---

# Onboarding

1. Preferred local setup: run browser login. It opens Pyramid, asks for consent, mints a workspace-scoped API key, and stores it in the local keychain ([[FLOW-CLI-BROWSER-LOGIN]], [[DOC-CREDENTIAL-STORAGE]]):

```sh
npx -y @magic-spells/pyramid login
```

For dev/staging, target a different web app with `PYRAMID_WEB_URL` or `--web-url`:

```sh
PYRAMID_WEB_URL=http://localhost:5173 npx -y @magic-spells/pyramid login
```

2. Manual fallback: open Pyramid (`pyramid-web`) -> **Settings -> API Keys** -> "Generate new key", copy the one-time `pyk_<prefix>_<secret>`, then store it with:

```sh
npx -y @magic-spells/pyramid set-key pyk_...
```

3. Add the MCP server to the client config (`~/.claude.json` or `.mcp.json`). The server is the `mcp` subcommand of the `pyramid` bin ([[DOC-PACKAGE-RENAME]]):

```jsonc
{
  "mcpServers": {
    "pyramid": {
      "command": "npx",
      "args": ["-y", "@magic-spells/pyramid", "mcp"],
      "env": {
        "PYRAMID_BASE_URL": "https://api.pyramid.magicspells.io"
      }
    }
  }
}
```

4. Restart the AI tool.
5. Run the `pyramid:doctor` prompt or `npx -y @magic-spells/pyramid doctor` — it confirms the authenticated user, workspace, and accessible projects.

For CI, headless runs, or clients where keychain access is inconvenient, set `PYRAMID_API_KEY` in the MCP `env` block instead. Env always wins over the keychain. Local key management commands are `pyramid login`, `pyramid set-key`, `pyramid show-key` (masked), and `pyramid logout` (clear stored key).
