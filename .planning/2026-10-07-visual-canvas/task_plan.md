# Visual Profile Canvas

## Objective
After pushing checkpoint 8672197, move visual board generation into the project canvas with profile-backed nodes, image reference edges, candidate review and explicit confirmation.

## Phases
1. [complete] Verify and push all existing changes.
2. [complete] Define persisted profile node identity and board generation contracts.
3. [complete] Add profile sidebar, node rendering, canvas generation and profile inspector.
4. [complete] Validate persistence, reference behavior, no duplicate nodes/shots, and desktop/mobile UI.
5. [complete] Separate dragging from editor opening and add discoverable visual candidate management with persistent archive/restore.
6. [complete] Separate sidebar profile inspection from explicit add/locate/reference actions.
7. [complete] Keep magnetic connection initiation outside node content and preserve direct port connections.
8. [complete] Diagnose generated aspect-ratio mismatch using real stored requests and local image dimensions, retain explicit ratio instructions in the submitted prompt, and verify request handling.
9. [complete] Avoid sidebar overlap with bottom utility, toggle and creation controls across desktop and small screens.
10. [complete] Automatically dismiss canvas notices after three seconds, restarting the timer for each new notice.
11. [complete] Keep candidate-management and approval buttons adjacent.
12. [complete] Submit canvas generation directly and expose request details through a read-only information popover.
13. [complete] Unify the visual-setting button and reference-mode selector with compact dark canvas controls and shared custom dropdown menus.
14. [complete] Configure RightAPI image references using the supplied documentation, support its asynchronous image workflow, and clarify configuration errors.
15. [complete] Expand the node composer into a centered modal, switch to a shrink icon, and preserve edits when returning to the canvas.
16. [complete] Dismiss generation parameters when clicking outside the popup, including canvas controls that stop event bubbling.
17. [complete] Match the generation information popover to the neutral canvas theme and keep long details readable.
18. [complete] Automatically show reference connections to existing canvas nodes from exact shot board snapshots, preserving manual inputs and enabling binding management.
19. [complete] Make missing required reference boards actionable: locate/reuse or add their profile nodes, distinguish generation from approval/version updates, and return to the original target.
20. [complete] Analyze image-to-video handoff and complete editable prompt synchronization from the supplied screenshots; document current gaps and the recommended design.
21. [complete] Default image parameters to standard quality, 2K, auto background, 9:16 and one candidate; enable atomic 1/2/4 profile candidate generation on the same node and verify candidate history.
22. [complete] Add persisted image/video shot prompts and a same-shot image-to-video handoff with a pinned selected frame, compatible video model and keyframe visual mode.
23. [complete] Show the complete prepared prompt in the editable composer, synchronize generation information/submission and preserve edits when parameters or references change without duplicate automatic sections.
24. [complete] Verify persistence, candidate/frame isolation, repeat actions, model/mode validation, prompt synchronization and the full browser workflow with isolated data.
25. [complete] Remove fixed-frame whitespace from generation information reference thumbnails, preserve full image proportions and validate wrapping on narrow screens.
26. [complete] Remove the generation-info close button and dismiss on outside capture-phase presses across event-stopping canvas/composer controls.
27. [complete] Keep canvas zoom, pan and node dimensions unchanged when opening/resizing the composer; fit only the editor into the visible canvas area and verify repeat opening, modal return and narrow screens.
28. [complete] Support dragging a completed storyboard image to an existing video generator, normalize reversed image/video drags, prepare the frame/mode/model/shot prompt and verify persistence and no duplicate nodes.
29. [complete] Add a compact task information icon to every job row, show complete errors and stored generation details in a themed scrollable popover, and verify dismissal/readability across task statuses and narrow screens.

30. [complete] Place all newly inserted canvas nodes in the nearest free space with a shared collision-aware placement step, preserving existing nodes, manual dragging and history; verify batch insertion and common creation paths.

## Decisions
- Reuse the generation node type with a dedicated visual_profile_id setting and profile-specific behavior; no fake shots.
- A profile is authoritative; canvas removal only removes presentation.
- Board generation results update the same node, with approved images retained until explicit confirmation.
- References resolve confirmed profile boards and are validated again on submission.
- Reuse the existing dark neutral canvas style and parameter controls.
- No paid model calls or writes to actual project data during QA.

## Errors
- A follow-up patch contained an empty hunk; verification rejected it before edits. Removed the hunk and applied the patch successfully.
- Baseline backend tests were blocked by sandbox port permissions; rerun on host passed 103 tests.
- Baseline Git index write was blocked by sandbox permissions; approved host git commit/push completed.
- Intermediate web build found unused UI state while rendering was incomplete; resolved by connecting sidebar/composer/inspector.
- An apply_patch context did not match duplicateSelection; split the patch and used the actual function signature.
- Browser hot reload reset selection; recovered by selecting the existing node in the same TaskSpace.
- Image/video implementation: corrected a false-or-Asset TypeScript expression, a test assuming 1080p instead of the configured 720p default, and an outdated keyframe missing-board expectation. All affected checks now pass.
- Browser TaskSpace 106 hot reload reset selection; inspected the live graph and reselected the saved video node rather than creating another space.
- Small screens exposed a sidebar/composer overlap; profile selection now collapses the sidebar and uses compact model controls.
