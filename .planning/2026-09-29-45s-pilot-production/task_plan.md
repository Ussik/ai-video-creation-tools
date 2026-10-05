# 45-Second Pilot Production

## Goal
Use the existing UI to create a complete original story and produce only its opening, about 45 seconds, with configured models. Record actual workflow gaps and prioritize improvements toward a mature AI video studio.

## Constraints
- Use Ego Lite for application actions; do not call provider APIs directly.
- Keep the opening video around 45 seconds and avoid extra candidate generations unless a clear defect requires a retry.
- Preserve existing projects and model configurations.
- Do not start or stop the already-running 5173 and 8000 services.

## Phases
1. [x] Inspect active models, video limits, and current workspace.
2. [x] Create the project and a complete script; identify the first roughly 45 seconds.
3. [x] Plan and create only opening shots, with varied durations and continuity states.
4. [x] Produce and review the opening video through the UI; export if complete.
5. [x] Summarize quality and cost observations; prioritize missing features.

## Production Decision
- Keep the entire plot in the script and use the production range to select the part being made. This trial created only the seven opening shots and generated one candidate per video shot, keeping billable video duration at 45 seconds.
