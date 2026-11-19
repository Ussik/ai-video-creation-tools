# 60fa9703 加入画布参考目录修复

## 状态和边界

实现先在 `/tmp/canvas60-work` 完成离线验证；2026-11-17 用户明确要求写入 main 后，已通过写入审批，将 19 个文件的增量补丁应用到 `/Users/caoyanzu/workspace/ai-video-creation-tools` 的 main。应用前所有目标文件与基线一致，应用后逐文件 SHA-256 与已验证实现一致。

本轮没有调用真实或付费模型，没有恢复业务任务、再次加入画布、修改业务数据库、切分支、提交或推送。临时目录不复制 .env、业务 data 或 .git，测试数据库由各测试单独创建并清理。已有修改与业务数据保留。

## 现场事实与可证实问题

任务 `60fa9703-679d-4f4c-9c53-45ec824a6820`，trace `0f1bef80e2f36e06bd20d728c80a4e10`，北京时间 2026-11-17 13:33:32–13:36:11，选择一场五镜。

三次记录（tool_decision、目录、纠正）均 HTTP 200 且 response_complete=true，未观察到断连；分别记录 269140、273780、274664 input tokens，合计 817584。这是三笔请求累计输入，并非独立原文长度或直接费用。真实业务数据库仅只读检查。

保留的原答声称没有收到当前场次和镜头，返回解释与 fenced JSON，profiles 为空且附带覆盖表和说明；纠正回答仍声称缺少当前范围，转而列出全项目对象，scene_ids 均为 null。

当前旧源码中可复现的缺陷：

- 目录步骤复用完整视觉档案提示词，混合档案 definition、逐镜 shot_usage 和 coverage 要求；“只返回目录”放在后面，当前范围位于大量全项目资料之后。
- scene_ids 是普通字符串数组并默认空数组，缺少当前合法 ID 枚举和至少一项的约束。
- 缺失/null 关联与真正范围外 ID 混用“引用了范围外场次”的诊断。
- 下游对象扩写和覆盖核对重复携带全项目背景，增加输入体积。

历史 wire body 没有保存，仅有 hash，不能断言当时实际传输丢失或完整；模型拒答也不能单独证明传输问题。本次回归通过假 provider 的最终 fetch body 验证当前构造，并新增发送边界检查区分输入组装缺失和模板转换丢失。

## 改动

1. 保留已有 LangGraph 目录→档案→覆盖→业务校验流程。大输入目录使用独立任务，当前完整场次和镜头放在前部；技能选择也读取目录任务，避免先发送完整旧任务。
2. 世界规则和创作约束全文保留，其他背景按相关对象标题、完整子树和当前场次标签筛选、去重；不按字符前后截取。对象扩写仅携带该对象及其关联场次/镜头、相关事实和基础档案。已确认同设计档案固定特征原样复用，仅生成本次用途。
3. 目录 scene_ids 使用当前合法 ID enum 和 minItems=1；单对象用途与逐镜覆盖使用合法 ID 范围约束。保留基础/派生、design 隔离、逐镜用途、coverage 与参考图预算校验。
4. 一次局部纠正只开放失败字段/坏项，保留有效兄弟项及已知身份；根多余字段需要显式删除列表。空目录拒答没有有效项时仅允许一次当前范围目录补丁。不自动将对象绑定唯一场次，不静默删项。业务身份歧义保持失败。
5. 原答、纠正补丁、冻结纠正请求及消耗标记保存为私有检查点；修正持久化 Schema 对 correction_request 的遗漏。重建 app 不再购买纠正且累计 usage.requests 保持不变。旧 exact identity 的目录私有响应存在时，版本升级不会因刷新静默重新请求。
6. 输入组装和最终 provider body 都校验完整范围块。错误分别为 visual_input_assembly_missing 和 visual_input_transport_missing，fetch 前阻止，delivery=not_sent。诊断仅含分区长度、场次/镜头数量、范围 hash、阶段和边界；不含正文或密钥。成功元数据附在真实请求 trace，不伪造结构验证成功事件。
7. 区分缺失关联、真正越界、字段契约、对象/基础关系错误，显示 JSON 字段路径、对象名和可读合法场次。

