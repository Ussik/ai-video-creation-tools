# Storyboard Repair Scope Completeness Implementation Plan

**Goal:** Resolve omitted contradictory fields before the one permitted storyboard content repair.

**Architecture:** Add an independent bounded scope review before the existing exact field patch. Program-owned field keys, exact quotes, original issue identity and local shot bounds constrain additions. Persist accepted scope in the existing planning steps, keeping current budgets, final recheck and save gates.

**Tech Stack:** TypeScript, Zod, existing LangGraph planning and provider observation.

**Spec:** ../specs/2026-11-13-storyboard-repair-scope-completeness.md

## Global Constraints

Keep selected Claude/model configuration, source, existing request accounting and single automatic content patch. Never mechanically modify correct comparison evidence or authorize audio, identity, order or duration via scope completion. No new persistence/retry layer.

## Review Focus

False quotes, additions to a different issue/shot, stale or corrupt audit checkpoints, cancellation before patch, and needs_work/inconclusive cannot authorize save.

### Task 1: Evidence-bounded scope review

- [x] Add failing retained-defect and adversarial tests in backend/test/storyboard-repair-scope-review.test.ts.
- [x] Implement storyboard-repair-scope-review.ts with program-owned editable field inventory, complete coverage, exact additions, checkpoint validation and no content-quality pass.
- [x] Add stage label and strengthen first-review same-defect field consistency instruction.

### Task 2: Integrate repair and recovery

- [x] Wire scope review before automatic and explicit exact repair in storyboard-planning.ts.
- [x] Preserve existing repair-history limits, candidate retention, final independent recheck and original budget accounting.
- [x] Update integration fixtures and assert omission repaired in one patch; run focused regressions and independent review.

### Task 3: Real validation and delivery

- [x] Build sequentially; exercise retained failing Claude candidate with same configuration, no full generation replay.
- [x] Verify resolved quality, preservation, save/replay and Langfuse stage; remaining source omission was explicitly corrected, re-reviewed and saved.
- [x] Document actual results, stop own8002 service; deliver reviewed changes by commit/push on current branch.

Automatic evidence: scope helper23/23, integration38/38, full backend3419/3419. Independent review repaired source-backed warning validation and no-dispatch budget-resume consumption; both re-reviewed closed.

Real contact-defect path: same Claude original failed candidate, scope completion added missing prompt, one content patch and full review passed; two shots saved and commit replay created0. Independent manual source inspection found inherited fold-before-press omission; minimal two-field authored edit is undergoing a separate genuine review, preserving that manual boundary. All failed scope/source review attempts remain in the report.

Final same-model source-complete candidate passed0issues in37.97s/1call; actual update2shots created0 and idempotent replay created0 confirmed. Total14real dispatches include all failed stages and manual source correction. Final evidence: docs/storyboard-repair-scope-completeness-2026-11-13.md. Temporary8002stopped.
