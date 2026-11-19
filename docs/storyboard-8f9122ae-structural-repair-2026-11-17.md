# 8f9122ae 结构定向修复误判

验收对象：`storyboard:8f9122ae-709b-4729-bd21-a887274fcf50`，trace `227e58fb4ed311d11c873353ee96505c`，北京时间 2026-11-17 11:22:08–11:24:34。仅在既有 main 源码增量修改，保留此前改动；没有恢复真实任务、调用付费模型、清理数据、提交或推送。

## 已确认事实与边界

本地 trace 导出文件中，大纲初次请求 HTTP 200、完整响应、JSON 合法；结构校验只有 `$.scenes[0].scene_duration` 的 invalid_type。初次请求 83,567 bytes，输入 69,075 tokens。结构纠正 HTTP 200、完整且 JSON 合法，耗时约 5.86 秒、输出 71 tokens，但纠正输入达 79,736 tokens、92,210 bytes。随后本地校验 invalid_business，尚未进入 outline_review。

导出的 input/output 均为 null，没有补丁正文。已提供的现场排查说明业务检查点没有保存本次完整候选或补丁。因此不能宣称看到了原补丁，不能证明模型这次实际越界，也不能在本轮事后补回已缺失的原回答。

## 确定复现的程序机制

真实 generateStructuredOutput 调用链中，候选的 scene_duration 为字符串、合法 title 含首尾空格，模型补丁只修正时长类型；合并并未改动 title，但 schema.safeParse 执行 trim 后，旧检查把解析后的对象与原始候选逐值比较，误报“定向修复改变了授权目标之外的字段”。default 等合法规范化也有同类问题。

另外，实际大纲的 validateSchedule 会在原对象上执行台词来源及标点规范化。真实路由测试确认“时长类型纠正 + 来源标点规范化”也会让保留性检查把程序自身的校验副作用算到模型补丁头上。这些机制已经独立复现，但没有本次原回答，不能确定原事故具体变化了哪个字段。

## 实际修正

- 分离三个阶段：patch_merge、schema_normalization、business_validation。原始合并仍严格限制在程序指定目标；Schema 阶段只允许保守的 trim、声明默认值和可选 null 规范化，其他变换继续拒绝；业务校验前冻结规范化基线，校验器不得改写无关字段。
- 不移除保留性检查，不让任意 Schema transform 或 validator 改写混入合法规范化。每个阶段记录精确差异路径、前后值 SHA-256、字段是否存在和阶段来源。补丁契约、Schema 越界、validator 越界及业务失败有明确 code，不再依赖无 code 的普通 Error。
- 大纲校验使用副本，只读核对来源与时长；已有的台词来源规范化在独立领域步骤执行，再进入大纲复核与扩写，不占用模型补丁的修改权限。
- 大纲入口新增私有 structured_output 检查点：保存完整 initial original_raw、已完成补丁 correction.raw、固定请求身份及差异审计。派发意图先持久化；未知结果不重发，已完成失败补丁只能本地重放。未通过的候选绝不当成已验证大纲或可保存成果。
- 结构纠正失败后停止重复恢复。对旧的无 code 边界失败，仅在读取视图中标记 structural_boundary_unattributed，禁止继续从头生成；不改写原持久化记录，不猜测是 Schema 还是 validator 造成。
- 仅在明确的数值字符串 -> 同值 scene_duration 数字纠正时缩减提示上下文。程序给出场次身份、原数值与镜头时长，并用补丁 Schema const 固定原数值，不能借机重新估时。缺少时长、无法确认数值映射或其他结构修复保留完整业务资料。旧的冻结纠正身份仍按原规则保护。
- Local / Langfuse 只导出经过 Schema 路径过滤的阶段、路径和哈希，不导出创作原值。完整原回答和补丁留在私有检查点。前端不再把已停止的结构纠正显示成“继续规划”，保留明确的重新规划入口。

## 验证

- 新增真实结构输出调用链、真实大纲批处理、任务持久化、真实路由请求体和模拟 Langfuse 导出测试。覆盖 trim/default/optional null、任意 Schema 变换拒绝、validator 修改原字段或默认/可选字段拒绝、额外补丁字段拒绝、初始回答与补丁完整保留、失败重启零派发、必要业务上下文回退、同值数字 const 约束，以及台词规范化的独立归属。
- 实际路由使用模拟 provider 响应进行验证：时长类型补丁请求体小于初次请求，且不再带原始任务全文或完整候选。它只证明该夹具的请求体缩减，不能换算为本次事故或真实模型的时延、token、费用改善。
- 后端扩大回归 332 项：328 通过，4 项历史失败在未修改 HEAD 的临时源码副本同样复现。分别是旧语法失败预期、不完整流重试次数、重复所选场次修正、redesign 旧ID拒绝次数。本轮没有为通过测试而修改这些断言。
- 前端两组回归 70/70 通过；前后端 TypeScript noEmit、架构及 UI 守卫和 git diff --check 通过。

常用命令（项目根目录）：

```sh
node --import tsx --test backend/test/model-output-structural-normalization.test.ts backend/test/model-output-repair.test.ts backend/test/storyboard-planning-batches.test.ts backend/test/storyboard-planning-tasks.test.ts
node --import tsx --test --test-name-pattern='actual outline provider request|separate ownership' backend/test/storyboard-planning.test.ts
TSX_TSCONFIG_PATH=web/tsconfig.json node --import tsx --test web/test/storyboard-planner.test.tsx web/test/storyboard-planning-task.test.ts
./node_modules/.bin/tsc -p backend/tsconfig.json --noEmit
./node_modules/.bin/tsc -p web/tsconfig.json
npm run check
git diff --check
```

真实 8f9122ae 没有恢复；旧 trace 不会自动补出原正文或新诊断。现阶段完成的是确定性程序修复和隔离验证，真实模型成功率、端到端耗时及费用仍未复测。
