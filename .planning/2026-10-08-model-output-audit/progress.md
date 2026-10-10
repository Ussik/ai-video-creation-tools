# Progress

- Started read-only audit after the user asked whether the displayed options are prompt controlled and which features fit structured output vs Function Calling.
- Found current native ask_creator and legacy replies/classify paths; generic text outputs currently use prompt JSON plus local schema parsing.
- Audited director native/legacy flows, reply recognition, authorization verification, standalone document/script generation, shot planning, visual profile analysis, theme mapping, continuity analysis, Skill prompt refinement and media-job generation.
- Confirmed native tool transport uses actual tool_calls/function_call with tool_choice:auto and strict:false; no unified per-task provider JSON Schema output adapter is currently present. Templates may still carry user-configured response fields.
- Found native stage prompts reuse workflowInstructions' legacy JSON-only output instructions; documented as a protocol conflict to address before broad migration.
- Ran a pure local recognition probe, without model calls: the same plain-text question has one recognition candidate without a classification, and zero candidates after native frontend defaulting to other. Documented the missed-interaction risk and kept current behavior unchanged during the audit.
- Completed source-backed recommendations and prioritized native interaction completeness, protocol separation and shared structured output support. No implementation changes, tests requiring model calls, database edits, commits or push performed.
- User expanded this audit to all current project features. Continuing the same plan; timeout/UI changes from the intervening request are preserved (3-minute idle, 20-minute provider, 30-minute dialogue).
- Expanded inspection to all model call sites and frontend consumers, including legacy visual-focus dialogue, raw bilingual asset prompt consumption, canvas text/media generation, board prompts/references, fixed image-to-video handoff, candidates/frames, timeline editing/export, Skill catalog/injection and provider/model configuration.
- Added a complete Chinese report at report.zh-CN.md with mechanism responsibilities, 38 functional areas, source links, concrete issues, priorities and three combined workflows. Only report/planning documents changed during the expanded audit; no paid model call or user-project mutation.
- Final cross-check included custom theme-cover semantic mapping and verified source-file links and line bounds. Existing workspace diff passed git diff --check. No business-code changes or live model tests were needed for this audit.
