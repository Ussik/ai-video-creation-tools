# Video resolution and aspect controls

## Goal
Default new video nodes to 480p, provide Auto/16:9/4:3/1:1/3:4/9:16/21:9 and 480p/720p/1080p/4K options matching the user reference, and send selected values unchanged.

## Phases
- [x] Audit video parameter UI, defaults, requests and provider overrides.
- [x] Share video choices between frontend/backend and make 480p the video-node default.
- [x] Expose full controls for video modes and preserve explicit selections in submission and handoff.
- [x] Prevent per-mode defaults from overriding user-selected ratio/resolution; keep other mode constraints.
- [x] Verify selector interactions, parameter propagation, defaults/handoff, builds and visual layout.

## Constraints
Preserve existing node choices and unrelated edits. Do not modify live DB or call real generation. UI choices do not claim provider capability; provider errors must propagate without silent downgrade. Image controls and video duration/audio constraints remain intact.
