# Task Plan: LibTV故事板对照与修复

## Goal
操作LibTV故事板，修复本地故事板的数据、导航、编辑和布局问题，保留既有项目与上次改动。

## Next Step
交付完成，用户原有本地标签页停留在新版故事板；本次临时浏览器空间与隔离服务已清理。

## Current Phase
Complete

## Phases
- Phase 1: 参考操作与本地审计 — complete
- Phase 2: 修复实现 — complete
- Phase 3: 自动化与浏览器验证 — complete
- Phase 4: 交付 — complete

## Constraints
- 不消耗LibTV积分，不执行图片/视频生成。
- 不删除用户已有文档、节点、镜头或素材。
- 前次剧本工作流与水球改动保留。

## Errors
- Ego CLI新空间仅能列出自身空白页；采用已连接的Ego Lite浏览器接口复用用户现有标签页。
- 编译曾报旧图标未使用和编辑按钮事件类型不兼容，已修复；最终构建通过。
- 后端相关测试首次受沙箱本机监听权限限制，授权范围内重跑后22项通过。
- 浏览器尺寸覆盖未实际改变Ego Lite标签页宽度（仍为1500px），已恢复覆盖；响应式CSS已实现，窄屏实测未确认。
