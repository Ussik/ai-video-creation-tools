# 分镜彻底删除与业务任务记录 Implementation Plan

> Execution: user explicitly authorized direct main implementation and offline verification in this session; preserve all existing edits, no subagents, no commits/pushes or real data deletion.

**Goal:** 分镜彻底删除只清理独占内容并精确预览；任务页每个用户动作一个业务任务，技术恢复记录按明确 ID 收进详情。

**Architecture:** 沿用 shot-management 回收入口，新增独立删除规划器和带指纹的预览/执行接口。文件先移入事务暂存区，数据库失败回滚文件，提交后删除文件并如实返回清理状态。业务任务持久保存用户动作元数据，现有 jobs 和 planning checkpoint 保持原有身份；恢复台账不删除、不按时间猜分组。

**Tech Stack:** TypeScript / Fastify / SQLite / React / Mantine / node:test.

**Spec:** 本轮用户委派消息，两项需求完整记录在最终实现说明。

## Global Constraints

- main 主目录直接实现；不调用真实模型、不清空历史或 Langfuse、不写真实业务数据。
- 共享资产、其他镜头/画布/成片引用保护；混合范围运行不可整行误删，无法证明安全时明确阻断并列出引用。
- 普通回收保留恢复能力；彻底删除不可恢复，不能声称远端取消或费用消失。
- 无 parent 的旧技术记录不伪造业务分组，仅按明确 ID 合并；不占默认主列表。

## Review Focus

- 同路径不同资产记录与跨项目引用保护，数据目录外路径/符号链接不可删除。
- 单镜与混合镜头检查点、共享档案子变体、正在运行或未知响应的删除边界。
- 预览后引用改变、错误身份与重复请求必须失败或幂等，不执行半套数据库删除。
- 业务任务与子步骤明确 ID 去重；未知路由和无 parent 旧记录不冒泡。
- 筛选、原入口、详情恢复/诊断仍可访问；删除只清理目标历史。

### Task 1: 有引用保护的彻底删除

Files: backend/src/modules/storyboard/shot-permanent-deletion.ts; shot-management.ts; packages/shared/src/storyboard/shot-management.ts; web/src/features/storyboard/ShotManager.tsx; backend/test/shot-permanent-deletion.test.ts; web/test/canvas-shot-management-integration.test.tsx.

- [ ] 先测试独占素材/档案变体/历史/检查点/文件清理与共享保护、运行未知/混合范围阻断、预览过期及回滚。
- [ ] 实现 preview(projectId, shotIds) 和 execute(projectId, shotIds, revision)，返回删除、保留及阻断清单，精确比较资源与文件状态。
- [ ] 回收站彻底删除使用预览确认；普通回收文案明确会保留素材及历史，不误导用户。
- [ ] 隔离回归通过，记录无法安全清理的共享恢复范围及原因。

### Task 2: 业务任务聚合与技术详情

Files: backend/src/modules/jobs/business-task-history.ts; generation/ai-operations.ts; shared api business task types; web/src/features/jobs/TaskRecords.tsx; task-records.ts; App.tsx; backend/test/business-task-history.test.ts; web/test/task-records.test.tsx.

- [ ] 先测试明确用户动作、同 ID 恢复、无 parent 历史、未知路由、筛选与原入口。
- [ ] 在已知明确动作创建业务元数据；读取任务历史聚合任务与明确关联内部操作/模型调用，不按近似范围或时间猜分组。
- [ ] 默认统一业务列表，移除底层两块完整列表；内部步骤按需展开，旧未关联记录仅紧凑入口按需读取。
- [ ] 验证聚合不改变恢复台账、Langfuse 和模型计费记录；验证彻底删除只处理独占业务历史。

### Verification

- [ ] 相关 backend/web 测试，完整 build 与 diff check。
- [ ] 最终文档写实际完成状态及限制，不提交推送。
