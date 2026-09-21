---
name: Browser login handoff (pyramid login)
status: built
triggers:
  - kind: manual
connections:
  - FILE-AUTH-COMMANDS
  - FILE-KEYCHAIN
  - DOC-CREDENTIAL-STORAGE
  - PLAN-V2-ROADMAP
  - EXTERNAL-PYRAMID-API
---

# Browser login handoff — `pyramid login`

The seamless alternative to a manual `set-key` paste: obtain a workspace-scoped `pyk_` key via the browser and save it to the keychain. Built by the CLI package's `pyramid login` command plus the web app's `/auth/cli` route.

1. `pyramid login` starts a tiny loopback HTTP server on `http://127.0.0.1:<port>/callback`, generates a random `state`, and opens the browser to the web app's `/auth/cli?redirect_uri=...&state=...&name=...`.
2. The user signs in through the normal web auth gate if needed. The page validates that `redirect_uri` is a loopback HTTP URL before any secret is minted.
3. On consent, the web page reuses the existing interactive-session `POST /api-keys` endpoint to mint a workspace-scoped key, then sends it to the loopback callback as `?key=...&state=...` with `fetch(..., { mode: 'no-cors' })`.
4. The CLI callback validates `state`, validates the `pyk_` prefix, stores the key via [[FILE-KEYCHAIN]] `setKey`, prints only the masked key, and closes the local server.
5. If the browser cannot be opened automatically, the CLI prints the URL and keeps listening. If the user cancels, the web page calls back with `error=access_denied`, and the CLI exits without storing a key.

MVP intentionally passes the one-time key through the loopback URL because both endpoints are local and short-lived. A future short-lived code exchange can remove the secret from the URL without changing the stored credential model.
