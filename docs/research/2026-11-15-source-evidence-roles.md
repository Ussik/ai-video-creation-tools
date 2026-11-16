# 原稿分析：证据角色、事实存储与付费回答复用

## 交付范围

本轮在真实 main 的既有未提交修复之上做增量修复；不创建新业务分析，不新增模型调用，不切换模型或配置，不清理原稿、业务历史、检查点，不 commit/push。开发验证先在 `/tmp/source-evidence-roles-20261115/mirror` 完成，再按基线文件 SHA-256 校验应用到 `/Users/caoyanzu/workspace/ai-video-creation-tools`。旧 worktree 不承载本轮交付。

本报告区分代码完成、保存回答可本地复用、整体业务通过三件事。坐标检查通过不等于语义正确；本轮没有独立语义模型审读，也没有将真实分析标记 ready。

## 问题与通用修复

1. **完整回答被解析门禁拒绝。** 保留上一轮的受限兼容：局部纠正可使用一个唯一完整 JSON 围栏，围栏外只能是有限普通说明。多围栏、多根、截断、非法 JSON、思考标签或含结构的附加内容仍不接受；不从碎片猜测完整修补授权。
2. **让模型重抄程序已经持有的文字。** 新目录局部协议只返回 evidence 及原证据的逐项处置；name、description、summary 和合法兄弟项从冻结候选恢复。常规证据修补也只返回 kind/index/evidence。历史协议只用于精确命中的完成回答重放，不用于派发新请求。复查另外修复了长人物 description 被旧 160 字分支写成 undefined 的遗漏。
3. **把人物背景身份、本章出现和事件发生混为一谈。** 新 evidence 保留主引用、可选 occurrence_unit_id、supporting_unit_ids。人物跨章身份需要另有本章出现证据；事件主引用必须在本章，不能使用 occurrence 绕过。所有 ID 必须指向真实非空原文；辅助引用不得重复或重复主引用。
4. **机械压缩多证据与内部展示限制。** 每个旧引用必须有 primary/supporting_context/not_supporting 的明确处置；被认定为 supporting_context 的引用全部保存，不机械取数组首项。事实存储移除人物描述/事件摘要 160 字、每章人物/事件 24 项和线索展示上限，不截字、不丢否定、数量或前提。章节覆盖、结构上限、非空、姓名/标题和请求分页等实际约束仍保留。
5. **证据角色在下游丢失。** 原文解析、全包覆盖、全剧整合、独立质量审查、定点内容修补、修订复用及 UI 都保留角色与辅助链。修订按每条引用自身的位置映射；若前章背景被编辑，即使本章未变也不能沿用失效证据。
6. **一项失败拖掉合法兄弟操作。** 合法操作与剩余失败键保存于 private local_repair，并绑定 input/correction/candidate 三层哈希。`remainingSourceMapLocalRepair` 只从未完成候选生成剩余目标计划；不授予第二次纠正额度、不自动派单。重复继续优先本地重验完成回答，不能清除 correction/correction_started 或未知请求保护。整份内容仍须通过最终结构、原文覆盖和独立语义审查才能进入正式业务。
7. **契约升级隐式重新生成。** 冻结旧 schema/prompt，仅当旧 input hash 和旧纠正请求 hash 精确匹配时使用已保存回答；原始 raw、correction 原文、派发 intent 均保留。身份不匹配/历史分页不兼容时保留现场并返回恢复冲突。没有通用的猜测迁移，也没有以升级为理由重置额度。
8. **错误提示把历史错误当成最新原因。** 分开显示 format/evidence/content/recovery 与当前失败；历史诊断放入独立折叠。格式不合法明确不等于剧本内容质量失败。初始和包装后的格式/恢复错误同样分层。
9. **新增可选字段引出的通用回归。** 扩大测试发现通用 structural repair 将严格 wire schema 当成本地 schema 使用，导致新增可选证据字段被误判缺失。已分离本地 schema 和严格 wire schema，恢复可选 null 后再局部合并，原有合法字段仍由程序持有；原请求的严格 wire 形状保持一致。

10. **省略无操作集合触发额外纠正。** 目录边界补丁只返回 starts 或 prefix_sections 时，另一个缺失集合本地规范为空数组；这不产生任何新增操作。显式 null、未知字段、两个集合中相互冲突的操作仍保留并拒绝。为防止证据 Schema 升级绕过已有付费回答，边界步骤在新请求前只读查询代码持有的旧 wire Schema；仅精确命中相同 source/configuration scope、模型、提示词、Schema、当前 run 的完成回答才重放。命中后任何格式、领域或未知交付失败都停止，不能回退成一次新付费请求；只有完全没有该旧回答时才走正常新请求路径。

### 效率边界

一次纠正仍只拥有固定失败项；新协议不重抄合法事实，不为 160 字/24 项展示限制消耗纠正请求。原文在资料中提供一次，辅助引用在独立审查中用坐标表达；局部应用复用 unit ID 索引。没有新增完整重生成循环、语义审查调用或自动重试额度。本轮未做付费延迟基准，不能宣称实际模型耗时或成功率已经量化改善。

## 两份真实保存回答的离线重放

原稿长度 11,377 字符，原稿 SHA-256：`ed73343f48c1efdbb1716cdf180ca404f121a1ee3d920324b7f2e35d7558c0f2`。

