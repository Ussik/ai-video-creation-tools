import { stripManagedPromptBlocks } from './prompt-document.js'

export type VisualProfilePromptDefinition = {
  kind: 'character' | 'location' | 'prop'
  name: string
  variant: string
  definition: string
  view_requirements: string
  state_delta?: string
}

export type VisualProfilePromptReference = {
  asset_id: string
  name: string
  variant?: string
  definition?: string
  role?: 'base' | 'manual'
}

/** Default section content, before the creator edits the complete document. */
export function visualProfilePromptRequirements(profile: VisualProfilePromptDefinition): string {
  const label = { character: '人物', location: '场景', prop: '道具' }[profile.kind]
  return `制作一张专业影视${label}视觉设定信息图。对象：${profile.name}；版本：${profile.variant}。\n` +
    '以这一对象的同一版本为主体。主体各视图必须是同一形象、同一结构与同一材质，不要混用其他对象的特征。仅在设定明确要求的同框、互动或尺度对比细节中呈现相关对象。\n' +
    `视觉设定：\n${profile.definition}\n需要展示：\n${profile.view_requirements}\n` +
    '使用清晰、有序的设定板版式，主体占主要面积，视图和细节足够大且可辨认。包括简洁可读的中文名称、视角标签和关键设定说明，展示对应的颜色与材质样本。' +
    '所有文字与图像都遵守上述设定，不增加冲突设定；不添加水印、无关装饰或故事画面。'
}

/** Rebuild only the system sections from the saved profile and actual image order. */
export function withVisualProfilePrompt(body: string, profile: VisualProfilePromptDefinition,
  references: VisualProfilePromptReference[] = [], options: { prompt_document?: boolean } = {}): string {
  if (options.prompt_document) return body
  const prose = stripManagedPromptBlocks(body, { blockNames: ['设定图固定要求', '基础版本与本次状态变化', '基础身份参考', '生成参考图'] })
  const sections = [`【设定图固定要求】\n${visualProfilePromptRequirements(profile)}\n【设定图固定要求结束】`]
  const baseIndex = references.findIndex(reference => reference.role === 'base')
  if (baseIndex >= 0) {
    const base = references[baseIndex]!
    sections.push(`【基础版本与本次状态变化】\n基础对象：${base.name}${base.variant ? ` · ${base.variant}` : ''}；基础图为参考图 ${baseIndex + 1}。\n` +
      `当前状态：${profile.variant}。只修改以下明确差异：${profile.state_delta || '未声明额外差异，保持基础版本的身份与外观'}。\n` +
      '必须保持基础图中的身份、面部、发型、体型比例、服装结构、颜色与材质；只有上述差异明确要求变化的项目允许修改。' +
      '局部污渍、伤痕或磨损仅出现在指定部位，不扩展到全身，不改变其他视图中同一状态的一致性，不复制基础图的拼版文字。\n【基础版本与本次状态变化结束】')
    sections.push(`【基础身份参考】\n参考图 ${baseIndex + 1} 用于保持基础版本身份与未变特征。\n【基础身份参考结束】`)
  }
  if (references.length) {
    const context = references.map((reference, index) => `参考图 ${index + 1}：${reference.name}${reference.variant ? `（${reference.variant}）` : ''}` +
      (reference.definition ? `\n固定设定：${reference.definition}` : '') +
      (reference.role === 'base' ? '\n用于保持基础版本身份与未变特征。' : '\n作为本次设定图的补充视觉参考，按正文明确的用途使用。')).join('\n\n')
    sections.push(`【生成参考图】\n${context}\n参考图编号与提交图片顺序一致。严格保持各参考对象的外貌、比例、服装、材质与配色，不能互换或混合身份。` +
      '同一主体的参考图用于保持主体一致；其他对象仅用于上述设定要求的同框、互动或尺度对比细节，不增加独立主体视图，不复制参考信息图的版式、文字或色板。\n【生成参考图结束】')
  }
  return [prose, ...sections].filter(Boolean).join('\n\n')
}
