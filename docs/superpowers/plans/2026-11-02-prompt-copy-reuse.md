# Prompt Copy and Reuse Implementation Plan

**Goal:** Let creators copy the current prompt into another node without selecting several editor surfaces manually.

**Architecture:** One Mantine copy menu in the existing composer toolbar reads the live editor document. Body copy flattens the setting-image primary and any historical body prose into ordinary paragraphs; full copy preserves all sections in HTML and supplies readable plain text. The existing keyboard clipboard path and destination paste rules stay in use.

**Tech Stack:** React 19, Mantine 9, Tiptap / ProseMirror, Clipboard API.

**Spec:** User request and screenshot: copying the structured prompt to other nodes is inconvenient. Provide “复制正文” and “复制完整提示词”.

## Constraints

- Preserve unrelated workspace edits, node inputs, source metadata and undo history.
- Copy current unsaved content, including folded requirements; omit editor chrome and empty placeholders.
- Setting-image nodes have no separate supplement input; historical body text remains ordinary editable prose.
- Use stable reference IDs; do not copy source ownership or pending conflicts.
- No generation, database writes, commits, service restarts or subagents.

## Task: Copy menu and clipboard contract

- [x] Add live clipboard snapshots and one toolbar menu, success/error feedback and plain-text fallback.
- [ ] Verify board body plus historical prose, ordinary body, folded full copy, references, fresh pasted identities, metadata, existing destination settings and undo.
- [ ] Verify the real canvas in an isolated browser fixture; clean up the fixture and browser space.
- [ ] Run focused editor/integration tests, frontend build and project guards; record results.
