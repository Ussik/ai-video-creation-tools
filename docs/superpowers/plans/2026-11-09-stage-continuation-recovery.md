# Stage Continuation Recovery Implementation Plan

> **For agentic workers:** Execute the user-authorized fix in this chat with a scoped implementation worker and an independent reviewer. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `bad_response_body` 后合法断点丢失，以及同 ID 改写冲突反复重现的问题。

**Architecture:** 阶段接续模块保留不可变合法内容；异常只结束本轮。语义 ID 冲突保存为可纠正诊断，以完整输入发起有限纠正，只有无冲突且明确完整的结果才能结束目标。

**Tech Stack:** TypeScript、Zod、Node.js 22 `node:test`、现有持久检查点。

**Spec:** `docs/superpowers/specs/2026-11-09-stage-continuation-recovery.md`

## Global Constraints

- 保留全文、逐字正文、来源身份、原验证和取消语义。
- 不执行截断工具，不自动改名接纳冲突正文，不跳过冲突采纳完成标记。
- 兼容旧 v1 断点；不修改用户数据库、模型设置或既有未提交工作。
- 不调用真实生成接口；网关参数和实际额度维持未验证状态。

## Review Focus

- 已流式接收完整单元后 `bad_response_body`、鉴权/传输错误不会清空它们。
- 冲突页中已闭合的合法新单元保留，但冲突对象及完成标记不能成为成果。
- 持续冲突、冲突后断线和取消均能停止；下次继续仍携带准确诊断。
- 相同 ID 相同内容及旧版检查点兼容；标题归一行为保持。
- 最终覆盖、分场顺序和全阶段校验不能因局部纠正而绕过。

## Task 1: Stage continuation behavior

**Files:** `backend/src/modules/script/script-stage-continuation.ts`；必要时新增同目录聚焦 helper；`backend/test/script-stage-continuation-recovery.test.ts`。

**Interfaces:** 保留 `generateStageDraftWithContinuation(...)` 和可兼容的 `stageContinuationStateSchema`。

- [x] 写回归证明一般提供商错误后仍可从文档/单元断点继续。
- [x] 写回归证明冲突不覆盖旧内容、有限纠正、停止后继续读取诊断。
- [x] 删除按不可重试错误清空合法断点的行为，加入兼容的持久冲突诊断与有限纠正；审核只回退当前响应。
- [x] 跑阶段接续及人物接续、任务执行相关回归和后端类型检查。

## Task 2: Integration and acceptance

**Files:** 隔离上游集成回归及 `docs/research/2026-11-09-stage-continuation-recovery.md`；相关恢复契约文档。

- [x] 用模拟 Responses `bad_response_body` 覆盖真实 provider 到生成断点链路。
- [x] 独立复核状态与重试边界，修正已确认问题；拒稿历史指纹、旧版兼容、过滤回退、每响应计数均复验通过。
- [x] 运行相关 provider/阶段/任务回归、架构检查与 diff 检查，210 项不同测试全部通过，计数及旧断言调整见验收记录。
- [x] 更新恢复说明及验收，说明真实网关额度未验证。

## Task 3: Closed block metadata recovery

**Files:** `script-stage-block-repair.ts`、`script-stage-continuation.ts`、`script-task-execution.ts` 及对应回归测试。

- [x] 只读核对场景设计失败：HTTP 200 / 1,082 输出 token，已有七个合法单元；历史坏单元原文未保存。
- [x] 复现完整正文缺字段后直接失败；实现整页隔离、元数据补丁和恢复优先消费待修页。
- [x] 验证前缀/后缀/顺序、正文冻结、冲突确认、取消和过滤；历史断点按目标迁移。
- [x] 只读验证真实旧断点通过新 Schema，七个完整单元的哈希不变。
- [x] 完成相关接续/提供商/任务回归并补充验收结果：13 文件 177 项通过，类型/架构/UI guard/diff 检查通过。

## Task 4: Mixed empty structures and durable identity history

- [x] 核对真实四条失败诊断与旧原页被新工作区覆盖的限制；用等形数据确定性复现，不冒充真实回包重放。
- [x] 精确空结构逐项确认，与完整正文元数据在单次补丁处理；空结构确认后强制另一次合法完成响应。
- [x] 保留幂等审计、全文、顺序、冲突确认与取消/过滤边界，错误文案揭示完整阻断。
- [x] 不新增表，事务归档被替换工作区；精确身份恢复、兼容迁移消费源、清除后不复活当前任务。
- [x] 15 文件 234 项统一回归、后端类型/架构/UI/diff 检查通过；独立复核无阻断。
