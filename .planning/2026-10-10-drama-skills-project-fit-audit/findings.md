# Findings

- Repo exposes 11 skills under skills/. Metadata: MIT, 2686 stars, 572 forks at inspection.
- App's read-only data/studio.db lists five installed/enabled skills: short-drama-write, assets, image-prompts, storyboard, video-prompts; revision c2426e03c0e7722bebcc6a488b6658dc38c65ac3.
- App supports five binding stages only: script, visual_assets, image_prompt, storyboard, video_prompt.
- App imports Markdown/text references but excludes scripts and does not execute external CLI workflows. Current code already offers structured review/revision, visual references, shot planning and ffmpeg timeline/export.
- Repository describes filesystem Markdown as canonical project state; our app uses database and versioned drafts, so orchestration/production/edit skills require adaptation.

- Remote main is c2426e03c0e7722bebcc6a488b6658dc38c65ac3, identical to all five installed skill revisions. No update needed for those five.
- Read develop/review: develop adds story engine, distinct directions, per-episode state handoffs, serial character memory, adaptation boundary and genre craft. Review adds evidence-backed cross-document continuity/visual motion findings and anti-template repair, rather than manual approve/reject media status.
- Loader maps file workflows to app data and explicitly does not run scripts, install tools or override JSON contracts. Reference selection automatically includes stage-contract/review/continuity/performance-action files and selected asset/model files, but not all development/adaptation rubrics.
- Skill bindings suggest script for develop, but novel-analyze/review/edit/produce/core have no suggested stage; review needs deliberate invocation/binding to avoid replacing writing behavior.

- All 11 text bundles fit current importer limits. develop: 32 files / 271303 bytes; review: 14 / 91605; novel-analyze: 7 / 51965. Full external workflows remain unsupported.
- Recommended develop + review; conditional novel-analyze; edit valuable for later coded integration; produce/core overlap app runtime and should not be added as ordinary creation rules.
