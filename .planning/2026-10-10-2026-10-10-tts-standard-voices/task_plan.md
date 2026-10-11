# TTS 2.0 标准音色接入

## Goal
使用已开通的豆包 TTS 2.0 标准音色，为项目提供可编辑的角色对白和旁白生成、试听及保存，不创建或消费复刻槽位。

## Next Step
完成；交付入口与音频样例。

## Current Phase
Phase 5

## Phases
- Phase 1 discovery: complete — 官方单头鉴权、服务及现有工作流已核对。
- Phase 2 architecture: complete — 独立 speech API，与原生成队列/音频资产复用；密钥加密且只返回 has_key。
- Phase 3 implementation: complete — adapter/routes/worker/UI integrated.
- Phase 4 verification: complete — backend358/frontend351 tests, builds, browser QA and one live standard-voice synthesis passed.
- Phase 5 delivery: complete — documented entry, sample and current boundary; no commit/push.

## Decisions
- 无需扩大现有图片/视频模型类型；专用语音配置支持官方 X-Api-Key/seed-tts-2.0。
- 固定角色音色，逐句正文、表演指令与上文分开；用户点击才导入或生成。
- 标准音色可输入官方 Speaker ID；拒绝声音复刻 S_ 音色，不触发 138 元槽位。
- 同一条台词可多次生成候选，快照声音/正文/表演信息；用户选定音频。
- 不自动重试厂商合成，避免重复计费。

## Errors
- Earlier setup: API key creation auto-review required user. User created video-studio-speech; verified enabled.
- Voice-slot activation blocked as possible billing side effect. User chose TTS stock voices, so no retry.
