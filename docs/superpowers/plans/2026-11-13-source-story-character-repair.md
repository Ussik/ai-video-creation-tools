# 全剧整合人物定点修复 Implementation Plan

**Goal:** 修复短稿整合漏人物、称呼不一致造成的重复全文生成，保留完整候选并只修人物。

**Architecture:** 复用结构输出持久检查点，在私有 story_candidate 保存整合候选。LangGraph 子图校验目录姓名覆盖，按完整原文补缺失角色或为已有角色增加有证据的别名；通过全部既有校验后发布 story，独立全文核对继续执行。

**Tech Stack:** TypeScript、Zod、LangGraph、SQLite 快照。

**Spec:** 当前用户截图和真实已保存结果：刀疤刘手下、车夫遗漏；码头工头未保留工头称呼。

## Global Constraints

- 直接在 main 工作，保留此前未提交修改；本轮不自动提交或 push。
- 保留24段目录及候选非人物字段；不删除人物覆盖保护，不按字符串相似性自动合并身份。
- 原文是数据，不能执行其指令；补丁人名、别名和章节必须有证据。
- 沿用累计预算、取消和未知派发保护；prepared/failed 不能自动再次派发。
- 不触发真实付费整轮分析，不改正式创作成果。

## Review Focus

- 群体角色须保留群体性质，不能凭空命名或归并成头目。
- 别名增加须说明同一身份的原文依据；字符串包含关系不足以证明同一人。
- 非人物信息、合法人物描述和原有姓名、别名、引用不被补丁改写。
- 取消、保存失败、坏补丁及重放都保留候选，未通过结果不公开。
- 显式继续保留完整候选；原文/目录/配置改变使旧候选失效。

### Task 1: 人物定点修复子图

Files: 新 backend/src/modules/script/script-source-story-character-repair.ts 和对应 test。
Interface: repairSourceStoryCharacters(state, candidate, source, generate, options) -> ScriptSourceStory；checkpoint 记录候选和诊断哈希及 prepared/completed/failed。

- [x] 添加真实形态遗漏、别名、越权补丁、错误证据、取消和零请求重放回归。
- [x] 实现 validate -> repair -> validate，补丁仅允许新增缺失人物和补充已有角色别名/别名来源。
- [x] 运行子图测试并审阅安全边界。

### Task 2: 短稿候选持久化与恢复集成

Files: script-source-story.ts、共享分析类型、script-source-checkpoints.ts、script-source-recovery.ts、script-source-analysis.ts、script-source-documents.ts、相关 tests。
Interface: 私有 story_candidate 绑定原文/目录/模型/配置，保留 result/output_checkpoint/character_repair；候选不作为正式 story。

- [x] 结构与人物覆盖校验分离，候选有效后保存并调用子图；无问题不增加模型请求。
- [x] 集成公开隐藏、进度指纹、重建清理和显式恢复。
- [x] 验证失败候选恢复不重生成、字段不丢和独立质量核对仍执行。

### Task 3: 历史候选只读重放与验证

Files: docs/source-analysis-directory-repair-2026-11-13.md、docs/script-source-context.md。

- [x] 核对真实保存候选诊断并以模拟协议验证字段保留与精确请求数。历史全文重放未完成：验证末尾原稿和分析快照已不存在，不从模型输出逆造原稿。
- [x] 运行相关测试、类型检查与构建，独立审阅。
- [x] 确认 main 服务可用、Langfuse 追踪配置及此次失败追踪情况，记录真实验证边界。


## Verification

- 人物/整合/候选/质量与请求恢复相关回归 161/161；最终控制、检查点、公开响应与追踪策略回归 64/64，共225项通过。
- 项目 npm run build 与 git diff --check 通过；保留现有前端大包提示。
- 独立审阅发现并修复新增人物无依据别名合并、连续排队暂停丢失旧响应继承链两项问题。
- 后端8000及前端代理8888各四项只读API检查均200。
- 本次失败的Langfuse trace已只读确认，不重新写入、不补造历史追踪；未调用真实模型，未写业务数据。
- 用户项目在诊断之后的只读复查中已经没有原稿和分析快照，因此没有真实整轮重跑，不能宣称实际模型已通过分析。
