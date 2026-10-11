# Progress

## 2026-10-10
- User authorized applying the guide recommendations.
- Initialized and pinned this task's isolated planning directory.
- Completed code/test discovery; no relevant memory guidance found for Seedance.
- Implementation pending; existing unrelated working-tree changes preserved.

- Implemented model dialect detection, 2.0 refinement guidance, explicit target-config validation, consistent subject names and face-first recommendations.
- Added regression tests and workflow docs. Existing Mini configuration patch is pending validation.
- First focused run: newly added Seedance tests pass; two existing video-reference-generation assertions fail on optional excluded profile text. Investigating against the pre-task behavior before changing unrelated code.

- Backend focused suite: 45/47 pass. The two existing video-reference-generation tests about optional excluded profile text also fail with the pre-task visual-prompt and recommendation logic, confirmed in an isolated temporary source copy. The copy was removed. No unrelated server filtering was changed.
- Frontend focused suite: 40/40 pass (canvas-visual-management, manifest, panel, actual composer integration).
- Backend TypeScript build and frontend production build passed. Frontend emits its existing bundle-size advisory.
- Current enabled Mini model configured through the local app API: only max_reference_images changed from absent to 9; all other settings exactly preserved, including video reference template and edit/extend modes. Recorded model-config-change.json.
- Read actual installed rules and current Mini configuration without making external requests: seedance-2.0.md loads, seedance-2.5.md does not, 9 images allowed and 10 rejected.
- git diff --check passed. No paid media or text generation performed; no commits or pushes.

- Final source verification after review: 14/14 Seedance + skill tests pass; backend build passes. Kept 2.5 reference matching unchanged and replaced example person names in built-in rules with current-project role labels. Task complete.
