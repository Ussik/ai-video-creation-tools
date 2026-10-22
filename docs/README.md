# 文档索引

> 更新：2026-10-22；当前实现基线 `9ba5a25`。代码是行为与参数的依据，旧测试数字只代表对应日期的验证结果。

## 项目概览与开发

| 文档 | 用途 |
| --- | --- |
| [项目 README](../README.md) | 安装、启动、创作流程、厂商配置与已知边界 |
| [当前状态](current-status.md) | 当前能力、尚缺内容、最近构建及测试失败记录 |
| [产品分析](product-analysis.md) | 产品范围、后续优先级及早期试制需求的当前落实情况 |
| [目录规范](project-structure.md) | 前后端、共享包、数据与生成物位置 |
| [前端设计系统](frontend-design-system.md) | Mantine 控件、样式令牌与交互约定 |

## 剧本、原文与模型上下文

| 文档 | 用途 |
| --- | --- |
| [阶段创作流程](model-intent-workflow.md) | 讨论、提案、阶段生成、草稿和正式保存的关系 |
| [模型交互机制](model-interaction-controls.md) | 提示词、结构化输出、原生函数与程序控制的职责 |
| [原文上下文](script-source-context.md) | 上传、全文/局部上下文、分析结果与有效稿的使用 |
| [分析成本控制](script-analysis-cost-control.md) | 缓存、增量复用、请求预算与用量统计的作用域 |
| [剧本质量增强](script-quality-enhancements.md) | 评审、修订次数、证据、草稿与保存校验 |
| [剧本任务恢复](script-task-recovery.md) | 服务端任务、事件、暂停/停止/继续、超时与断点 |
| [文本模型上下文容量](text-model-context-capacity.md) | 上下文配置、容量检查和超限处理 |
| [文本模型输出限制](text-model-output-limits.md) | 输出上限、协议字段与调研数据的适用边界 |

## 画布、视觉与成片

| 文档 | 用途 |
| --- | --- |
| [项目多画布](project-canvases.md) | 普通画布、独立方案、资源共享与成片范围 |
| [多节点画布性能](canvas-performance.md) | 可视区渲染、媒体预览、选择和动画策略 |
| [镜头引用](shot-reference-usage.md) | 设定版本、出镜范围、参考图用途和提示词引用 |
| [多视角参考工作流](multi-angle-reference-workflow.md) | 参考图登记、裁切、生成、确认与继承 |
| [Seedance 2.0 提示词](seedance-2-0-prompt-workflow.md) | 方言、技能、引用上限与生成前校验 |
| [标准音色配音](tts-standard-voice-workflow.md) | 配音配置、候选选用、入片放置与混音 |

## 调研与历史记录

以下文档保留调研或样片审核背景；外部能力、历史缺口和旧路径需结合文档中的当前实现说明阅读。

| 文档 | 用途 |
| --- | --- |
| [提供商协议调研](model-provider-integration-research.md) | 接入协议对比与当前通用 HTTP 配置边界 |
| [成熟项目剧本编辑器分析](mature-project-script-editor-analysis.md) | 早期交互对比及当前实现映射 |
| [《听雷桥》样片审核](tinglei-bridge-quality-review.md) | 早期 45 秒样片问题与当前工具能力的区别 |

根目录 [task_plan.md](../task_plan.md)、[findings.md](../findings.md) 和 [progress.md](../progress.md) 为早期开发记录，保留原始过程，不用作当前功能清单。[封面素材说明](../web/public/topic-art/covers/README.md) 记录静态资源映射与兜底图。