## 验证

- 旧实现红测 0/3 通过，日志 `/tmp/canvas60-red.log`。
- 新增 `canvas-visual-catalog.test.ts` 11 项、`text-input-scope.test.ts` 3 项，共 14/14 通过，日志 `/tmp/canvas60-new-final.log`。
- 真实 buildApp canvas/prepare → provider fetch 边界，网络限定假域名；一场五镜、大背景、null/空/越界、解释+fenced JSON、局部补丁不可篡改有效项、原答保留、重启/累计请求用量、已确认档案复用、派生依赖、design 隔离和输入模板丢失均有覆盖。
- 相关广测 205 项，202 通过，3 失败；日志 `/tmp/canvas60-regression-final.log`。三个失败在未修改 main 的源码副本逐项同样复现，日志 `/tmp/canvas60-baseline-three.log`：`syntax failure retains complete correction bytes, precise location and used allowance`；`complete unsolicited SSE tool call remains rejected and never exposes its name or input through shape metrics`；`JSON text-only content with tool_use stop reason is distinguishable from a real tool block and remains rejected`。未为通过测试放宽安全保护。
- `creative-model-unit-recovery.test.ts` 的三个未知请求恢复断言在未修改 main 基线同样失败，日志 `/tmp/canvas60-baseline-recovery.log`。未知响应不自动重发的保护保留。
- `visual-profiles.test.ts` 中需监听 127.0.0.1 的 multiview provider 测试受 sandbox EPERM 限制，本次广测用 test-skip-pattern 显式排除，未计入以上 205 项；不声称该项已验证。
- `npx tsc -p backend/tsconfig.json --noEmit` 通过；`npm run check` 架构和 UI 规范检查通过。

复现命令：

```sh
node --import tsx --test backend/test/canvas-visual-catalog.test.ts backend/test/text-input-scope.test.ts
node --import tsx --test --test-skip-pattern='mock provider receives a confirmed multiview board' backend/test/canvas-visual-catalog.test.ts backend/test/text-input-scope.test.ts backend/test/script-canvas-preparation.test.ts backend/test/visual-profiles.test.ts backend/test/visual-profile-state-inheritance.test.ts backend/test/storyboard-reference-budget.test.ts backend/test/script-generation-steps.test.ts backend/test/generation-private-response-store.test.ts backend/test/model-output-checkpoint.test.ts backend/test/model-result-observation.test.ts backend/test/text-request-plan.test.ts backend/test/text-context.test.ts backend/test/langfuse-tracing.test.ts backend/test/text-anthropic-protocol-shape.test.ts
npx tsc -p backend/tsconfig.json --noEmit
npm run check
```

## 请求体测量与限制

同一合成 fixture、同一假 provider 入口，包含一场五镜、大量其他地区背景和已确认人物事实，skill_ids=[]：

| 最终请求 | 旧实现 bytes | 新实现 bytes |
| --- | ---: | ---: |
| 目录 | 1089030 | 6771 |
| 人物档案 | 1100109 | 16311 |
| 道具档案 | 1100105 | 16283 |
| 逐镜覆盖 | 1090557 | 15315 |
| 合计 | 4379801 | 54680 |

该 fixture 请求体合计减少 98.75%。没有自动技能选择调用，因此不是现场三笔请求的直接一一比较，也不代表真实 token、费用、延迟或模型成功率改善。原场次/五镜完整范围证据没有截短；只读资料测量中相关事实由 207883 字符筛选为 30213 字符，完整范围证据另行保留。无真实模型重跑，实际生成质量与线上耗时尚未验证。

## 补丁交付

`/tmp/canvas-60fa9703.patch` 仅包含本轮相对原 main 工作目录的增量，不包含 main 原有其他修改或真实业务资料。补丁已通过 main 应用预检查并写入，原有改动保留；该补丁与 manifest 作为应用时快照保留，本文和计划中的落地状态随后单独更新。未提交或推送。
