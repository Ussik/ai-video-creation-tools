import { scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'

const sourceAnalysisLabels: Record<string, string> = {
  script_source_map: '剧本剧情目录分析',
  script_source_evidence_repair: '原文证据修补',
  script_source_story: '全剧信息整理',
  script_source_story_overview: '全剧主线与结局整理',
  script_source_story_characters: '人物与身份整理',
  script_source_story_characters_merge: '人物身份归并',
  script_source_story_timeline: '事件与因果整理',
  script_source_story_threads: '伏笔与线索整理',
  script_source_story_uncertainties: '待确认信息整理',
  script_source_quality: '剧本分析质量核对',
  script_source_quality_repair: '剧本分析问题修补',
}
const batchLabels: Record<string, string> = {
  characters: '人物整理', timeline: '事件与因果整理', threads: '伏笔与线索整理', uncertainties: '待确认信息整理',
}
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function replaceLabels(text: string, labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort((a, b) => b.length - a.length).map(escapePattern)
  return text.replace(new RegExp(`(?<![A-Za-z0-9_])(?:${keys.join('|')})(?![A-Za-z0-9_])`, 'g'), key => labels[key]!)
}

const draftFieldLabels: Record<string, string> = {
  artifact_type: '文档类型', title: '文档标题', content: '文档正文', status: '状态', type: '类型别名',
}
const sceneStageExplanations: Record<string, string> = {
  '仅分集正文阶段需要分场剧本': '生成结果中的分场内容与当前创作阶段不一致，未通过校验。请重新生成当前阶段。',
  '分集正文缺少对应分场，请保留正文并补齐 scenes': '分集正文缺少对应分场，需要保留正文并补齐分场后再确认。',
  '当前项目资料阶段不应包含分场剧本，scenes 必须为空数组': '当前正在编写全剧资料，生成结果中不应包含分集的分场内容。',
}

/** Older task failures stored Zod's issue array directly instead of a public diagnostic. */
function legacySceneStageDiagnostic(text: string): string {
  if (!text.trimStart().startsWith('[')) return text
  let value: unknown
  try { value = JSON.parse(text) } catch { return text }
  type Issue = { code: string; message: string; path: Array<string | number> }
  const isIssue = (item: unknown): item is Issue => !!item && typeof item === 'object' &&
    'code' in item && typeof item.code === 'string' && 'message' in item && typeof item.message === 'string' &&
    'path' in item && Array.isArray(item.path) && item.path.every(part => typeof part === 'string' || typeof part === 'number')
  if (!Array.isArray(value) || !value.every(isIssue)) return text
  const isSceneStageIssue = (issue: Issue) => issue.code === 'custom' && Object.hasOwn(sceneStageExplanations, issue.message) &&
    issue.path.length === 1 && issue.path[0] === 'scenes'
  if (!value.some(isSceneStageIssue)) return text
  return value.map(issue => isSceneStageIssue(issue) ? sceneStageExplanations[issue.message] :
    `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('\n')
}

function workflowDraftDiagnosticDisplayText(text: string): string {
  const contract = /模型结果不符合\s+workflow_draft\s+契约/g
  if (!contract.test(text)) return text
  return text.replace(contract, '阶段草稿未通过格式与内容校验')
    .replace(new RegExp(`(?:\\$(?:\\.result)?\\.)?scenes:[ \\t]*(${Object.keys(sceneStageExplanations).map(escapePattern).join('|')})(?=\\s|[；;。]|$)`, 'g'),
      (_match, issue: string) => sceneStageExplanations[issue]!)
    .replace(/(?<![A-Za-z0-9_])(?:\$(?:\.result)?\.)?artifacts(?:\.(\d+)|\[(\d+)\])(?:\.(artifact_type|title|content|status|type))?:[ \t]*([^\n]*?)(?=\n|[；;][ \t]*[A-Za-z_$][\w$]*(?:\[\d+\]|\.[\w$]+)*[ \t]*:|$)/g,
      (match, legacyIndex: string | undefined, arrayIndex: string | undefined, field: string | undefined, issue: string) => {
        const document = `第 ${Number(legacyIndex ?? arrayIndex) + 1} 份文档`
        if (!field && /^(?:Unrecognized keys?:|存在不支持的字段)/.test(issue)) {
          const fields = [...issue.matchAll(/"([^"\n]+)"/g)].map(([, key]) => `「${draftFieldLabels[key!] || key}」`)
          if (fields.length) return `${document}：包含不支持的字段${fields.join('、')}`
        }
        if (!field) return match
        const label = draftFieldLabels[field]!
        if (/^Schema 未定义的多余字段/.test(issue)) return `${document}：包含不支持的字段「${label}」`
        if (/^缺少必填字段/.test(issue)) return `${document}：缺少${label}`
        if (/^字段取值不合法/.test(issue)) return `${document}：${label}不合法`
        if (/^字段类型不合法/.test(issue)) return `${document}：${label}格式不正确`
        if (/^字段结构不符合任一允许格式/.test(issue)) return `${document}：${label}结构不正确`
        if (field === 'artifact_type' && /^(?:Invalid option:|Invalid enum value\.|Invalid input:|Required\b)/.test(issue)) {
          return `${document}：${label}缺失或不合法`
        }
        if (/^(?:Required\b|Invalid input:.*received undefined\b)/.test(issue)) return `${document}：缺少${label}`
        if (/^Invalid input: expected string\b/.test(issue)) return `${document}：${label}应为文本`
        if (/^Too small: expected string to have >=1 characters/.test(issue)) return `${document}：${label}不能为空`
        return `${document}的${label}：${issue}`
      })
}

/** Format public diagnostics at render time; stored errors and call payloads stay verbatim. */
export function scriptDiagnosticDisplayText(text: string): string {
  const readable = workflowDraftDiagnosticDisplayText(legacySceneStageDiagnostic(text))
    .replace(/模型结果不符合\s+(script_source_[a-z_]+)\s+契约/g,
      (match, key: string) => sourceAnalysisLabels[key] ? `${sourceAnalysisLabels[key]}未通过格式与内容校验` : match)
    .replace(/(?<![A-Za-z0-9_])characters_merge:[a-f0-9]+(?![A-Za-z0-9_])/g, '人物身份归并')
    .replace(/(?<![A-Za-z0-9_])(characters|timeline|threads|uncertainties):(\d+)(?:\/coverage:(\d+))?(?![A-Za-z0-9_])/g,
      (_match, kind: string, batch: string, coverage?: string) => `${batchLabels[kind]}（第 ${Number(batch) + 1} 批${coverage === undefined ? '' : `，补全第 ${Number(coverage) + 1} 组`}）`)
  return replaceLabels(readable, sourceAnalysisLabels)
}

/** Translate document references in review prose, preserving every occurrence of supplied evidence. */
export function scriptReviewDisplayText(text: string, quotes: readonly string[] = []): string {
  const ranges: Array<{ start: number; end: number }> = []
  for (const quote of new Set(quotes.filter(Boolean))) {
    let start = text.indexOf(quote)
    while (start !== -1) {
      ranges.push({ start, end: start + quote.length })
      start = text.indexOf(quote, start + 1)
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  let result = '', offset = 0
  for (const range of ranges) {
    if (range.end <= offset) continue
    if (range.start > offset) result += replaceLabels(text.slice(offset, range.start), scriptArtifactLabels)
    result += text.slice(Math.max(offset, range.start), range.end)
    offset = range.end
  }
  return result + replaceLabels(text.slice(offset), scriptArtifactLabels)
}
