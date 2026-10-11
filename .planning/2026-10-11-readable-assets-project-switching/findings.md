# Findings

- Asset cards currently use `asset.filename` directly. Generated files have UUID names for collision-free storage.
- Existing `ProjectDetail` already carries shots, jobs, visual profiles, confirmed/candidate board IDs and visual-reference labels. This can recover meaningful names for historical assets without changing media storage.
- `filterLibraryAssets` currently searches filenames, prompts and shot titles only.
- `App` has a project-ID-aware refresh hook and polls the active project. The current gallery opener always sends users to the canvas, so the header switcher needs a distinct handler that retains the current tab.
- Project-ID changes already clear selection, preview, candidate review, timeline preview and continuity. Verify request isolation before adding navigation.
- Confirmed all nine assets in the referenced hospital project have profile or shot associations in job requests, including an older candidate no longer present in the current candidate list.
- Added a shared presentation resolver, useful titles and generation specs in cards, search by those names, readable preview titles and original filename metadata. Canvas sidebar and new added asset nodes share the resolver.
- Optional read-only graph snapshots from all project canvases recover user-created node titles. Responses are canceled on workspace/project/data changes.
- Header uses Mantine searchable Select; switching preserves the active tab and asset subview while clearing old filters, selections, previews and project dialogs. Switching is disabled during mutations/downloads.
