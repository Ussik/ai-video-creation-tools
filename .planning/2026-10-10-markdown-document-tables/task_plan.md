# Markdown document tables

## Goal
Render and edit screenshot-style Markdown tables in the director document reader and full-screen script editor; preserve content when saving and reloading.

## Phases
- [x] Diagnose shared parser, editor schema and preview renderer.
- [x] Implement script-only table schema, Markdown codec, preview and shared styles.
- [x] Verify round trips, editing/search, builds and real browser layout.

## Constraints
- Preserve unrelated working-tree changes and canvas text API/schema.
- Use official Tiptap table extension for script editing.
- Keep dark visual style, readable wrapping and table-local scrolling.
- PLAN_ID=2026-10-10-markdown-document-tables

## Errors
- Initial batched reads exceeded output budget; use smaller reads.
- zsh rejected unmatched canvas/test globs; use rg discovery.
- apply_patch cannot delete and add the same path in one patch; use direct planning-file writes.
- npm install in sandbox failed DNS for configured registry; official npm registry with escalation succeeded.
- Inspection attempted before dependency install completed; awaited installation then read extension source.
- Test append used a redundant web prefix while cwd was web; corrected with absolute-path patch.
- Sandboxed curl could not reach localhost; starting Vite reported 5173 already in use. Check existing service through browser.
