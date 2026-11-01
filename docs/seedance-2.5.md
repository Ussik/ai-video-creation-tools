# Seedance 2.5 接入

核对日期：2026-10-24。官方模型 ID 为 `doubao-seedance-2-5-260628`，火山方舟地址为 `https://ark.cn-beijing.volces.com/api/v3`，创建和查询分别使用 `contents/generations/tasks`、`contents/generations/tasks/{id}`。

在模型设置中选择异步视频协议，点击「应用 Seedance 2.5 配置」并保存。按钮保留连接地址、请求头和计价设置，替换视频请求模板及模式参数；它不会更改模型 ID、提供商或密钥。启动升级只修复精确匹配上述官方模型 ID、且仍完整使用旧通用纯文本默认模板的记录；定制模板和 Endpoint ID 配置需手动应用配置。

| 模式 | 图片角色 | 参考视频 | 实际请求画幅 | 实际请求时长 |
| --- | --- | --- | --- | --- |
| 文生视频 | 无 | 无 | 所选画幅 | 4–30 秒 |
| 首帧 | `first_frame` | 无 | `adaptive` | 4–30 秒 |
| 首尾帧 | `first_frame`、`last_frame` | 无 | `adaptive` | 4–30 秒 |
| 参考生成 | `reference_image` | 可选 | 所选画幅 | 4–30 秒 |
| 编辑 | `reference_image`（可选） | 必填 | `adaptive` | `-1`，跟随原视频 |
| 延长 | `reference_image`（可选） | 必填 | `adaptive` | 4–30 秒 |

参考、编辑和延长显式传递 `omni_reference_task_type`，防止默认自动判断任务类型产生参数冲突。图片、视频必须实际进入 `content`；模板丢失素材时在提交前报错。首帧、首尾帧与全模态参考互斥。

2.5 配置最多接受 30 张图片（包含分镜图），单张小于 30 MiB、宽高 300–6000 像素、宽高比 0.4–2.5；按实际 Base64 请求体检查 64 MiB 上限。通用视频模型仍为 10 张，2.0 为 9 张。现有界面支持一个参考视频地址（公网 HTTP(S) 或方舟 `asset://`），尚未增加多视频或音频参考上传界面。远程视频的编码、帧率、大小及 2–30 秒（编辑 4–30 秒）限制由方舟接口校验，本地不会下载参考视频进行探测。

清晰度为 480p、720p、1080p，默认 720p；2.5 不提供 4K。样片开关强制 480p。本次支持直接创建样片，尚未增加使用 `draft_task` 复用样片升成正式视频的流程。输出沿用 MP4 工作流。

产品中的镜头计划时长始终保留正数。编辑任务只在发送方舟请求时转换为 `duration: -1`，预览另返回 `video_request_parameters` 展示有效参数。提示词整理根据 2.5 指南保留整数秒时间戳，并加载与实际模型版本对应的技能资料。

验证覆盖六种模式的完整模拟异步请求、轮询与恢复、声音开关、样片、30 图、真实图片格式/尺寸和编码体积、错误模板、旧默认配置迁移及前端参数控件。验证不调用付费视频生成接口。

官方资料：

- [Seedance 2.5 教程](https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5)
- [创建视频生成任务 API](https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api)
- [Seedance 2.5 提示词指南](https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5-prompt-guide)
