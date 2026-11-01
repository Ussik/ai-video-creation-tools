# 模型选技实施记录

用户要求以模型判断替换关键词匹配，行为类似现有 Function Calling。

已实施：

1. 自动入口仅提交手动覆盖，界面显示等待模型选择。
2. 导演开放技能目录并由 load_creation_skills 接收模型选择和理由。
3. 独立创作入口使用当前文本模型原生 select_creation_skills 选技，再加载规则生成内容。
4. 保留手动空选、启用／环节／数量校验、单次执行冻结及原授权边界。
5. 移除旧共享正则推荐器，补充模拟模型和入口测试。

实际机制与限制见 docs/task-skill-assignment.md。旧 task-skill-assignment 计划记录的是已被替换的关键词实现，不再作为当前行为说明。
