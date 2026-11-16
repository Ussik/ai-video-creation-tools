import type { ScriptSourceAnalysis } from './script-source-document.js'
import type { ScriptStage } from './script-stage-content.js'

export type SourceQualityCreationScope = { stage?: ScriptStage; episode_number?: number }

/** Presentation and task guards use the server's independently checked access
 * decision. A retained opinion alone never grants access to the analysis. */
export function sourceQualityAccessBlockReason(analysis?: ScriptSourceAnalysis | null, scope: SourceQualityCreationScope = {}): string | undefined {
  if (!analysis) return '请先开始剧本分析，完成后再发送；可先填写要求'
  const summary = analysis.quality_summary
  if (analysis.status === 'queued' || analysis.status === 'running') return '剧本分析中，可先填写要求，完成后再发送'
  if (analysis.status !== 'ready') {
    if (summary?.stop_reason === 'no_progress') return '本轮分析未产生实质进展，保留事项仍待复核；请先处理核对问题，输入已保留'
    if (summary?.stop_reason === 'uncertain') return '部分意见目前无法确定，分析尚未通过独立核对；请先核对相关信息，输入已保留'
    return analysis.status === 'paused' ? '剧本分析已暂停，请继续分析后再发送；输入已保留'
      : '剧本分析未完成，请先处理分析问题后再发送；输入已保留'
  }
  // Historical genuinely passed reviews retain their existing compatibility.
  // Legacy issues or an unclassified/forged summary do not gain new access.
  if (!summary) return analysis.quality?.status === 'passed' ? undefined : '当前分析尚无可验证的质量核对结果，请先核对后再发送；输入已保留'
  if (summary.review !== 'passed' && summary.review !== 'issues') return '当前分析仍待独立质量核对，保留待复核不代表已经通过；请先完成核对'
  if (!Number.isSafeInteger(summary.blocking) || summary.blocking < 0) return '分析问题的影响范围尚未确认，请先核对后再创作'
  if (summary.access === 'usable' && summary.blocking === 0) return undefined
  if (summary.access !== 'scoped' || summary.blocking > 0 || !Array.isArray(summary.section_ids) || !summary.section_ids.length ||
    new Set(summary.section_ids).size !== summary.section_ids.length || summary.section_ids.some(id => !Number.isSafeInteger(id) || id < 0 || !analysis.sections[id])) {
    return summary.blocking > 0 ? `仍有 ${summary.blocking} 项实质问题阻塞创作，请先核对并处理相关问题`
      : '分析问题的影响范围尚未确认，请先核对后再创作'
  }
  const affectedEpisodes = summary.section_ids.map(id => analysis.sections[id]!.episode_number)
  if (affectedEpisodes.some(episode => !Number.isSafeInteger(episode) || episode === null || episode < 1 || episode > 200)) {
    return '相关问题尚不能定位到明确集数，暂不能确认本次创作不受影响；请先核对影响范围'
  }
  const episodes = [...new Set(affectedEpisodes as number[])].sort((a, b) => a - b)
  const affected = `第 ${episodes.join('、')} 集`
  if (scope.stage !== 'episode' || !Number.isSafeInteger(scope.episode_number) || !scope.episode_number || scope.episode_number < 1 || scope.episode_number > 200) {
    return `${affected}存在待核对信息；本次步骤涉及全剧或依赖范围尚不明确，请先核对相关内容`
  }
  if (!analysis.sections.some(section => section.episode_number === scope.episode_number)) {
    return `当前目录尚不能定位第 ${scope.episode_number} 集，暂不能确认其与待核对问题无关；请先核对影响范围`
  }
  return episodes.includes(scope.episode_number) ? `第 ${scope.episode_number} 集存在影响本步骤的待核对信息，请先核对相关内容；其他无关集可按明确范围继续创作` : undefined
}
