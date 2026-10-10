# Findings
- Screenshot footer repeats 全剧人物设定 beside a button already labeled 生成全剧人物设定.
- Screenshot asset 祖传守夜信物 · 家纹灵光态 shows realistic metallic prop and photographed hands, while user says anime style was confirmed.
- ScriptGenerationOptions has visual_style stored in scripts.generation_options; record_story_decision can persist settings_patch. Confirm whether this actually happened.
- visualGenerationPrompt currently enforces object consistency but takes no global project style. shotImagePrompt/shotVideoPrompt return existing prompts directly without global style.

## Actual project evidence (direct SQLite read-only)
- Relevant project e2cfcaada78c459da077132f7d00f43e has genre “现代都市暗黑奇幻战斗（日漫风格剧场版）” but visual_style is an empty string.
- User first message explicitly requests a Japanese anime-style theatrical film. Saved story direction also mentions 日漫风格剧场版, so confirmed narrative is not missing entirely; it was not normalized into the visual_style setting.
- Profile 祖传守夜信物 / 家纹灵光态 defines worn brass, blue glow and palm scale, but neither definition nor view_requirements specifies visual medium.
- Succeeded job 617abc890a8e4cb7b78194bd53562233 (2026-10-08T17:49:02.643Z) prompt specifies board, physical materials, ratio/2K/quality/background with no anime constraint; reference_asset_ids=[] eliminates reference-image contamination for this specific job.
- Board builder uses definition/views only; analyze prompt passes story/docs/scenes but omits generation_options; final board request checks prefix, revision and references only. No universal project style compilation.
- prepareVisualGeneration exits when no shot/bindings and trusts prompt_is_final to skip rebuilding. It adds object consistency without style even otherwise.
- Project style absent from board/reference and shot visual signatures, so project style changes cannot invalidate these previews today.

## Tool trace corroboration
The historical record_story_decision call for 故事方向 persisted genre/era/core_hook only; it did not supply visual_style. This verifies the loss at semantic settings mapping, not only the current DB state. Current image model request template includes {{prompt}} with no static style keywords; no reference image was attached to the observed job.

## Control design
- Separate narrative genre from visual medium. Resolve original confirmed language semantically into project-level style with provenance, then use a versioned structured visual specification for medium, rendering, linework, palette and exclusions. Do not invent unconfirmed artistic specifics or hard-code anime globally.
- Function calling records/reads/updates the confirmed project specification; structured outputs keep fields and revision stable; prompts communicate those constraints to the creative/image/video model.
- Backend compiles the final style constraints for board, general asset, shot image, shot video and text-only generation even without bindings or when prompt_is_final/custom overrides are set. Use one compilation path for preview and submission and expose the actual final prompt. Preserve editable creative content separately from project requirements; detect/resolve contradictory local overrides rather than silently overwrite them.
- Skills advise methods/templates without overriding confirmed project facts. Scoped explicit creator overrides can change the style only for their declared scope; presets/defaults are suggestions.
- Mark reference purposes (identity/shape/layout/style/keyframe) and their style/revision/provenance. Realistic shape refs must not dictate rendering. Text cannot guarantee suppression of photographic reference influence; inspect pixels and use approved style anchors. Anime applies to every panel, hand, material sample and prop state, not only the main subject.
- Include style version in preview signatures and generation snapshots. Style changes invalidate stale previews and flag existing boards/shot inputs for review; keep historic assets/results rather than rewrite them or auto-regenerate paid tasks. Reload/history/duplicates/imports and retries preserve explicit version semantics.
- Provider adapters must forward actual compiled prompts; use separate negative_prompt only when documented/configured. Otherwise express exclusions in supported prompt text. Do not invent unsupported model capability limits, equate cinema lighting/realistic materials with photorealism, or treat ratio/2K/quality as medium controls.
- Validate outputs visually (human or pixel-capable vision model) before promoting boards to approved references. Text/schemas cannot guarantee image style. Videos require temporally consistent medium, including first/last frames and extensions; incompatible reference frames must be reviewed, not only overridden by text.
