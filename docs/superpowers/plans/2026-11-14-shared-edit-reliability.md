# 共享精确编辑与局部纠错 Implementation Plan

> **For agentic workers:** Use the current task's authorized native execution with delegated, isolated subtasks. The user's instruction to proceed, preserve main, and avoid commits overrides skill handoff and commit defaults.

**Goal:** 在所有适用的模型编辑入口复用可信目标身份，保留有效提案，仅纠正可明确定位的失败项，最终严格原子采用。

**Architecture:** 复用已有 `documentParagraphs`、版本门禁、检查点和事务。冻结注册表由程序保管版本、段落位置及原内容摘要；模型只提交 ID 与新内容。局部纠正由调用者明确规划目标，结构化生成器只执行既有的一次纠正额度，最后重新校验完整候选；未知传输不进入纠正。

**Tech Stack:** TypeScript、Zod、Node test；无新依赖。

**Spec:** 用户 2026-11-14 主任务范围修正；入口覆盖及实际结果记录在 `docs/research/2026-11-14-shared-edit-reliability.md`。

## Global Constraints

- 直接 main，保留全部未提交修改；不 commit/push/reset，不切模型或修改设置。
- 不清 Langfuse、浏览器、成功检查点及历史未知请求；业务 DB 只读。
- 当前剧本是验收样本，不继续大范围付费人工修稿；优先离线夹具。
- 不信任模型 offsets，不模糊匹配；陈旧/伪造/跨文档引用、越权、未读范围、Unicode 断裂、冲突均拒绝。
- 部分成功只保留为私有待合并提案；最终结构、版本、业务与语义门禁全部保留。
- unknown 恢复剩余 0；本次增强不得自动重发不确定上游请求。

## Review Focus

- 重复段落必须不同 ID，单改其一，其余空白、换行和 Unicode 精确不变。
- 旧成功 find/ref 缓存只有原输入哈希精确命中且重验后复用，模型/渠道配置变化不迁移。
- 两个失败项之间及与有效项重叠时，冲突组整体纠正，不能悄悄丢编辑或部分保存。
- 局部纠正不能扩展目标或篡改合法兄弟项；第二次失败即退出，409/取消/未知不纠正。
- 既有实体 ID/字段路径已安全的入口保留原协议；提示词调整不冒充通用能力落地。

## 最新授权与优先级

主交付为全项目适用的通用模型可靠性，剧本仅为验收样本。本轮停止付费验收，优先完成：完整响应/原提案/纠正耗用私有持久化；冻结位置；失败单项和必要冲突组合并；unknown暂停；按事项和真实证据判进展；首轮证据坐标；只对可证明依赖复用局部检查；保留最终全局核对与原子采用。未证明依赖时保留完整背景，不以删上下文冒充效率优化。

新增收尾事项：

- [x] 原始 raw 与 canonical replay 分开，成功纠正后也保留完整原提案及耗用。
- [x] 默认 response、显式修订提案及原生操作账本按私有记录合并，迟到结果不能覆盖新进度。
- [x] 新旧审读协议精确绑定迁移；旧成功复验复用，旧私有未知链不能借协议升级重发。
- [x] 首轮选择 source/version/unit 坐标，由程序回填原文；独立语义与最终全局检查保留。
- [x] 证据进展与问题解决区分，无关文字改动不能维持循环。
- [x] 最终组合回归、main差异核对、应用与服务/数据保持验证。

## Task 1: 可信冻结定位与候选接线

**Files:** 新增 `backend/src/modules/script/script-frozen-locators.ts`；修改 `script-draft-repair-references.ts`、`script-draft-resolution.ts`、`script-draft-repair-context.ts`、`script-draft-repair-generation.ts`、`script-draft-repair-worksets.ts`、`script-draft-repair-tools.ts` 及相关测试。

**Interfaces:** `createFrozenPassageRegistry(documents, scope?)` 持有真实位置；`frozenPassageVersion(identity,key,content)` 绑定快照；`createDraftRepairReferences(...,{legacy?})` 新协议解析为 `paragraph_id`，旧工厂只用于精确旧身份重建。`resolveEdits(source_key,edits,current?,readRanges?)` 返回可信 `ResolvedEdits`。

- [x] 离线复现重复原段无 ref、长 find 复制失败；增加重复段、CRLF、中文/emoji、陈旧/跨文档/未读/冲突测试。
- [x] 实现注册表及新 ref 协议，候选/native/source/整批最终应用统一同版本解析，保留旧 find 分支。
- [x] 验证旧七份60编辑缓存、原生批次及全局最终校验，配置变化不复用。

## Task 2: 一次局部纠正与有效提案保留

**Files:** `backend/src/modules/generation/model-output.ts`、新增 `model-output-local-repair.ts`（如需通用纯帮助器）；候选 worksets/native batches、source quality repair、storyboard targeted repair 的 domain planner；相关测试。

**Interfaces:** `StructuredOutputLocalRepair={schema:z.ZodType,prompt:string,apply(patch):unknown}`；`planLocalRepair(candidate,{issues,error})` 只为完整根结果规划。生成器不自行判断语义失败项，调用者只能在明确路径上返回计划；第二次仅发目标补丁，合并后原 schema 和完整 validate 重验。

- [x] 写完整根业务失败、合法兄弟保留、非法目标、unknown/409/取消不重发、一次纠正失败退出测试。
- [x] 实现可选回调，保留现有未接入合同路径和结构 leaf repair，不增加调用次数。
- [x] 候选按稳定操作身份保留有效提案，仅纠正失败项和冲突组；原子整包门禁不变。
- [x] source quality 与 storyboard 使用真实现有坐标/field key 规划，证据与权限校验不得省略。

## Task 3: 入口覆盖与通用修订边界

**Files:** `script-revision.ts`、`script-revision-reads.ts` 调用链；stage artifact/block/scene；storyboard scope review；prompt refinement references/exact edit；覆盖报告。

- [x] 逐入口记录已具备/本次增强/不适用原因/未完成，列真实调用点与可复现缺口。
- [x] 修复可独立确认的边界，已有实体/字段安全协议不硬改；新增回归覆盖对应真实缺口。
- [x] 将跨文件合并后的针对性测试、类型、架构/UI检查一次跑完；确认全局无在途与原稿/成功检查点保持。

## Verification

每组先用当前 main 快照的 `/tmp` 镜像跑针对性失败/通过验证，再由主任务检查差异并应用 main。最后组合验证跨入口测试、`tsc --noEmit`、`npm run check`、`git diff --check`，不重复全量基线。只在离线验证不足以说明真实契约时使用有限真实调用；没有必要不发付费请求。

## 交付结果

2026-11-14 已应用 main；76 文件 / 1,092 项组合测试全部通过，main 安装后 6 文件 / 74 项回归全部通过。类型、架构/UI、差异检查通过，8000/8888健康。原稿、固定模型配置、七个成功 child / 60 edits 及修订 payload 均保持；没有新增付费模型调用或正式稿件写入。未 commit/push。第一集正文真实端到端验收仍未完成。
