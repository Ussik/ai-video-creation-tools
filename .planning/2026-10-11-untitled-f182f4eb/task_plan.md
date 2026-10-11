# 镜头引用面板重设计
PLAN_ID=2026-10-11-untitled-f182f4eb

## Goal
镜头引用使用独立宽面板，脱离缩放后的提示词侧栏，保持引用筛选、用途、参考图、自动保存和定位功能。

## Phases
- [x] Audit screenshot, component, composer layout and existing integration tests.
- [x] Implement viewport-sized reference drawer and readable content hierarchy.
- [x] Verify persistence/keyboard/prompt retention, browser populated/empty/mobile layout and production build.

## Constraints
Preserve parallel user work and backend contracts. No real project writes or generation during QA. No commit/push.
