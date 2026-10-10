# Findings
- Both chat buttons currently open VisualPreparation. Its Continue callback creates shot records only; a populated canvas does not automatically import them.
- Visual analysis already uses structured output, all project script artifacts, selected scenes and canonical project visual style. Save endpoint reuses exact kind/name/version but has no definition draft marker.
- Canvas mutations must use changeGraph/current queue; server-side replacing a graph could destroy unsaved node movement/editing.
- Reference lines currently derive only from approved boards. This flow needs explicit profile-to-shot edges even before boards exist, with existing missing-reference logic blocking generation until confirmed.
- Existing unrelated uncommitted changes and completed search work must be preserved; no push requested.

- Direct chat action now uses selected text model and existing visual_assets Skill/structured-output path. Missing profiles are saved as editable drafts; no image jobs are enqueued.
- Prepared-scene fingerprints make retry and partial batch continuation idempotent; source signatures guard concurrent edits. Existing profile definitions and completed shot snapshots stay intact.
- Browser failure test exposed retry banner hidden by the sidebar. Added a scoped, centered error banner above controls; actual click retry saved 5 unique nodes and 3 derived reference lines.
