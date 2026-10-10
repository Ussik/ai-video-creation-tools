# Video quick mode synchronization

## Goal
Unify canvas video quick actions with the composer menu: 首帧承接 and 首尾帧, with matching reference selection behavior.

## Phases
- [x] Inspect both entry points and existing tests.
- [x] Share labels and video mode updates.
- [x] Verify quick action/menu parity with actual canvas integration and frontend build.

## Errors encountered
- Initial instruction search used zsh variable `path`, temporarily shadowing PATH in that command process; reran using `instruction_file`.
- Broad diagnostic searches included absent files; narrowed reads to verified paths.
- Initial parity regression expected storyboard-first ordering despite deliberately reversed first/last-frame connections; corrected to preserve connection order.
- One log update ran from web/ with a project-relative planning path; repeated the update using this absolute selected plan path.
