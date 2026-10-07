# Visual Profile Preparation

## Objective
After pushing the existing work, add reusable character/location/prop visual profiles containing written specifications and detailed reference boards; bind them to scenes and shots and carry them into generation.

## Phases
1. [complete] Verify, commit and push the previous changes (c8cac2a).
2. [complete] Define profile persistence, preparation endpoints and generation contracts.
3. [complete] Add preparation UI and connect director handoff and canvas generation.
4. [complete] Test migrations, profile selection, dependency handling and real browser workflows.

## Decisions
- Reuse asset task generation jobs; store profiles and explicit scene/shot bindings separately.
- Treat written specifications as authoritative alongside reference boards, one object/variant per profile.
- Joining the canvas creates work only; generation is explicit and required missing references cannot be silently ignored.
- Model extraction is explicit, reviewable and never saves model-created profiles without user confirmation.
- Do not alter real project data or submit paid generation during verification.

## Errors
- None during baseline verification.
- Initial feature builds found missing table typing and mismatched parameter-helper imports; corrected before verification.
- Profile PATCH inherited a Zod default for variant and changed it during board confirmation; fixed with an optional field without a default. All five targeted tests pass.
- Temporary browser fixture initially used a named createRoot import from Vite's CommonJS wrapper; corrected to the default import. Ambiguous dropdown selectors and a stale selection after HMR were resolved using observed CSS selectors and current page state.
- Sandbox curl/ps could not inspect host services; used lsof and browser-side read-only fetch. Closed the extra Vite instance and reused the existing 5173 service.

## Final Verification
- Baseline c8cac2a confirmed on GitHub origin/main with git ls-remote.
- Backend: 97 tests pass, including six visual-profile tests and a local mock-provider end-to-end request check.
- Frontend: 121 tests pass. Both production builds pass; existing Vite chunk-size warning remains.
- Browser TaskSpace 79 finished once. Desktop and 390x844 screenshots checked; mobile footer remains visible and editors scroll internally.
- Confirmed draft review/save, selectable board ratio, board generation review without submission, canvas preview including board thumbnail/specification, and higher-layer delete dialog.
- Live visual profile API returns 200. No real project writes or paid model requests were used for verification.
- Temporary browser fixture removed. New visual profile feature changes remain uncommitted as the requested checkpoint preceded this work.
