# Prompt Requirements Compact UI Implementation Plan

**Goal:** Replace the screenshot's repeated tall cards with a compact, editable requirements list, preserving prompt text and source metadata.

**Scope:** Existing React/Mantine/Tiptap prompt section chrome and CSS; existing generation parameter panel. No document-format changes, reordering, regeneration or business-data changes.

- [x] Unify section actions in an accessible menu. Keep pending source decisions visible, comparison available in read-only mode and deletion undoable.
- [x] Show each folded requirement as one row with a title, short summary and exceptional state only. Show source details in the menu and existing source records.
- [x] Open the existing generation parameter controls from parameter requirements for ordinary image/video prompts as well as setting images.
- [x] Remove the setting-image content's fixed `80ch` width that leaves most of the expanded editor empty.
- [x] Verify full selection/copy/delete/undo, source metadata and parameter controls with existing component/integration tests.
- [x] Use one isolated browser acceptance page with real components, long Chinese text and narrow/wide layouts; inspect screenshots, then remove fixtures and finish TaskSpace 17.
- [x] Run type/build/UI checks, record results and preserve unrelated work.
