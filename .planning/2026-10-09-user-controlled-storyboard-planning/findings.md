# Findings
- The current project has 3 scenes at 30 seconds, converted one-to-one into shots.
- Director canvas preparation implicitly runs visual_assets analysis; shot creation is deterministic and never uses storyboard skills.
- Legacy AI planning exists but its editor modal has no opening trigger and commits append shots.
- Skills are currently loaded by stage automatically; explicit request filtering is needed for this feature.
- Existing shot IDs are referenced by canvas, jobs, timeline, and visuals; do not delete on replanning.

- Existing project target shown in studio is a production range target, not scene timing. New planner exposes an explicit total target and validates allocation.
- Existing canvas prompts need explicit handoff updates when existing shot IDs are replanned, including video nodes.

- Browser mock QA confirms opening import performs no request; direct import calls only /canvas, and opening planning calls only /context.
- Selected outline/episode and one skill were submitted explicitly; 45-second target produced 6 editable shots across 3 scenes without a commit.
- Desktop styling and 390x640 viewport verified; preview scrolls and footer remains within viewport. Progress needed moving outside the scrolling form to remain visible during generation.

- Fixed progress visibility verified; browser confirmed edited image/video prompts and total45 in /commit, with canvas handoff only after explicit save.
- Existing schema limits each scene to30 seconds; the planner preserves this constraint, supports 2–8 suggested shots and validates summed timing. Documentation now describes controlled planning and model-free import accurately.
