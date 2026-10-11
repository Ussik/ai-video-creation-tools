# 发现

当前 video-reference-manifest 保持输入编号及对象用途，但 storyboard 固定解释为开场。ProjectCanvas、skill-routes 和后端生成均需同步元数据。VideoReferencePanel目前仅展示用途与排除恢复。canvas-shot-workflow 从图转视频有视觉绑定时自动选reference并强制接入分镜图。

逐图用途为video_reference_usages，仅保存在节点和生成请求，按资产ID索引，与对象档案视图元数据及API首尾帧角色分离。默认分镜为整体构图；覆盖用途只替换托管映射，保留用户正文。复用既有image/video/both/none出镜范围，整理技能亦过滤非视频、排除对象。明确首帧和参考入口分别建节点，同图不同模式不互相复用。
