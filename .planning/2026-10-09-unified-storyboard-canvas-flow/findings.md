# Findings

- Existing split entry exposed direct scene import; `/storyboard/canvas` mode=scene creates one shot for every missing scene with copied prompts.
- Planner can currently commit and hand off to canvas, but its long stacked form hides configuration and review below multiple lists.
- Director and ScriptEditor have two entries; studio has one planning entry. Asset imports are unrelated.
- Planning and commit accept at most 10 scenes per batch. The new sidebar must explicitly state range and show all scenes so 24 scenes do not silently appear fully selected.
- Existing shots alone do not prove model planning: legacy direct imports may also have shots.
