# Findings & Decisions

- User authorized checkpoint commit/push before development; done as 3b016b5.
- CC Switch searches https://skills.sh/api/search?q=&limit=&offset=; installation resolves repository paths by SKILL.md name, not by assuming skillId is the path.
- Backend builds structured prompts in server.ts and visual-profiles.ts. Image/video models receive final prompts, so skills for those stages need an explicit text-model prompt refinement action, not raw SKILL.md appended to media prompts.
- Source snapshot/Markdown rules and reference files can be stored in application-owned SQLite; no writes to Codex/Claude global skill folders and no downloaded-script execution.
- Search is a third-party service; cached results and repository scanning offer independent discovery paths.
- Preserve current manual generation parameters, complete editable prompts, reference bindings and provider-neutral adapters.
- Implemented pinned GitHub API tree/raw downloads; YAML metadata, bounded files and Markdown references stored in application-owned SQLite.
- Installation stays disabled until explicit stage binding. Known drama skills preselect their recommended stage.
- Existing script/director/artifact and storyboard builders load active rules; visual analysis uses visual_assets.
- Canvas refinement returns an editable draft; no node changes until applied. Board overrides participate in preview/reference signatures/generation and clear when the profile revision changes.

- Real GitHub skill installation succeeded at immutable commit c2426e03c0e7722bebcc6a488b6658dc38c65ac3. Markdown/code blocks/reference links render correctly, and external script requirements are shown separately.
- Canvas refinement and information preview use the same saved complete prompt. QA capture proves rules, character definition and exact 9:16 configuration are included without invoking media generation.
- Skill center is memoized to keep Markdown links stable while unrelated application data polls; opening a reference resets its scroll position.
- Prompt drafts become stale when content, generation configuration, references, model, project/node or associated shot/profile changes.
- External commands and media scripts remain outside this integration; five-stage text-model rule application is supported.
