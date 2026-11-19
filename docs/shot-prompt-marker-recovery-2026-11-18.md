# 分镜提示词未闭合画风标题修复

修改位置：`/Users/caoyanzu/workspace/ai-video-creation-tools`，分支 main。保留原有未提交改动；不提交、不推送，无真实模型调用。

## 原因与修复

分镜模型的图片来源文本包含 `【项目画风约束】`，但无对应结束标记；后面还有完整的本镜首帧构图区。画布正文、基础提示词与旧模板原样继承，旧模板另有真正的画风区。旧恢复只支持已闭合的外层区块，无法恢复这种来源正文；画风正则替换还可能把未闭合标题与后面的真画风区一起吞掉。

- 两种分镜模型输出契约在解析时将保留标题转为普通全角标题；使用 string overwrite 保持 JSON Schema 可导出。手动提交契约不做这种转换。
- 摄影事实和画风上下文进入编译区块时转义嵌入的保留标题，保留全部文字。
- 画风替换只移除完整且有效的区块；未闭合的手写正文保持原样，并继续显示校验错误。
- 仅在当前分镜来源、节点 prompt、prompt_base、prompt_body、完整 body 区块与旧模板前缀精确匹配时恢复继承内容。拒绝手写差异、重复来源和不完整模板。引用与区块 ID、删除标记保留。
- 正常画布同步、加载、历史恢复使用同一恢复函数，经原有 revision、冲突检查和自动保存队列持久化。

## 当前节点核对

节点 `3532db57-3027-4d19-91c7-3f81f865e5b5` 已通过正常画布保存恢复；随后通过只读 API 重载核对。原始快照重放与现存节点的 text、prompt、prompt_body、prompt_base、prompt_template、prompt_sections 逐字段匹配。正文恢复前后均为 1129 字，只改保留标题的括号；分镜原始文本、区块 ID 保留，整理作用域不再返回未闭合标记错误。未直接修改 SQLite。

## 验证

- 先运行真实结构回归：15 通过、1 失败，错误精确为缺少项目画风结束标记；修复后该回归通过。
- 提示词、区块、画风、正式画布 API 保存重载及生成提交契约：后端 75 项通过。
- 画布恢复、编译、区块身份、整理作用域和整理交互：前端 37 项通过。
- 两种分镜规划路径扩大回归：106 项，100 通过、6 失败。6 项失败在去掉本次后端补丁的临时副本也全部复现，涉及旧重试次数与准备来源状态；未将其计为通过。
- 完整构建与 `git diff --check` 通过。构建仍有现有的大包体积提示。

本机证据：`/private/tmp/prompt-marker-backend-tests.log`、`/private/tmp/prompt-marker-web-tests.log`、`/private/tmp/prompt-marker-planning-tests.log`、`/private/tmp/prompt-marker-baseline-tests.log`、`/private/tmp/prompt-marker-live-verification.json`、`/private/tmp/prompt-marker-build-20261118.log`。原始节点快照为私有临时文件，没有加入仓库。
