# 标准音色配音

项目使用豆包语音合成大模型 2.0 的标准音色，为角色对白和旁白生成独立 MP3 音频。官方标准音色可用于对白与旁白；每个角色固定 Speaker ID，单句调整表演。当前不接入声音复刻槽位。

## 入口与流程

- 画布顶部项目名旁的“切换创作页面”菜单 → 配音；剪辑、资产等项目页面顶部也有“配音”。
- 打开“语音配置”，填写新版语音控制台 API Key。它与方舟图片、视频的密钥独立；本机 SQLite 仅保存密文，接口只返回是否配置。
- “角色声音”新增角色/旁白，为每个角色选择标准音色，设置默认表演和语速，保存。
- “台词与旁白”手动添加台词，或展开“从剧本导入”，勾选场次再导入。明确的 `角色：台词` 标签会分配角色，括号中的前置表演提示拆入表演要求；没有明确说话人的内容需要手动分配角色。
- 编辑朗读正文、表演要求和情境参考；点击“生成配音”才会创建合成任务。表演/情境通过语音指令提交，不拼入朗读正文。
- 在候选音频中试听，点击“选用此版本”保存到资产库。修改台词或角色声音后可生成新候选；旧版本保留原始文本、音色和表演快照。

选中的音频仍是独立资产；本阶段尚未实现配音轨的镜头对齐、对白自动混入成片、音乐闪避或口型同步。不要将角色对白当作整个项目的背景音乐使用。

## 服务协议

- Endpoint：`POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`
- Headers：`X-Api-Key`、`X-Api-Resource-Id: seed-tts-2.0`、请求 UUID；请求 usage 字符数。
- 正文：`req_params.text` / `speaker`，输出 MP3、24 kHz；`additions` 为 JSON 字符串，`context_texts` 传表演指令。
- 逐行解析流式 JSON；结束码 `20000000`，音频解码通过后才能保存候选。字幕时间戳与实际音频时长分别保存。
- 单次合成等待上限 3 分钟；失败、断流或服务重启中断均不会自动再次合成，避免重复计费。用户核对厂商记录后，可手动生成新候选。
- 单条正文上限 5000 字符；长场次文本导入时按句子边界分段。单条台词排队/运行时禁止重复提交。

内置已核实的标准音色：Vivi 2.0、小何 2.0、云舟 2.0、小天 2.0、刘飞 2.0、少年梓辛 2.0。也可填写官方音色库的其他标准 Speaker ID；服务端拒绝 `S_` 声音复刻音色。

## 官方文档

- [HTTP 单向流式语音合成](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)
- [音色列表](https://docs.volcengine.com/docs/DoubaoVoice/Tonelist-1?lang=zh)
- [API Key 管理](https://console.volcengine.com/speech/new/setting/apikeys?projectName=default)
