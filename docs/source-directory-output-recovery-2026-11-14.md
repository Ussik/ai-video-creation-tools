# 原稿目录输出截断恢复（2026-11-14）

## 实际故障

2026-11-14 01:38:49–01:39:19（Asia/Shanghai），18,358 字原稿在目录第 1/2 页失败。Langfuse trace `8eaf39a026d9b6fc136ff4bcc364ce5e` 对应根任务和目录生成两条 observation；没有删除或重试这些真实记录。

- 模型 `gemini-3.8-flash`，Responses 协议，HTTP 200、delivery completed。
- 唯一一次请求返回 `max_output_tokens`，输出 8,188 tokens；不是未确认派发或普通网络断流。
- 模型配置使用 upstream 输出模式；没有显式发送输出额度参数。无法独立证实上游精确默认额度，不能直接认定为 8,192。
- reasoning tokens 未报告，不能把任务汇总中的 0 当作实际没有推理消耗。
- 旧目录生成要求整页完整 JSON，遇明确输出截断直接停止，未保留其中的闭合条目。既有全剧整合/核对分页不能自动覆盖这条目录路径。

## 实现

`backend/src/modules/script/script-source-map-output.ts` 保持正常路径一次完整目录请求。仅初次文本输出额度耗尽、且没有完整候选待格式修补时，切换为完整目录条目的续传协议：

1. 通过严格 JSON 语法前缀解析保留已经完整闭合的 sections；半截条目不会修补或接受。
2. 校验字段和真实目录起点/递增边界。只对已支持且无冲突的 `characters.details`、`events.description` 做无损归一；完整续页和再次截断续页使用同一规则。
3. 用现有 generation steps 和分页实现，把 prefix、输入哈希和分页大小保存到 `work.output_checkpoint.pages`。下一请求前同步保存；暂停、断流及进程重建后从 pages 恢复，不重复原始整页请求。
4. 每次仍包含完整原稿与相同 output_window。只限制当次返回的新条目数量，不改变原文、事实密度、用户模型或输出/思考配置。
5. 最后一条的结束边界依赖后继，所有 prefix 均保持私有；仅 explicit complete 后转为候选，再经过原有章节边界、原文证据及独立质量核对。
6. 没有新完整条目时按既有 8→4→2→1 缩小，仍无进展则停止；已明确的纯推理耗尽直接透传，不靠重复分页消耗。

目录固定 work plan、pipeline version、revision reuse 页索引未改；旧完整 raw/correction 候选继续原格式修复流程。实际进展指纹原本包含整个 output_checkpoint，无需另改。续跑说明会显示当前页已保存的完整条目数。每个续传检查点只写一次快照。

此前失败的旧任务没有保存页内前缀，本次重试会从其原未完成页进入新恢复路径；不会凭空恢复旧版未持久化的输出。

## 验证

- 独立 helper 回归先红后绿，10/10：闭合前缀、半截条目排除、全文上下文、断流恢复、非法边界、无进展停止、纯推理耗尽、格式修补候选保留及续页再次截断的字段别名。
- 集成新增 2/2，所在文件 8/8：65,594 字/59 集 fixture 在第一目录页截断后保留 2 条，续页 2→10→18 后补齐，最终 177 段且独立质量通过；中途失败后重建 analyzer，只续传原页，前缀不发布。
- 相关后端回归 551/551 通过，日志 `/tmp/source-directory-output-regressions-20261114.log`。
- `npm run build` 通过，日志 `/tmp/source-directory-output-build-20261114.log`；仍有既有的前端 bundle size 提示。
- `git diff --check` 通过；本地后端 `/api/health` 返回 `{ "ok": true }`，监听进程 cwd 为主仓库 backend。
- 独立只读审查发现的续页截断 alias 缺口已修复并增加红→绿用例。

以上使用临时数据库和模拟模型验证恢复契约。没有重新派发真实分析，没有更改真实原稿、模型设置或 Langfuse 记录；不能据此声称真实模型已成功或测得实际速度/成本改善。

## 本轮范围

真实目录 `/Users/caoyanzu/workspace/ai-video-creation-tools`，分支 main。保留之前全部未提交修改；本轮没有 commit 或 push。受影响旧文件的改动前基线在 `/tmp/source-directory-output-baseline-20261114/manifest.json`。
