# Findings

- Current frontend and backend enforce exactly one image in first_frame mode; handoff creates first_frame + keyframe video nodes.
- Official tutorial URL is public without login. It links to the video creation API and Seedance 2.0 prompt guide. Tutorial last updated 2026-09-29.
- Tutorial also flags frame jumping from mismatched input/output dimensions and recommends compatible input dimensions and adaptive ratio. Need consider this separately from reference consistency.

- Tutorial full-modal example submits every picture as role=reference_image, up to 9 images, 3 videos and 3 audios. It explicitly suggests prompt-specified first/last images for an indirect first/last+reference effect; strict first/last consistency should use first_frame/last_frame instead.
- Prompt references must use media type plus one-based ordinal in same-type request order, e.g. 图片1; Asset IDs are not supported as prompt references.
- Frontend audit confirms same-shot visual bindings remain available but handoff only creates one source edge. Switching a default/first-frame target removes other image input edges.

- Current reference/profile path already appends confirmed same-shot boards and writes object definitions with ordinal mapping, but current handoff does not select it. Existing visualGenerationPrompt excludes board layouts, text, labels and swatches; extend this with dedicated storyboard/identity purposes rather than blindly inheriting all upstream edges.
- API reference page was updated 2026-10-08 and now shows Seedance 2.5 in examples. Avoid incorrectly applying 2.5-specific limits to 2.0. Content parameter details are collapsed; tutorial remains the verified 2.0 source for 9-image limit and role guidance.

- API role details explicitly confirm first-frame, first/last-frame, and full-modal reference are three mutually exclusive scenarios and cannot be mixed. Full-modal requires role=reference_image on every picture. Prompt-selected first/last images are indirect guidance, not a strict frame constraint.
- Therefore recommended workflow must expose multi-reference consistency vs strict first-frame as two strategies, not a fabricated first_frame+reference_image combination.

- Official image input constraints: 2.0 full-modal 1-9 images (2.5 has 1-30, do not conflate); width/height each 300-6000px, aspect 0.4-2.5, each image <30MB, whole request <=64MB. URL, correctly formatted Data URL and asset:// identifiers are supported image sources. Current local 20MB cap is conservative, but total Base64 request size is not model-aware.
- Prompt guide recommends explicit subjects identified by 2-3 stable features, referencing 图片N according to actual content order, avoiding conflicting identity/traits. Action, environment, lighting, camera, style and constraints should remain explicit.

## Proposed design
- On models explicitly configured for multi-reference (Seedance 2.0), default storyboard handoff with bound visuals to reference/profiles; retain a clearly selectable strict-first-frame/keyframe strategy. No invented hybrid role.
- Resolve the selected storyboard image plus only this shot's bound, approved visual boards, preserving shot snapshots/revisions, style checks and manual references. Deduplicate IDs and keep stable one-based order. Source image is composition/opening-state guidance, boards are identity/structure/detail guidance. All pictures use API reference_image role for full-modal mode.
- Expose actual submitted images grouped by purpose on video node, with preview, locate, remove optional references; use existing missing-reference resolution for mandatory images. Existing video connections should gain the same workflow without wiping explicit mode, manual prompt, history or geometry.
- Build one manifest consumed by UI, prompt draft/selected video skill, generation review and provider request. Lock source picture ordinal and map named objects to official 图片N syntax. Editing prose must not desynchronize actual references. Skill remains user-triggered.
- Explicitly prohibit copying information-board panels, labels, swatches, extra subjects or reference static poses into the video. Opening composition comes from storyboard; identity/clothing/detail from correct board variant; movement/camera from shot's independent video prompt. Resolve visual conflicts visibly rather than mixing contradictory references.
- Add model-specific role/quantity/format/dimension/total request-size and template-consumption validation. For 2.0 count includes the storyboard picture, leaving up to 8 further boards. Do not silently drop pictures or submit an invalid first_frame+reference_image mixture.
- Keep ratio selection user-controlled; strict first frame can suggest adaptive or require explicit compatible resize/crop when actual dimensions differ. Monitor that generated source picture actually matches claimed ratio. More references improve conditioning, not a guarantee against temporal instability; excessive motion/occlusion/conflicts still need separate handling.

## Implementation verification
- Follow-up professional consistency research (read-only): Seedance prompt guide explicitly recommends independent face close-ups, separating face identity from full-body costume reference. It warns that combining face/pose/clothing/detail in one information board makes faces too small and raises reference errors, and recommends single-person independent reference pictures to reduce duplicated characters. Separate multi-angle reference pictures are also supported; distinguish them from a multi-view collage. Scene geometry and cross-shot continuity need their own controls, not just more character boards.
- Current app has versioned profiles and shot snapshots, shot image/video prompts and start/end state, plus human cut/first-last frame review. Each approved profile currently has one full board image; it lacks named independent view assets/crop regions, calculated scene geometry, pose/depth trajectories and actual video identity-drift analysis. No code changes were authorized for this explanatory follow-up.
- Follow-up UI audit: upper multi-reference/first-frame buttons and bottom mode menu already call the same changeVideoMode function. They are duplicate controls, not independent settings. Consolidation can remove the upper card while retaining shared reference/prompt behavior. Bottom menu must lock during generation, carry short descriptions and use the same labels in generation information.
- Implemented one ordered manifest across frontend and backend, with strict-frame separation and optional-exclusion mapping. Existing video nodes can select multi-reference explicitly; their saved strategy and prose remain intact.
- Model capability derives from supported_modes plus consumed multi-image variables in the effective template. Seedance 2.0 media rules activate only through an explicit profile setting. Current enabled video config is already multi-image capable; no migration or live configuration changes were required.
- Builds, mock provider/API regression and local browser QA verify behavior and payload construction. No real generation was used, so temporal quality must still be assessed on generated samples.

## Documentation sources
- https://console.volcengine.com/ark/region:cn-beijing/docs/ark/seedance-2-0?lang=zh
- https://ark.volcengine.com/region:cn-beijing/docs/ark/create-video-generation-task-api
- https://console.volcengine.com/ark/region:cn-beijing/docs/ark/seedance-2-0-prompt-guide?lang=zh
