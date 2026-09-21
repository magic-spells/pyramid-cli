---
name: Decision — store the API key in the OS keychain
kind: decision
status: built
connections:
  - FILE-CONFIG
  - FILE-KEYCHAIN
  - FILE-AUTH-COMMANDS
  - FILE-BIN
  - DATATYPE-MCP-CONFIG
  - DOC-AUTH-WORKSPACE
  - FLOW-CREDENTIAL-RESOLUTION
  - FLOW-CLI-BROWSER-LOGIN
  - PLAN-V2-ROADMAP
  - DOC-ONBOARDING
---

# Decision — store the API key in the OS keychain

**Context.** A `pyk_` key is password-equivalent ([[DOC-AUTH-WORKSPACE]]). Plain env storage is still supported for CI/headless MCP clients, but local users should not have to keep the key in a readable shell profile or MCP config dotfile.

**Decision.** OS-keychain storage is the preferred local at-rest location, while `env` remains the explicit override. Startup resolution order ([[FLOW-CREDENTIAL-RESOLUTION]], [[FILE-CONFIG]]):

> `PYRAMID_API_KEY` (env) -> OS keychain -> error

- **Store ([[FILE-KEYCHAIN]]):** macOS via the built-in `/usr/bin/security` generic-password (service `pyramid`, account `default`) — no native dependency. Non-macOS falls back to a `chmod 600` file at `~/.config/pyramid/credentials.json`. Full Windows / Linux secret-service support is later polish.
- **Write paths:** `pyramid login` opens the web app, receives a minted key through a loopback callback, and stores it with `setKey`. Manual fallback remains `pyramid set-key <pyk_...>` (aliases `set-api-key` / `set-token`). `pyramid logout` -> `deleteKey`; `pyramid show-key` -> masked status ([[FILE-AUTH-COMMANDS]], [[FILE-BIN]]).
- **MCP never writes credentials.** A non-interactive stdio process only reads through [[FILE-CONFIG]]; there is deliberately no model-callable "set key" tool.

**Caveats (documented, accepted):**

- A subprocess keychain read, such as `pyramid mcp` launched by Claude Code, may show a one-time macOS allow-access prompt. Headless / CI has no keychain, which is why `env` stays the override.
- `security add-generic-password -w <key>` briefly exposes the key in the local process list during interactive `set-key` or `login` storage; acceptable for this local setup flow.
- MVP browser handoff passes the one-time key through a loopback URL. The callback server is bound to `127.0.0.1`, validates a random `state`, and exits immediately after success/failure. A future short-lived code exchange can remove the secret from the URL without changing credential storage.

**Why.** Moves the password-equivalent out of plaintext dotfiles into OS-encrypted, OS-gated storage on the common macOS path, with a dependency-free fallback elsewhere. Browser login improves setup ergonomics while preserving the same local credential model.
