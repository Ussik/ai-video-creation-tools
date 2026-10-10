# Findings & Decisions

## Requirements
-

## Research Findings
-

## Technical Decisions
| Decision | Rationale |
|----------|-----------|

## Issues Encountered
| Issue | Resolution |
|-------|------------|

## Resources
-
# Search findings

- Screenshot shows the full-page ScriptEditor; standalone and episode documents mount only when selected.
- Draft artifacts contain current unsaved text and optional rich JSON, so search must index the draft rather than API data or the visible DOM.
- Story subdocuments, standalone characters/locations/props, and numbered episode scripts cover the directory scope. Non-numbered episode_script is shown only when it has content.
- RichArtifactEditor uses textEditorExtensions and Markdown parsing; matches must use the same resolved document and schema.
- Existing navigation hook locks the selected directory entry until scrolling finishes; match navigation should reuse that mechanism with a target selector.
- Existing unrelated changes remain untouched. No commit/push is requested.
- Actual desktop browser validated visible highlighting and cross-document directory selection. Search doesn't set the saved document dirty.
- Narrow-window QA exposed inherited legacy mobile styles wrapping the fixed-height toolbar and page scrolling hiding its sticky header. Mobile overrides now keep actions in one row, pin the toolbar and search panel, and show the directory as a readable block.
