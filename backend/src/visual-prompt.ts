export type PromptVisualBinding = {
  kind: 'character' | 'location' | 'prop'; name: string; variant: string; revision: number;
  definition: string; view_requirements: string; board_asset_id: string | null
}
export function visualGenerationPrompt(prompt: string, bindings: PromptVisualBinding[], references: string[], mode: string): string {
  if (!bindings.length) return prompt
  const labels = { character: '人物', location: '场景', prop: '道具' }
  const context = bindings.map(binding => {
    const index = mode === 'profiles' && binding.board_asset_id ? references.indexOf(binding.board_asset_id) + 1 : 0
    return `${labels[binding.kind]}：${binding.name}（${binding.variant}，版本 ${binding.revision}）${index ? `；参考图 ${index}` : ''}\n${binding.definition}\n视图说明：${binding.view_requirements}`
  }).join('\n\n')
  return `${prompt}\n\n【镜头视觉设定】\n${context}\n保持上述对象的外观、比例、服装、材质与空间关系。只生成当前镜头的一幅完整画面或连续视频；不要复制设定板的多视角拼版、文字、标签或色板。`
}
