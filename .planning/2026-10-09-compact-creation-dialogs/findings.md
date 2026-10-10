# Findings

- Storyboard modal is 1080×780 desktop with 280px sidebar and generous 24px content padding. A reduction to 940×680 with a 240px sidebar and smaller spacing can keep readable controls.
- Prompt refinement dialog is currently 780px wide with a long introduction and full-width plain skill trigger. It supports editable results, stale content detection, abort on close and explicit apply; these behaviours should stay intact.
- New planner skill-card pattern can be applied to image/video prompt configuration using stage-specific labels; avoid reusing hardcoded storyboard wording.
