# 5f1b500a 大纲复核关联修复

验收对象：`storyboard:5f1b500a-c393-495d-85e5-75be8bf17c7f`，trace `8811dc2128b462de698a3db3694cee75`。记录时段为北京时间 2026-11-17 10:32:34–10:40:54，五镜、30 秒。

## 根因与证据边界

已提供的记录中，HTTP 响应为 200 且 response_complete=true，没有断连证据。大纲生成首次有 16 项契约问题，格式纠正耗时约 213 秒；大纲复核首次有 24 项字段问题，纠正约 57 秒后又因 `issues[1].related_shot_index=3` 指向非相邻镜头而失败。索引 3 表示用户看到的第 4 镜，不能据此自动推断它应指向哪一镜。

真实大纲入口缺少报告级的受限关联纠正；完整分镜复核的处理也不能直接套用到大纲。不能通过清空关联、改写问题说明或制造证据让校验通过。测试使用同型五镜隔离夹具，并非原始回答逐字回放。

## 实际实现

- `storyboard-review-relations.ts` 共享零起索引、完整顺序和相邻 pairs，校验保留准确问题路径、原关联坐标与诊断；完整复核同样拒绝非法关联，不清空关系或追加改写问题。
- `storyboard-outline-quality.ts` 的初次、格式纠正后、已保存报告、拒绝报告恢复及 recheck 共用接收路径。先校验关联，再用证据校验副本检查原文和范围；关联纠正及后续恢复不改写原报告的说明、证据或引用。
- `storyboard-outline-relations.ts` 只允许返回指定 issue 对应的程序选项 ID。程序只修改 related_scene_id、related_shot_index，再执行严格业务校验；不修改大纲、问题说明、证据或 repair_scope。真正指向非相邻证据且没有合法选项时本地停止，不调用模型。
- 每份报告最多一次关联纠正，禁用该调用的格式与网络追加重试；派发前持久化尝试标记，纠正失败、结果未知或重启均不重复派发。保留原始拒绝报告和五镜大纲；保留任务预算与中断语义。
- 失败或耗尽后后端禁止恢复，前端不再显示会误导用户重新发起的“继续规划”入口，保留明确的重新规划操作。
- 根据实际最终 Zod Schema生成大纲类型提示，明确 title 是字符串、sound_effects 是字符串数组、scene_direction.sound 是结构化对象。真实路由的两种协议请求体均有测试断言。没有增加超时或纠正次数，也没有改变已有大纲检查点键。
- 主提示显示场次标题、用户镜号和复核问题编号；原 ID、技术路径及原尝试坐标保存在默认收起的错误详情中。

## 验证结果

- 关联专属 11 项回归通过：实际大纲入口、格式纠正后、旧报告、recheck及其恢复、五镜30秒批处理重启、非法补丁、真实非相邻证据、缺少证据、预算停止、断连后不重发、原报告字节保留。
- 独立任务回归通过：失败后重启仍保留五镜30秒检查点，拒绝再次恢复，不产生追加请求。
- 后端扩大回归 239 项：236 通过、3 失败。三项均在未修改 HEAD 的临时源码副本复现，分别为不完整流重试次数、重复所选场次修正、redesign旧ID拒绝次数的历史预期；没有修改这些断言来掩盖失败。
- 前端两组回归 69/69 通过，包含可读定位、技术详情默认折叠及失败后无继续入口。组件测试必须加载 web/tsconfig.json 的 JSX 配置。
- 前后端 TypeScript noEmit、架构及 UI 守卫、git diff --check 均通过。

可复现命令（项目根目录）：

```sh
node --import tsx --test backend/test/storyboard-outline-relations.test.ts backend/test/storyboard-planning-tasks.test.ts
TSX_TSCONFIG_PATH=web/tsconfig.json node --import tsx --test web/test/storyboard-planning-task.test.ts web/test/storyboard-planner.test.tsx
./node_modules/.bin/tsc -p backend/tsconfig.json --noEmit
./node_modules/.bin/tsc -p web/tsconfig.json
npm run check
git diff --check
```

本轮只修改既有 main 源码并做隔离验证，保留原有改动；没有调用真实付费模型、没有恢复实际任务、没有清理数据、没有提交或推送。旧 trace 不会自动改变。实际模型纠正成功率、端到端耗时和费用改善尚待后续有授权的真实验证。
