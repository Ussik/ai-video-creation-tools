# Findings

- Official 2.0 series tutorial lists doubao-seedance-2-0-mini-260615 and confirms broadly shared prompt features across 2.0/Fast/Mini.
- Official guide supports 图片N and explicit subject definitions; @ is optional. Exact timestamps are unreliable rather than universally unsupported.
- Person face + full-body independent images should be preferred to multi-view boards; independent angles remain supported. Select only relevant references, not the whole asset library.
- Existing relevantReference regex only accepts seedance-2.0/Seedance 2.0 and misses current Mini ID. Main skill and common timing/continuity references are already present.
- Current Mini model has no explicit max_reference_images or video_reference_profile. It has video_reference_template and edit/extend configured; applying the full image-only preset would remove those controls.
- Existing recommendation outputs [body angle, face] and can fall back to a board despite approved independent pictures without a default. Saved selections are frozen and should remain unchanged.
- Existing refinement reads actual image binding metadata but does not inspect pixels; no actual video/audio reference context is passed. Do not invent visual traits or multimedia bindings.
- Existing worktree contains extensive unrelated changes. Changes for this task must remain narrow.

## Sources
- https://console.volcengine.com/ark/region:cn-beijing/docs/ark/seedance-2-0-prompt-guide?lang=zh (reviewed 2026-10-10, updated 2026-09-22)
- https://console.volcengine.com/ark/region:cn-beijing/docs/ark/seedance-2-0?lang=zh
- backend/src/skills.ts, skill-routes.ts, visual-reference-selection.ts, video-reference-config.ts
