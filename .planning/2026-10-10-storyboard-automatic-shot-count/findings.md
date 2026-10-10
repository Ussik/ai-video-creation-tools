# Findings

- Active workflow uses StoryboardPlanner and /script/storyboard/plan. Frontend initializes and resets count to 3, coerces blank to 0 and disables planning for blanks.
- Backend planning schema defaults omitted counts to 3, then always embeds a numeric suggestion into the task prompt.
- Result schema already allows per-scene 1–30 shots and 1–30 s scene durations; every shot must be at least 1 s and sum to the scene duration. Existing shot IDs must be retained when replanning.
- Automatic mode will omit shots_per_scene, default the visible field to blank, and explicitly ask for per-scene analysis. Numeric suggestion range remains 2–8.
- Legacy ScriptEditor AI split modal has no opening action; leave that retired workflow unchanged.
