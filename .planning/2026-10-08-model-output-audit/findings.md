# Findings

- Screenshot shows a question choice panel and the old pair of fixed outline/direction buttons. It cannot establish whether its options came from a native tool or legacy reply recognition. Latest workspace removed those fixed buttons; do not infer runtime is up to date from this screenshot.
- parseStructuredOutput scans plain model text for JSON objects and applies Zod. This is parsing/validation, not provider-enforced JSON Schema output.
- Native director uses use_tools, ask_creator, propose_next_step and document tools. Legacy classification still exists for old messages, missed ordinary-text questions and manual re-recognition.

## Question panel

The current main dialogue enables use_tools in web/src/ScriptDirectorPanel.tsx:1815. Native ask_creator has typed choice/input/confirmation/question_set arguments (backend/src/script-document-tools.ts:202). Its executor validates the arguments, supplies authoritative stage metadata, constructs the reply/classification, and stops the tool loop for creator input (same file:322 and :516). Option wording and whether a question is needed remain model judgments guided by prompts; the application renders the returned structure and validates stage/saving semantics.

Legacy replies/classify asks a second model pass to extract classifications from existing assistant text and validates them locally (backend/src/server.ts:2210; backend/src/script-reply-classification.ts:69). This is a fixed analysis task suited to structured output. The screenshot alone cannot identify which path produced the historical reply; a successful ask_creator entry in its execution trace confirms native use.

## Mechanism boundary

- Free text: story discussion, explanations, Markdown document prose, artistic judgment.
- Structured output: return a known data result to a fixed task (classifications, issue reports, profile drafts, shot arrays, prompt text envelopes, authorization booleans). Schema constrains structure; business validation still checks actual IDs, versions and relationships.
- Function Calling: choose and execute project actions, retrieve additional context, show a question and wait, create/revise a persisted reviewable draft, or save a specifically approved version. Function arguments are structured output too; the mechanisms can cooperate.
- Deterministic application logic: stage order, saved-document completeness, stale-state rejection, selected ratio/count/model, node geometry, explicit save buttons, and media job lifecycle. None should be delegated solely to model prose or tool choice.

## Inventory

| Feature | Current implementation | Recommended boundary |
| --- | --- | --- |
| Main dialogue choice/input/confirmation panel | Native ask_creator; legacy text recognition remains | Keep ask_creator + validated structured arguments in tool dialogue. Fixed extraction from historical text uses structured output. |
| Next stage proposal | Native propose_next_step, persisted/versioned and stage checked | Keep Function Calling. Program authorizes target and controls progression. |
| Read/search documents and related content | get_creation_state, read_documents, search_project_content, find_related_content | Keep Function Calling for on-demand retrieval. |
| Record confirmed/delegated settings | record_story_decision with source/settings checks | Keep Function Calling for durable mutation. |
| New stage draft / local correction / draft management | create_document_draft, propose_document_patch, manage_document_draft | Keep Function Calling with structured arguments; content fields can contain full Markdown prose. |
| Save | Explicit UI commit or commit_document_draft with current-version/approval checks | UI button remains deterministic API action. Natural-language tool saving requires approved existing draft and current version. |
| Natural-language generation/save authorization | Prompt JSON + parseStructuredOutput for authorized/approved booleans | Structured output for judgment; application still enforces draft/version/scope and clear approval. |
| Legacy intent recognition and reply extraction | Prompt JSON + schema parsing | Structured output. Reduce primary dialogue dependence on legacy second-pass routing. |
| Visual setting draft analysis | Fixed analyze request returns profiles[]; separate confirmed save API | Structured output for existing button. Add context-read/draft/binding tools only if enabling conversational visual editing. |
| AI shot planning | Fixed plan-shots request returns scenes[].shots[]; separate confirmed creation API | Structured output for existing button. Conversational planning/editing can expose context-read/plan-draft/patch tools. |
| Complete script one-shot generation | Fixed script/generate request returns outline/characters/artifacts/scenes | Structured output. If invoked from multi-step dialogue, expose a scoped draft action. |
| Single standalone document generation | Fixed artifacts/generate returns raw body | Free-form Markdown body is adequate; use a structured title/type/content envelope where required. Conversational mutations use existing draft tools. |
| Custom theme cover category mapping | Fixed read-only semantic classification; exact catalog values bypass model | Structured output for semantic mapping; deterministic lookup for exact names. |
| Continuity analysis | Fixed report of issues[] with allowed adjacent-shot IDs and signatures | Structured output for report. Conversational browsing/review can use retrieval tools before reporting. |
| Skill-based prompt refinement | Fixed refine-prompt returns {prompt}; Skills preloaded | Structured output or plain text when only prompt content is needed. Function Calling becomes useful only for autonomous context selection or project actions. |
| Image/video generation | User submission API and task worker | Keep explicit buttons and jobs. Future conversational submission can be a validated generation tool; ratio/duration/references and job state remain application-controlled. |
| Stage progression and canvas interaction | Saved progress, schema/scope/version checks and UI logic | Deterministic application code. |

## Concrete issues and priorities

1. Native stage protocol conflict: backend/src/server.ts:945 tells the model to call create_document_draft, then :946 appends workflowInstructions. backend/src/script-workflow.ts:75 instructs a plain JSON reply with only artifacts/scenes. Separate content instructions from response protocol; tools mode should communicate its function contract, fixed structured mode should communicate its response schema. Current mock regressions did not test model behavior under this contradiction.
2. Missed native questions: native runScriptTools returns classification_version even without an interaction. web/src/ScriptDirectorPanel.tsx:1684 defaults absent classification to other, and web/src/script-reply.ts:111 treats it as already classified. A model that writes options without calling ask_creator can therefore yield no question UI or automatic recognition. A pure local probe confirmed candidate counts 1 without classification versus 0 after other. Add a deliberate completion contract (plain explanation, creator interaction or next-step proposal) and a bounded repair/fallback for missing interaction; avoid blindly reclassifying every ordinary reply or forcing questions on every turn. Preserve provenance so inferred legacy choices do not overwrite an authoritative native event.
3. True structured-output transport: backend/src/structured-output.ts:9 extracts candidate JSON from free text, then applies Zod. The repository does not currently inject task-specific response_format/json_schema (or corresponding Responses text format) centrally. Existing request templates can contain user fields. Introduce shared task-level schema transport with explicit provider capability configuration/probing, local domain checks and a disclosed legacy fallback. Do not infer support from model name.
4. Strict function arguments: backend/src/providers.ts:311 uses tool_choice:auto and strict:false. Local execution already validates parameters. Provider-enforced strict mode requires compatible schemas and verified provider support; do not merely toggle it globally. Tool selection can stay flexible, while stage-sensitive actions and termination remain program validated.
5. Conversational visual/storyboard tools are a later extension. Reuse existing analysis, preview and confirmed save logic instead of replacing fixed buttons with unnecessary multi-round tool loops. Candidate tools might include read_visual_profiles, propose_visual_profile_draft, propose_visual_binding_patch, get_storyboard_context, propose_shot_plan and propose_shot_patch.

## Validation limits

This audit used source inspection and a pure recognition probe. No live provider behavior, paid model request or user-project mutation was performed. Provider support and the screenshot reply's exact provenance were not established from its model label or appearance.
