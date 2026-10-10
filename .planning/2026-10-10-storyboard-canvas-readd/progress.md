# Progress

- Root owns planner UI and tests; independent canvas and backend audits completed without edits.
- Verified blocking batch-selection root cause and secondary restored-image omission.

- Backend metadata now returns distinct image-generation canvas shot coverage without altering creative signatures. Persist/delete/reimport regression15/15backend tests and build passed.
- Planner selects missing saved nodes first, shows待加入/待补齐/已加入, and provides已规划/待规划/清空选择 batch controls. Selected saved scenes enter reuse preview.
- Fresh missing shot nodes restore valid selected images via detail.assets; existing nodes/media/edits/positions remain intact. Helper14/14tests passed.

- Final frontend suite31/31passed across planner, import helper and script-canvas preparation. Covers24-scene batch switching and model-free restoration after deletion.
- Combined verification46/46targeted tests, both production builds and git diff --check passed. No real project/model calls. README updated with re-add steps.
