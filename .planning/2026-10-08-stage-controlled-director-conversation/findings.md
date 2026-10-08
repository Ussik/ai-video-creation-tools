# Findings

- Saved workflowProgress already picks earliest missing outline/characters/locations/props then first missing episode.
- Quick replies are programmatic, but direct JSON questions bypass classification and natural-language classifier knows only content and answer state, not stage/action.
- Intent coordinator permits explicit button/text workflow; ordinary discussion only has soft guidance.
- Structured choice JSON is rendered directly; currently no semantic stage gate.
- Only episode_preparation has a progress guard; historical adoption buttons appear on recognized episode text regardless of prerequisites.
- Skill rules wrap base script prompts; keep wrapper and append application stage contract in base request.

- Implemented typed per-message stage_context stored separately in script_messages; progress_key freezes saved-stage progress and invalidates previous overrides after saves.
- Discussion intent may explicitly choose a stage; default draft intent now requires the current stage unless user authorization is explicit.
- Interactions carry stage + purpose (setting/generate/revise); stage means the formal document served, so plot-related character questions remain allowed in outline.
- Structured and recognized replies both use the same front-end gate; question groups keep allowed setting items, document actions use verified generation buttons.
- Single-question answers now use the same discussion-only envelope as grouped answers and skips.

- Added end-to-end mock-provider regression combining actual backend replies with front-end gates (both streaming and nonstreaming).
- Stage intent defaults to continuation authorization: model-targeted wrong stage is rejected before writer invocation. Explicit text/button requests still generate typed drafts.
- Verified staged schema changes preserve Skill injection and saved artifacts; tests cover fresh projects, preexisting characters, explicit scope persistence/cache, pending draft restrictions and complete stage sequence.

- Recognition v8 cache keys include frozen per-message scope. Raw negative reclassification takes precedence over direct generation action metadata.
- Controlled classification requires pending-question stage tags; incomplete cached results are repaired, missing new tags fail with existing visible recognition/retry UI. Legacy API callers remain backwards compatible.

- Final focused verification passed: backend 54/54, frontend 43/43, with both package builds and clean whitespace checks. Earlier full regression passed backend 142/142 and frontend 182/182.
- Final review confirmed that saved progress, generation authorization, question responses and document buttons use the same stage policy; enabled Skill wrapping remains present. Free-form text and semantic labels still depend on model interpretation, so guarantees concern validated actions rather than every sentence of prose.
