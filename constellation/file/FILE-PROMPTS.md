---
name: src/mcp/prompts.ts
status: built
path: src/mcp/prompts.ts
language: typescript
summary: MCP prompt skin; registers the doctor prompt.
connections:
  - PLAN-PHASE-1-FOUNDATION
  - FILE-SERVER
  - FLOW-STARTUP-AUTH
---

MCP prompt skin. Registers the `doctor` prompt on [[FILE-SERVER]].

`pyramid:doctor` expands to an instruction telling the model to call `whoami` and report the authenticated user, workspace, and accessible projects. No Pyramid API call happens while registering the prompt; the model invokes the tool when the prompt runs.

The CLI `pyramid doctor` branch in [[FILE-BIN]] is separate but serves the same setup-check purpose.
