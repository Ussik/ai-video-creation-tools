# 分镜输出契约与复核效率修正（2026-11-17）

适用任务：`storyboard:6b68bff5-52be-49e5-899e-a8086b4b7f32`。本轮仅在主工作区 main 修改；未发起真实模型请求、未重跑任务、未修改业务数据、未提交或推送。

## 已有记录与证据边界

该任务最终生成 13 镜、120 秒，生成成功；导演复核达到 120 秒上限，结果为 `review_inconclusive_no_action`，不能称为复核通过。已有统计中 13 次逐镜首次输出全部需要格式纠正，包含 8 次契约失败、5 次 JSON 失败；复核首次也有大量契约错误。

成功后逐镜执行检查点已清理，未找到这批失败原回答。新增测试均为代表性合成夹具，不是这批原回答回放。因此不能断言每次失败都由同一个字段引起，不能承诺真实首次成功率或耗时已改善。

## 修正

- UI 将 `pending_review` 显示为后台复核进度，消除与“请先复查”的红色错误矛盾。隐藏重复复核操作，函数层使用状态与同步锁防止重复派发；任务结束清理连接提示。
- 逐镜输出明确 `scene_id → shots[] → shot_index/expansion` 根结构，按实际 expansion Schema 生成可见结构示例，原生 Schema 被网关接受但未硬约束时也有明确层级提示。
- 复核说明区分 issue 的整数 `shot_index` 与场面调度 repair_scope 的可空 `shot_index`，增加完整问题对象示例。
- 移除扩写提示中分镜技能、运动技能全文的第二份拼接，保留一次有限规则上下文。当前镜头与场面调度保持完整结构对象，不再把整个对象截成字符串。邻镜仅供边界参考，保持顺序执行和逐镜检查点。
- 逐镜/导演复核显式使用局部回答纠正策略：语法及字段纠正携带完整当前回答、契约和诊断，不携带无关项目全文；定向结构补丁同样不重复全文。不增加纠正次数或总请求预算，不改变已持久化旧纠正请求的字节身份。
- 复核首次请求、验证、纠正共享同一个 120 秒截止信号。即使截止后收到畸形回答，也不能再启动格式纠正；保留完整草稿，标记复核未定。既有保存草稿与进入画布规则不放宽。
- 从 Zod 错误直接提取 Schema 内字段路径与固定错误码；未知记录键、创作正文和错误值不进入观测元数据。修复 `$` 根路径被过滤的问题。
- 本地与 Langfuse 导出明确记录 `business_result=generated`、`review_status` 和复核错误码；保留首次失败及纠正成功事件，不把任务执行成功当作复核通过。

## 验证

- 前端：70/70 通过，覆盖后台复核、同次渲染双击保护、保存及画布导入限制。
- 后端：331 项中 318 通过，13 项失败均在未修改的 `beea103` 临时副本复现；最终失败名称集合与基线一致，没有新增失败。既有失败涉及旧语法审批/恢复、原生格式回退和三个历史规划场景，未在本任务中扩大修改。
- 新增路由和原生 Anthropic 适配器请求体验证：当前镜头长文本完整传输，规则没有重复前置；完整回答纠正和定向结构补丁均不携带无关项目资料，夹具中纠正请求字节数低于初次请求。
- 新增超时回归：第一次复核截止后返回畸形数据，不产生第二次格式纠正请求，完整草稿仍可按既有规则保存。
- 新增观测回归：本地及模拟 Langfuse 导出包含安全路径、固定错误码及复核未定状态。没有向真实 Langfuse 写入测试记录。
- 前后端 TypeScript 检查、`npm run check`、补丁格式检查通过。
- 后端编译与前端 Vite 打包输出到 `/tmp/storyboard-optimization-build/`，避免清理运行服务的 dist。Vite 仍有既有大包提示。

常用回归命令：

```sh
node --import tsx --test backend/test/storyboard-output-efficiency.test.ts backend/test/storyboard-planning-batches.test.ts backend/test/model-result-observation.test.ts
node --import tsx --test --test-name-pattern='director deadline|local expansion reaches' backend/test/storyboard-planning.test.ts
node --import tsx --test --test-name-pattern='native storyboard correction wire|native structural patch wire' backend/test/text-anthropic.test.ts
# 前端命令在 web 目录运行，以加载正确 JSX 配置
node --import tsx --test test/storyboard-planner.test.tsx test/storyboard-planning-task.test.ts test/canvas-storyboard-import.test.ts
```

真实模型成功率、时延和实际 token/费用变化尚未复测；需要后续有授权的真实任务验证。现有旧 trace 不会因为代码修正而自动补回缺失字段。
