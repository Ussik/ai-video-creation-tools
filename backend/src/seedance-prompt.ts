/** Prompt dialect selection only; provider capabilities still come from explicit settings. */
export function mentionsSeedanceVersion(text: string, version: '2.0' | '2.5'): boolean {
  const minor = version === '2.0' ? '0' : '5'
  return new RegExp(`seedance[- _]?2[. _-]${minor}(?=$|[^0-9])`, 'i').test(text)
}

type PromptTarget = { name: string; remote_id: string; settings: Record<string, unknown> }
export function seedance2PromptGuidance(target: PromptTarget | null): string {
  if (!target) return ''
  const dialect = [target.settings.video_prompt_dialect, target.settings.target_video_model, target.settings.video_reference_profile]
    .find(value => typeof value === 'string' && (mentionsSeedanceVersion(value, '2.0') || mentionsSeedanceVersion(value, '2.5')))
  const identity = [dialect, target.remote_id, target.name]
    .find(value => typeof value === 'string' && (mentionsSeedanceVersion(value, '2.0') || mentionsSeedanceVersion(value, '2.5')))
  if (typeof identity !== 'string' || !mentionsSeedanceVersion(identity, '2.0')) return ''
  // Official 2.0 series prompt guide, reviewed 2026-10-10 (updated 2026-09-22).
  return '\n【Seedance 2.0 系列提示词要求】\n' +
    '同样适用于 2.0 Fast / Mini，只整理当前节点已有叙事，不增加其他镜头或改变已确认的剧情、对白、画幅、时长和模式。\n' +
    '按主体、动作细节、场景环境、光影色调、运镜、视觉风格和必要约束组织，简洁聚焦，不粘贴整份剧本或堆砌画质词。\n' +
    '主体指代严格对应实际图片编号。可写“角色名的面部特征参考图片1，服装与身体比例参考图片2”；角色名必须来自本次设定，同一人物的不同视角明确为同一身份。' +
    '仅用已提供的设定文字定义主体，不猜测图片中的服饰、发型或内容。定义后始终使用同一名称；未定义时写“角色名（对应图片1）”。图片N和@图片N都可使用，不以内部资产ID替代编号。\n' +
    '只使用本次已选素材，面部身份、服装、场景、道具各按用途参考，不能混合身份或复制人物分身。' +
    '多人场景明确每人的动作和对象；信息图用于设定，不把三视图拼版、标签、色板复制进故事画面。\n' +
    '动作写清肢体部位、方向、幅度、速度和前后承接，用可见表情与身体细节表达情绪。保留剧情要求的奔跑、打斗等动作，不擅自改为低缓动作。' +
    '一个连续镜头尽量保留一种主要运镜，避免同时堆叠推拉摇移；创作者明确要求的运镜组合仍保留。\n' +
    '按动作先后与相对停顿描述；仅当原节点已含多个内部镜头时使用“镜头1、镜头2”。精确时间戳响应不稳定，不把逐秒时间码当成执行保证，接口总时长仍保持原值。\n' +
    '逐字保留对白，明确说话者和语种；用{}区分台词、<>区分音效、（）区分音乐。默认无字幕、无额外Logo和水印，创作者明确要求的字幕或画内文字保留。\n' +
    '保持参考、编辑或延长的任务类别。编辑与延长直接指代原视频，不改写成“参考视频”。未提供实际音视频绑定时不新增或猜测音频N、视频N，原文已有引用保留且不宣称已读取素材。\n'
}
