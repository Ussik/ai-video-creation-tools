# 分镜重新规划与新画布恢复验证

## 交付行为

- 「规划方式」是唯一入口：复用已保存分镜、沿用当前方案更新、重新设计新方案。移除下方「重新规划已有分镜」复选框，下方只保留「时长设置」。
- 混合选择时，复用模式仅规划未完成的场次；明确选择更新或重新设计时，规划完整所选范围。
- 当前镜头已回收时，历史方案仍可进入重新设计。原专属画布已删除时，默认且仅允许重新设计，确认后创建并打开新方案的独立画布。
- 更新请求遇到已删除的目标画布，会在模型调用或提交写入前拒绝。正常画布更新、原有分镜复用、确认重试仍保留。

## 验证结果

- 前端 `web/test/storyboard-planner.test.tsx`：28/28 通过，包含 4 种回收/画布删除/混合选择情况、单入口切换、确认后画布交接及重试。
- 后端 `storyboard-planning`、`script-canvas-preparation`、`shot-management` 三套测试：74/76 通过。本次新增恢复测试及其两个子用例全部通过。
- 后端 TypeScript、共享包构建、`git diff --check` 通过。
- 前端 TypeScript：仅排除主线程临时验收文件 `web/src/__visual_board_ux_qa.tsx` 后，应用源码为 0 个错误；未修改该临时文件。
- 对正在运行的本地资料接口做了只读验证：截图中的 EP001-SC001 返回 `shot_count=0`、`has_previous_plan=true`、`requires_redesign=true`，与恢复入口一致。

## 既有检查问题

后端以下两个失败均已在临时副本中移除本次后端修改后复现，副本随后清理：

- `preparation honors project defaults, temporary visual skill selections and explicit base rules`：测试桩期望 `visual_profiles`，实际先调用 `creation_skill_selection`。
- `replanning with changed documents refreshes all setting types and only the selected shot snapshots`：既有设定刷新断言期望 32 岁，实际仍为 21 岁。

项目完整架构/UI/前端类型检查被主线程临时验收文件 `web/src/__visual_board_ux_qa.tsx` 拦住：源文件位置、原生 details/summary 控件和未使用的 React 导入。没有删除或修改其他任务的文件。

未进行浏览器视觉验收或真实模型生成；模型调用与提交行为通过组件测试和临时数据库测试验证。本次未修改业务数据库、恢复回收站资源、提交 Git 或启停开发服务。
