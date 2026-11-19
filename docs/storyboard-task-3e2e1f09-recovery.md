# 分镜任务 3e2e1f09 恢复修正

本次只针对任务 `storyboard:3e2e1f09-4ced-43f3-86fb-908115405df5` 的复核失败与大纲恢复路径做本地修正。没有发起真实模型请求。

## 修正内容

- 复核返回的 `related_scene_id` / `related_shot_index` 现在在进入业务校验前统一检查当前序列中的直接相邻关系。
- 模型给出非相邻或半指定关联时，保留当前镜头问题，将非法关联清空，并在问题消息中写明原关联镜头和“已按本镜问题处理”；已验证的大纲不会因此丢失或重新生成。
- 业务校验仍拒绝未经归一化的越界关系，并补充 `storyboard_review_invalid`、字段路径和原关联镜头到任务错误，区分模型引用越界与候选内容本身的问题。
- 有已验证大纲、尚未开始扩写且任务可恢复时，恢复按钮显示“继续恢复大纲”；恢复仍复用原大纲检查点。

## 验证

- `backend/test/storyboard-directing.test.ts`：8/8 通过，覆盖非相邻、越界、半指定关联和归一化。
- `web/test/storyboard-planning-task.test.ts` 与 `web/test/storyboard-planner.test.tsx`：相关测试通过，覆盖错误定位、恢复文案和既有恢复流程。
- 后端、前端 TypeScript 检查和 `git diff --check` 通过。

未使用真实 Langfuse 重跑或付费模型验证，因此不能据此宣称真实任务成功率已经改善；当前证据只证明断点恢复、错误归一化和 UI 提示路径符合预期。
