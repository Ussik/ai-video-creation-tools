# 对白技能安装与加载核验

日期：2026-11-08。安装位置为本项目技能中心的 `data/studio.db`，未安装到 Codex 全局技能目录。

## 安装结果

| 技能 | 操作 | 来源目录 | 固定版本 | 启用环节 |
| --- | --- | --- | --- | --- |
| `sw-dialogue` | 新增并启用 | `jtydhr88/screenwriting-skills` → `plugins/screenwriting/skills/sw-dialogue` | `51115f18d160aa8b2ac5813e4432b6f0b425358f` | `script` |
| `humanizer-zh` | 新增并启用 | `op7418/humanizer-zh` → 仓库根目录 | `f4518a8eab97b8bfebc66a89d34320a89bef6930` | `script` |
| `short-drama-write` | 更新已有安装 | `zenstory-ai/drama-skills` → `skills/short-drama-write` | `3d813c30871b4db5f2387d83bdc3a49db8ce7b2b` | 保留原 `script` |
| `short-drama-review` | 更新已有安装 | `zenstory-ai/drama-skills` → `skills/short-drama-review` | `3d813c30871b4db5f2387d83bdc3a49db8ce7b2b` | 保留原五个创作环节 |

全部通过本机 `/api/skills/install`、单项更新和启用接口完成。安装前备份位于 `data/backups/2026-11-08-dialogue-skills-before-115629.json`，包含原技能安装数据、来源和全局/项目默认配置。

全局及项目默认配置均与安装前一致；剧本默认主技能仍为 `short-drama-write`。原有技能的启用状态和适用环节保持一致，除上述两个更新项外的原技能记录未变化。未修改模型配置。

## 参考资料加载修复

原参考文件筛选未覆盖对白专项资料。现在仅在 `script` 环节按技能名加载明确依赖：

- `short-drama-write`：`references/dialogue-craft.md`。
- `short-drama-review`：`references/anti-template-repair.md`。
- `sw-dialogue`：`reference.md`。

无关技能的同名 `reference.md` 不自动加载；其他环节沿用原筛选规则。每技能 100,000 字符上限、选择逻辑和应用输出契约保留。

## 验证

- 回归测试先复现参考正文缺失，再验证正文、已加载文件元数据、无关技能隔离和跨环节隔离。
- 技能安装、更新、选择与自动分配相关五个测试文件：53/53 通过。
- 后端 TypeScript `--noEmit` 检查及 `git diff --check` 通过。
- 通过当前运行后端的 `/api/projects/:id/script/generate/prompt` 只读预览核验四项技能。上述三份参考资料的完整正文均实际出现在返回提示词中，并非仅有链接；单项预览分别约 2.29 万、2.91 万、1.87 万、1.65 万字符。
- 未调用文本、图片、视频或配音生成接口，未修改项目剧本。

## 使用方式

在导演对话的本次技能选择中，写初稿可使用 `short-drama-write`；已有正文按场修订台词可临时选择 `sw-dialogue`；审稿可另起一轮选择 `short-drama-review`；中文套话润色可按需选择 `humanizer-zh`。临时选择不修改默认配置。

修订时明确保留剧情事件、人物关系、知情范围与题材语言风格。技能已安装、规则已加载不代表已验证实际对白改善；后续应使用同一场戏做真实模型前后对照。

随后按用户授权实现了九种具体功能的固定默认分配、主辅配置与“改台词”入口，详见 [按功能固定技能与验证记录](2026-11-08-fixed-creation-skills-validation.md)。上述安装记录中的“默认配置不变”描述的是安装阶段；固定分配沿用原有五环节配置，并增加任务级配置。
