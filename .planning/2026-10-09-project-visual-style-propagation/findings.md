# Findings
- Existing settings include freeform visual_style; record_story_decision accepts it but mapping prompt is incomplete.
- Existing project confirms 日漫 in genre/story decision, visual_style empty; fallback must carry confirmed raw context safely, not globally default to anime.
- final image/board routes are separate, both must compile style; prompt_is_final must not skip style. Preview and enqueue must agree and use current version.
- Canvas manual prompt rebase requires replacing generated style block without dropping creative edits.

- Implemented pure shared style contract/compiler, structured visual_style_details and read/set functions with version and source validation. Existing project fallback copies confirmed context verbatim; interpretation remains semantic, no anime default.
- All generation paths now compile style and snapshot a version; provider request templates that drop {{prompt}} are rejected before enqueuing.
- Added style confirmation version to profiles and shot binding snapshots with idempotent migration. Stale confirmed boards require reapproval; shot snapshots explicitly refresh.
- Canvas re-enforces generated style block while preserving manually edited prose. UI reports inherited style and reference warnings, and candidate dialog allows re-confirming the same asset.
- Actual ProjectCanvas browser QA exposed that approval revisions cleared manual profile prompt overrides. Candidate approval now adopts the returned revision without dropping creative edits; changes to the definition still use existing revision synchronization.
- Unrelated story decisions previously merged stale client style into persisted settings. Confirmed style now stays authoritative; unsaved preferences may remain in legacy discussion context but are not persisted by an unrelated tool write.
- A saved decision may normalize legacy style only before a dedicated canonical style exists; subsequent changes require a current creator confirmation/delegation message and expected version.
- Request-template regressions cover the effective mode-specific template, direct prompt forwarding, and content_template forwarding; no invented provider negative_prompt field.
- Browser verified edited profile text reaches board-preview, one managed style block remains, stale-style candidate confirmation sends expected_style_version and removes the stale indicator, and manual prompt survives confirmation.
- Historic media is not redrawn. Style propagation is a real prompt/request contract with manual reference review, not automatic pixel-level QC or guaranteed provider compliance.
