# Appearance Evidence Implementation Plan

**Goal:** 修复不连续引文被反复纠正和覆盖上限无说明，同时保留旧账本、成功档案及全部原答。
**Architecture:** 保留仲裁旧身份与旧规范化结果契约；新派发契约只返回程序给定的同阶段证据 ID，程序解析回原文。局部修补只处理错误字段；已用次数与交付未知保护仍归原账本。
**Tech Stack:** TypeScript, Zod, Fastify, React/Mantine, node:test, Ego Lite.
**Spec:** 当前用户授权直接 main，本地验证；无付费调用，无提交推送，无业务数据变更。

## Tasks
- [ ] 1. `backend/test/visual-appearance-evidence.test.ts`: 原文中间省略一段再拼接应给精确错误；纠正只包含失败对象该阶段证据，不改 visible/phase/relation。
- [ ] 2. `visual-appearance-evidence.ts` 与 `visual-appearance-arbitration.ts`: 生成 source-version 绑定连续短句 ID，同阶段枚举；未知 ID、旧版本 ID、错误阶段均拒绝。保留 legacy prompt/schema 作为账本身份。
- [ ] 3. `model-output.ts` 与 `visual-coverage-unit.ts`: 显式区分派发契约与规范结果契约，按真实派发契约精确读取已完成响应；旧上下文及4次实际上限不重置。原答只读复用，经完整本地验证后才采用。
- [ ] 4. `canvas-preparation-runs.ts`, `reference-failure.ts`, 两入口：覆盖单项已到上限时提供准确说明、详情与人工处理路径，隐藏无可执行动作的“继续覆盖检查”；成功档案保留。
- [ ] 5. 离线原答/上限/交付未知/两入口回归，构建与隔离浏览器验收。记录已知其他未通过测试。

## Review focus
- 派发契约升级不能新建预算。
- 证据 ID 必须来自本镜、本阶段、本来源版本；不得填首句来改变语义。
- 同阶段不连续旧引文只报错，不自动推断恢复；仍允许安全的原样本地重新校验。
- 局部证据修补不包含其他成功对象或阶段，也不能改可见性及关系。
- 两入口与关闭/重开/停止运行保护维持。
