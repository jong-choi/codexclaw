---
name: workspace_files
description: Manage CodexClaw workspace files for memory and instructions.
metadata:
  { "openclaw": { "emoji": "🗂️" } }
---

# workspace_files

Use these tools when the user asks to create, update, read, or delete files in the CodexClaw workspace.

## Scope

- All paths are workspace-relative.
- Do not attempt absolute paths or parent traversal (`../`).
- Treat `MEMORY.md` and `INSTRUCTIONS.md` as primary context files.

## Tools

`workspace_read_file`
- `path` (required): workspace-relative file path
- `maxChars` (optional): max text length returned

`workspace_write_file`
- `path` (required): workspace-relative file path
- `content` (required): text to write
- `mode` (optional): `overwrite` (default) or `append`

`workspace_delete_path`
- `path` (required): workspace-relative file or directory path
- `recursive` (optional): set `true` for directories

## Working rules

- For memory updates, prefer appending concise entries instead of rewriting entire files.
- Never claim file changes unless a workspace tool call actually succeeded.
