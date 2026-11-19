# Canvas Dialog Actions Implementation Plan

**Goal:** 精简两个加入画布入口，保留恢复能力和显式授权。
**Architecture:** 恢复操作移入可滚动状态区，页脚只保留关闭和主动作。复用原 API 与确认流程，自动状态读取合并并限制次数。
**Tech Stack:** React, Mantine, TypeScript, node:test.
**Spec:** 本次用户批准的加入画布弹窗按钮精简要求。

## Global Constraints
直接在 main 修改，保留已有改动与数据；不调用付费模型，不提交推送，不写生产业务状态。

## Review Focus
旧参考展开后的放弃操作仍需确认；未知响应只能显式核对或授权重做；关闭不终止后台；读失败只重读；两个入口窄屏页脚不堆叠辅助操作。

### Task 1: 状态区与页脚
- [x] 修改 ReferencePreparationRecovery.tsx 与两个调用入口、对应 CSS；确认弹窗与所有动作身份保持。
- [x] 更新三个现有回归测试文件，验证旧参考、恢复读取、采用及关闭行为。

### Task 2: 自动读取与验证
- [x] useCanvasPreparationRecovery.ts 合并并发读，最多自动轮询 12 次，出错停止；保留显式重试。
- [x] 运行三个相关测试文件及 npm run build；离线 Ego Lite 查看桌面和窄屏，不触发生产请求。

## Verification

- 三个相关测试文件：112 项通过，覆盖两个入口和临时数据库中的真实恢复 API；提供方为 mock。
- npm run build：架构检查、UI检查、shared、backend、web 构建通过。
- Ego Lite：隔离预览桌面与390px窄屏检查，通过；展开旧参考后页脚保持单行且无横向溢出。
- 整理参考确认打开后取消：仅离线恢复读取，无模型请求。预览已停止，任务页已关闭。
- 本次修改在 /Users/caoyanzu/workspace/ai-video-creation-tools 的 main；未提交、未推送、未写生产数据库。
