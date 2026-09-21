---
name: src/mcp/resources.ts
status: built
path: src/mcp/resources.ts
language: typescript
summary: 'MCP resources: me, projects, project workflow.'
connections:
  - DATATYPE-WHOAMI
  - DATATYPE-PROJECT-SUMMARY
  - DATATYPE-WORKFLOW
  - DOC-TOOLS-DISCOVERY
---

MCP resources (read-only context the AI can auto-load), implemented in `src/mcp/resources.ts`:
`pyramid://me` ([[DATATYPE-WHOAMI]]), `pyramid://projects` ([[DATATYPE-PROJECT-SUMMARY]]), and
`pyramid://projects/{handle}/workflow` ([[DATATYPE-WORKFLOW]]).

Each resource reuses the shared operation registry where possible (`whoami`, `list_projects`,
`get_project_workflow`) so resource reads return the same hydrated shapes as the equivalent tools.
Errors are rendered as the same typed [[DATATYPE-MCP-ERROR]] JSON envelope used by tools.
