# Asset batch download

## Goal
Fix the asset library bulk download that downloads only one file and then appears unresponsive. Download multiple assets as one ZIP, preserve single-file downloads, and expose file errors before starting.

## Phases
- [complete] Trace routes, reproduce current browser behavior and select a streaming archive implementation.
- [complete] Implement one download per user click with loading and meaningful errors.
- [complete] Verify archive contents, single files, failures, browser download and builds.

## Constraints
- Preserve all unrelated working-tree changes and the shared active-plan pointer.
- No generation, refinement, commit or push requested.
- Use ego-browser TaskSpace 17 throughout this goal (finished).
- This task owns only this plan directory.

## Errors
- Initial batched source output exceeded the combined output limit. Re-read the relevant source in smaller bounded chunks.
- Default npm registry installation failed on sandbox DNS resolution. Installed yazl and types through the official npm registry with approved network access and a task-local temporary cache.
- Canvas overlay intercepts folded sidebar pointer actions; the already-identified assets button's DOM click opens the asset page. No canvas changes needed for this download task.
- Backend build found outdated yazl declarations: outputStream lacks destroy/destroyed, end callback omits size and EndOptions requires fields. Verified installed implementation/docs, narrowed the actual PassThrough and supplied explicit end options with an optional callback argument.
- Video selection checkboxes are hidden until card hover; hovered the known preview card before clicking instead of repeating the hidden-input action. Exact text selector did not match Mantine's wrapped button text; used the verified accessible role/name.
- Host Python lacks hashlib.file_digest; used explicit chunked SHA-256 hashing with standard hashlib, then validated both archives and the original MP4.
