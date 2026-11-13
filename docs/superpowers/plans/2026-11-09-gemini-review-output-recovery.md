# Gemini Review Output Recovery Implementation Plan

> **For agentic workers:** Execute the authorized tasks below in this chat with independent workers, followed by an integration review. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 剧本生成后的自动审读及手动文档审读在输出超限时保存完整结果并继续未完成部分。

**Architecture:** 保留现有正常单请求与阶段三维恢复；在再次输出超限时使用共用的结构化分页器。分页器按完整输入哈希保存合法条目，只在明确完成且整体校验通过后提交结果。供应商适配层延迟输出超限异常直到能收集合法结束用量，始终拒绝截断工具调用。

**Tech Stack:** TypeScript, Node.js 22, Zod, SQLite checkpoints, node:test.

**Spec:** `docs/superpowers/specs/2026-11-09-gemini-review-output-recovery.md`

## Global Constraints

- 完整有效原稿、创作者要求和既有成果不截断。
- 原有范围、逐字证据、版本及全局一致性检查继续成立。
- 不改用户模型选择，不按型号猜输出上限或思考参数。
- 不执行残缺工具参数，不重复已提交报告，不自动写正文。
- 仅隔离数据库和模拟上游测试；不得把模拟通过当作真实模型验收。
- 工作区有既有未提交修改，不回退、不覆盖、不创建包含无关工作的提交。

## Review Focus

- 分页已保存结果在后页超限、断线或停止后仍可恢复。
- 重复条目、跨页索引冲突、假完成页不能绕过整体校验。
- 文档或原稿在分页中变化时停止提交，继续时旧缓存失效。
- 工具参数被截断且用量独立尾帧返回时，既保留用量又拒绝执行。
- 同一文档已成功提交审读但总结超限时，不再次生成或提交报告。

## Task 1: Shared paginator and automatic reviews

**Files:** `script-review-pagination.ts`, `script-streamed-units.ts`, `script-draft-review-recovery.ts`, `script-draft-review-evidence.ts`, `script-draft-completeness.ts` and focused tests under `backend/`.

**Interfaces:** `generatePagedReviewItems<T>({ id, name, itemSchema, prompt, generate, signal?, steps?, parentId?, validateItem?, validateItems?, maxItems }): Promise<T[]>`; wire `{ items, complete }`, contract `${name}_page`.

- [x] Add behavior tests for multiple length failures, restart, cancellation, complete closed JSON items, invalid evidence and no progress.
- [x] Persist validated pages by full input/schema hash; narrow page size on no progress and stop at irreducible repeated failure.
- [x] Retain existing whole/three-dimension behavior; add paged focused reviews and paged evidence repair.
- [x] Run paginator, evidence, review recovery/reasoning and stage continuation suites.

## Task 2: Finding grouping

**Files:** `backend/src/modules/script/script-finding-groups.ts` and focused tests.

**Interfaces:** Consume Task 1 paginator; preserve `groupDraftFindings` caller API and final business validation.

- [x] Test overflow/resume, every-index coverage, cross-page historical-ID collisions, and cancellation.
- [x] On length failure retain the paging strategy so a continuation does not resend the whole grouping request.
- [x] Validate cumulative groups before saving pages and validate full coverage before completion.
- [x] Run grouping and history regressions.

## Task 3: Manual document review

**Files:** new `backend/src/modules/script/script-document-review-generation.ts`, local changes to `script-document-tools.ts`, and focused integration tests.

**Interfaces:** Dedicated read-only paged report generation; existing `submit_document_review` remains the sole validated report commit.

- [x] Test truncated review tools, paged recovery, restart, stale versions, cancellation, and an already committed review followed by summary truncation.
- [x] After explicit review transport truncation, read selected current documents and review context, generate pages with Task 1, and submit one validated aggregate.
- [x] Persist the recovery strategy and page checkpoints using model, source, selected document versions and creator request.
- [x] Run document-tool and scoped review integration suites.

## Task 4: Provider diagnostics and final verification

**Files:** `providers.ts`, `text-errors.ts`, focused transport tests; optional activity schemas/types when needed for diagnosis.

- [x] Test delayed usage footer, cumulative usage, cancellation and truncated tools never executing.
- [x] Merge available metrics into the final output-limit error and preserve its terminal reason.
- [x] Check public gateway documentation without credentials; leave unsupported/unknown settings untouched and document uncertainty.
- [x] Run backend typecheck, architecture/UI checks, relevant frontend activity tests if changed, and independently review only this task's patch.
- [x] Record verified behavior and remaining real-provider limits in the acceptance note.

## Completion

2026-11-09：实现、独立复核与收尾回归完成。后端相关 364 项、前端活动展示 34 项通过；前后端类型检查、架构/UI 检查和 diff 检查通过。详细验收与真实供应商验证边界见 `docs/research/2026-11-09-gemini-review-output-recovery.md`。
