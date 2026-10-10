# Storyboard canvas re-add

## Goal
Allow saved storyboards to be selected and re-added after their canvas nodes are deleted, preserving existing plans and media while avoiding duplicates.

## Phases
- [x] Audit planner batch selection, backend saved state and canvas removal/import.
- [x] Expose per-scene canvas coverage and prioritize saved scenes with missing nodes.
- [x] Add explicit batch selection controls and missing-node status in planner.
- [x] Recreate missing image nodes with saved image assets while preserving surviving nodes.
- [x] Verify deletion/reimport, batch selection, saved media and builds.

## Constraints
Preserve earlier local edits. No real models or project mutations in testing. Saved plan reuse must not request replanning. Existing nodes keep their edits, geometry and media. Selected video must never be restored as an image-node asset.