| 保存分析 | 局部目标 | 合并后人物/事件 | 结果 |
| --- | --- | --- | --- |
| `eec1f3216c384328b4b0c84abe30527e` | 43 | 15 / 61 | 目录 schema、真实引用及全文连续覆盖通过 |
| `4271ef1b3a3a4f0591c370ae938682ac` | 43 | 15 / 60 | 目录 schema、真实引用及全文连续覆盖通过 |

两份重放均禁止 provider 访问，实际 provider_calls=0；分别保留 724 / 709 条辅助关联。旧回答的 review 以原目标为粒度，拆分事件可能共享支持上下文，因此该数量不代表独立事实数量，也不代表语义已经通过。

争议人物条目保留原主引用 228，另以本章引用 339 表示 occurrence，没有将前章身份引用替换成本章引用。历史迁移只接受已保存 review 明确列为 supporting_context、在本章内且包含完整精确姓名的唯一引用；模糊别名、多候选、无明确 review 均停止。编号只来自上述真实样本；程序没有硬编码人物、项目、编号或剧本名称。

两份结果还通过纯函数构造独立审查资料，确认 228/339 的事实/出场角色保留。没有运行独立语义模型，整合与最终独立核对仍需后续业务执行。

原始初始回答 SHA-256：`39adc7915e148f9002e6e6c85b066279968a4cb2dda2627c85888a17529fc47d`。

两份纠正回答 SHA-256：
- `fc4bd5ea8e0707d10622e4f343982750e289e479ce99082f746baaa901cbfff8`
- `66b75760922c7c264140f3152185c279f58e92c7e6b7b2b4845e9ae742c10ec0`

重放核对 input_hash、original_raw、correction、correction_started 全部不变；规范化候选只在临时副本中更新，没有写入真实业务数据库。响应与原稿全文不写入仓库报告。

## 验证

真实 main 验证结果：

| 项目 | 基线 | 本轮 main |
| --- | --- | --- |
| 扩大后端回归 | 1,117 通过 / 8 失败 / 1 跳过（1,126 项） | 1,137 通过 / 8 失败 / 1 跳过（1,146 项） |
| 原稿上传、状态和恢复前端 | — | 27 / 27 通过 |
| shared 编译、backend/web 类型 | — | 通过 |
| 架构/UI 约束、git diff --check | — | 通过 |
| 两份旧回答及当前边界回答在 main 源码上重放 | — | 目录结构、引用和全文覆盖通过，0 provider calls |
| 后端 8000、前端 8888、8888 API 代理 | — | 首页和 health 均 HTTP 200 |

扩大后端命令：

```bash
cd backend
node --import tsx --test test/script-source*.test.ts test/source-*.test.ts test/model-output*.test.ts test/generation-*.test.ts test/script-generation*.test.ts test/script-review*.test.ts
```

该结果不是全仓库测试全绿：仍有明确的基线失败。没有将小范围通过代替扩大验收。main 与 baseline 的失败名逐项一致，新增 20 项后端测试通过。前端执行 `script-source-upload.test.tsx` 与 `script-source-request-recovery.test.tsx`。

离线日志均位于 `/tmp/source-evidence-roles-20261115/`，不作为业务历史写入：`main-expanded-complete.log`、`expanded-baseline.log`、`failure-comparison-main.json`、`main-web-final.log`、`main-real-replay-complete.log`。

37 个增量文件分两批应用前后逐项核对 SHA-256；检查了最初 main 中 1,645 个既有仓库文件，所有本轮范围以外文件保持原样。应用和验证前后对 83 张业务表的 schema、行数、内容指纹进行只读比较，无变化。shared 使用直接 tsc 更新产物，未运行 clean build；没有强制终止或重新启动服务。

已确认的基线失败：相同扩大测试在修改前也有 8 项失败（含父子计数），涉及 `script-source-outline-integration.test.ts` 的旧 mock 契约与 `script-source-story-parts.test.ts` 的未知纠正重发预期。失败名已逐项与补丁结果对齐，见临时 `failure-comparison.json`。没有修改这些用例来掩盖失败。

## 当前业务状态与限制

- 旧两份回答可以安全本地复用目录阶段；后续全剧整合与独立语义审查并未执行，不保证 ready 或第一集正文已完成。
- 保留未知请求保护；没有额外付费授权，剩余计划也不能自动生成第二次纠正。
- 历史分页身份升级当前保守停止，不宣称任意旧分页都可自动恢复。
- 应用前发现用户已有新分析 `d91bd46452c649d6b0089e3882e4afe8` 在运行，因此等待其自行结束后才安排热更新，没有取消、重发或覆盖该任务。
- 该新分析后来停在目录边界修补：首份已付费回答只有 starts，将原索引 0 的起点由 5 改为 0；原程序因缺少空 prefix_sections 另发纠正，后份回答同时改变索引 0 并添加起点 0/5 的前缀，违反互斥与连续边界硬约束。不能通过丢掉某个冲突操作采纳后份回答。
- 添加无操作集合规范化后，已从 4 份保存回答中精确命中首份边界回答。请求 key 为 `5daeec3f947a66d5d0b3cffd7d31c4bde7f13cfed82b87dab32356289b1f091b`；只读缓存访问 1 次、provider_calls=0、business_writes=0。本地副本仅将第 1 节起点 5 改为 0，64 节的文字、其他边界全部不变，引用与 11,377 字符全文连续覆盖通过。旧冲突回答和失败历史未删除。
- 因此当前目录阶段已证明可从原完成回答安全复用；真实任务仍保留原失败状态，未在本轮实际启动继续。全剧整合、独立语义核对等后续阶段可能需要新模型调用，本轮不执行、不标 ready。临时证据见 `current-boundary-replay-results.json`。
