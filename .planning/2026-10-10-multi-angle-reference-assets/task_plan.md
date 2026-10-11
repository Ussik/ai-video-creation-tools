# Multi-angle reference assets

## Goal
Commit/push the baseline first; then deliver independent visual reference assets, shot-specific choices and video inheritance in the existing canvas workflow.

## Phases
- [x] Validate and push all baseline changes (67c46a6, origin/main).
- [x] Audit profiles, frozen shot bindings, generation and reference manifest.
- [x] Implement revision/style-aware reference asset storage, approval, crop/generation workflows and shot snapshots.
- [x] Integrate existing profile inspector and shot binding editor; angle-based recommendations and video inheritance.
- [x] Verify requests, signatures, old-board compatibility, user control and actual UI; document results.

## Decisions
- Keep information boards as setup master assets; independent views stay inside profile management and do not create extra nodes automatically.
- Preserve user control: no billable generation without clicking Generate, no live database mutations in development, no automatic application of unreviewed views.
- All references must be tied to the same profile revision and project style. Frozen shot choices are retained; changed definitions need explicit refresh.
- Keep first-frame and multi-reference modes mutually exclusive; share actual references, purpose mapping, Skill context and request.
- First delivery covers reusable independent views and their shot/video path. Calculated 3D geometry and automated video drift detection remain later work.

## Errors
- Baseline sandboxed backend tests could not bind localhost; authorized rerun passed 299 tests.
- Initial read queried nonexistent backend/src/types.ts; actual shared backend types are in db.ts.
- An incomplete new asset fixture missed created_at; corrected it. The existing old-board edge regression exposed substitution by a current profile board; corrected independent-only node preference.
- Browser subtree snapshot was called with a selector instead of a snapshot ref; subsequent observation used the documented full snapshot. No app action failed.

## Final validation
- Frontend build passed and all 345 frontend tests passed.
- Backend build passed and all 322 backend tests passed using temporary databases and local provider mocks.
- Final repeated-image error handling was checked with 9 reference-asset tests; both builds passed again after the final changes.
- Browser QA passed in isolated TaskSpace 158: approval/default, crop drag, editable generation preview, outside-click dismissal, snapshot remove/recommend, and video manifest storyboard→side→face. No media generation was submitted; fixtures/server/TaskSpace cleaned up.
- Legacy RESTRICT→CASCADE migration retains style and ordered reference snapshots; project deletion cascades independent refs and source pointers.
- Git diff whitespace check passed. Baseline commit 67c46a6 is pushed; optimization changes intentionally remain local for review.
