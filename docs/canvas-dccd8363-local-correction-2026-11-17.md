# dccd8363 画布局部纠正衔接修复

## 范围与现场

直接修改 `/Users/caoyanzu/workspace/ai-video-creation-tools` 的 main，保留已有改动和业务数据。本轮没有调用真实模型、恢复业务任务、自动加入画布、提交或推送。

任务 dccd8363-c5ce-4d58-a1d5-011e6223ff13，trace 7f8eb46c4207e704e2d0bec0c7670310，北京时间 2026-11-17 15:18:27–15:19:41。现场两个请求均 HTTP 200 且完整返回，但目录使用了 category/name_zh/name_en/prompt_names/definition 方言，并包含 definition 引号语法问题。没有发出纠正请求。

程序的通用解析器可恢复完整根，但局部纠正入口不接受该语法恢复结果，导致无法安全定位纠正目标。模型没有遵循目录 Schema；现有技能和 trace 证据不足以认定某个技能造成格式污染。

## 实现

- 新增完整、唯一目录根证明；仅允许 definition 字符串的唯一插入反斜杠恢复，保留原答、候选及哈希/偏移审计。
- 候选仅供诊断和一次局部纠正，不能直接成为业务结果。多根、嵌套片段、重复键、截断和歧义均拒绝。
- 纠正只允许失败规范字段及明确确认的额外字段删除。保留合法场次、基础关系、state_delta 和有效兄弟项；不自动重命名别名，不猜测冲突身份。
- 纠正后继续完整 Schema、身份和范围校验。未知或耗尽的纠正保持冻结，重启不增加请求。
- 目录原生提示明确字段契约；错误主提示缩短，完整诊断与原答保留在默认折叠、限高滚动的详情中。

## 验证

- 本次核心回归 23/23 通过，含真实原答的本地回放、fake provider 完整 prepare 链路、私有候选持久化、重启不重发及字段保护。日志 `/tmp/dccd8363-core-verified.log`。
- 后端广测 207 项，201 通过、6 失败；6 项在本轮修改前源码副本中同样失败。日志 `/tmp/dccd8363-regression-final.log`、`/tmp/dccd8363-baseline-validation.log`。
- 额外解析回归 32 项，29 通过、3 失败；3 项均在修改前副本重现，涉及已耗尽纠正本地恢复、未知纠正保护及串并行恢复。日志 `/tmp/dccd8363-parser-regression.log`、`/tmp/dccd8363-parser-baseline.log`。未为绿灯放宽保护或修补其他范围。
- 前端 StoryboardPlanner 60/60 通过；前后端 TypeScript、npm run check、git diff --check 通过。
- Ego Lite 在隔离页面使用合成数据和完全拦截的 fetch，未触达真实业务后端。760×560 视口下详情高约 190px 且可滚动，footer 与确认按钮可见、可点击；无 commit/canvas 请求。截图 `/tmp/dccd8363-browser/expanded-small-verified.png`。隔离浏览器空间和服务已关闭。

## 限制

真实原答只在本机临时文件回放，没有写入仓库测试夹具；测试使用匿名同结构数据。以上证明程序纠正链路和界面行为，不证明真实模型下一次一定产生合格内容。既有失败仍需单独处理。
