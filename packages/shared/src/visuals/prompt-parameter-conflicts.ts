/** Actual request fields are authoritative; only explicitly labelled values are inspected. */
export type PromptGenerationParameters = {
  modality?: 'image' | 'video' | 'text'
  ratio?: string | null; duration?: number | null; resolution?: string | null; clarity?: string | null
  quality?: string | null; background?: string | null; mode?: string | null
}
export type PromptParameterField = 'ratio' | 'duration' | 'resolution' | 'clarity' | 'quality' | 'background' | 'mode'
export type PromptParameterConflict = {
  field: PromptParameterField; label: string; declared: string; expected: string
  /** One-based line and zero-based string offsets for the exact parameter value. */
  line: number; start: number; end: number; replacement: string; message: string
}

const qualities: Record<string, string[]> = {
  low: ['low', '低画质', '低画质，简化细节'],
  standard: ['standard', 'medium', '标准画质', '标准画质，清楚呈现主体与构图'],
  high: ['high', '高画质', '高画质，精细纹理与光影'],
  ultra: ['ultra', '超高画质', '超高画质，更丰富的微小细节与材质层次'],
  extreme: ['extreme', '极致画质', '极致画质，尽可能精确的细节、纹理与光影表现'],
}
const backgrounds: Record<string, string[]> = {
  auto: ['auto', '自动', '自动背景', '自动选择适合画面的背景'],
  preserve: ['preserve', 'keep', '保留背景', '保留原有场景背景', '保留原有场景背景；有参考图时保留参考图的背景'],
  transparent: ['transparent', '透明', '透明背景', '透明背景，仅保留主体，不要绘制棋盘格或实色背景'],
}
const labels: Record<string, PromptParameterField> = {
  画面比例: 'ratio', 视频时长: 'duration', 输出分辨率: 'resolution', 清晰度要求: 'clarity',
  画质要求: 'quality', 背景要求: 'background', 生成模式: 'mode',
}
const trimValue = (value: string) => value.trim().replace(/[。.!！]+$/, '').trim()
function enumValue(value: string, choices: Record<string, string[]>): string | undefined {
  const normalized = trimValue(value).toLowerCase()
  return Object.entries(choices).find(([, aliases]) => aliases.includes(normalized))?.[0]
}
function ratioValue(value: string): string | undefined {
  if (/^(?:adaptive|auto|自适应)$/i.test(value.trim())) return 'adaptive'
  const match = /^(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)$/.exec(value.trim())
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return undefined
  return (Number(match[1]) / Number(match[2])).toFixed(8)
}
function resolutionValue(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s/g, '').replace('×', 'x')
  return /^(?:\d{2,7}x\d{2,7}|\d+(?:\.\d+)?k|\d{2,5}p|auto|adaptive|自动|自适应)$/.test(normalized) ? normalized : undefined
}
function clarityValue(value: string, modality?: PromptGenerationParameters['modality']): string | undefined {
  const normalized = resolutionValue(value)
  if (!normalized) return undefined
  if (['auto', 'adaptive', '自动', '自适应'].includes(normalized)) return undefined
  const dimensions = /^(\d+)x(\d+)$/.exec(normalized)
  if (!dimensions) return normalized
  if (modality === 'image') {
    const scale = Math.max(Number(dimensions[1]), Number(dimensions[2])) / 1024
    const closest = [1, 2, 4].reduce((best, level) => Math.abs(level - scale) < Math.abs(best - scale) ? level : best)
    return `${closest}k`
  }
  return `${Math.min(Number(dimensions[1]), Number(dimensions[2]))}p`
}

/** Unknown descriptions and narrative sentences are deliberately left alone. */
export function findPromptParameterConflicts(prompt: string, actual: PromptGenerationParameters): PromptParameterConflict[] {
  const conflicts: PromptParameterConflict[] = []
  let line = 0, offset = 0
  for (const text of prompt.split('\n')) {
    line++
    const match = /^(\s*(?:[-*]\s+)?(?:画面比例|视频时长|输出分辨率|清晰度要求|画质要求|背景要求|生成模式)\s*[:：]\s*)(.*)$/.exec(text)
    if (!match) { offset += text.length + 1; continue }
    const label = match[1]!.replace(/^\s*[-*]?\s*/, '').replace(/\s*[:：]\s*$/, '')
    const field = labels[label]!, value = match[2]!
    let declared: string | undefined, expected: string | undefined, replacement = '', length = 0
    if (field === 'ratio') {
      const token = /^(\d+(?:\.\d+)?\s*[:：/]\s*\d+(?:\.\d+)?|adaptive|auto|自适应)/i.exec(value)?.[0]
      if (token && actual.ratio && ratioValue(token) !== undefined && ratioValue(actual.ratio) !== undefined) {
        declared = ratioValue(token); expected = ratioValue(actual.ratio); replacement = actual.ratio; length = token.length
        const decoration = /^[（(]宽[:：]高[，,](?:横版|竖版|方形)[）)]/.exec(value.slice(length))?.[0]
        if (decoration) {
          const dimensions = /^(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)$/.exec(actual.ratio)
          const orientation = dimensions ? Number(dimensions[1]) < Number(dimensions[2]) ? '竖版' : Number(dimensions[1]) > Number(dimensions[2]) ? '横版' : '方形' : undefined
          if (orientation) {
            declared += `|${/(横版|竖版|方形)/.exec(decoration)![1]}`
            expected += `|${orientation}`
          }
          replacement += orientation ? `（宽:高，${orientation}）` : ''
          length += decoration.length
        }
      }
    } else if (field === 'duration') {
      const token = /^(\d+(?:\.\d+)?)(?=\s*(?:秒|s(?:\b|$)))/i.exec(value)?.[1]
      if (actual.modality !== 'image' && actual.modality !== 'text' && token && actual.duration !== undefined && actual.duration !== null) {
        declared = String(Number(token)); expected = String(actual.duration); replacement = expected; length = token.length
      }
    } else if (field === 'resolution' || field === 'clarity') {
      const token = /^(\d{2,7}\s*[x×]\s*\d{2,7}|\d+(?:\.\d+)?k|\d{2,5}p|adaptive|auto|自适应|自动)(?![\w])/i.exec(value)?.[0]
      const configured = field === 'resolution' ? actual.resolution : actual.clarity || actual.resolution
      if (token && configured) {
        declared = field === 'resolution' ? resolutionValue(token) : clarityValue(token, actual.modality)
        expected = field === 'resolution' ? resolutionValue(configured) : clarityValue(configured, actual.modality)
        if (expected && ['auto', 'adaptive', '自动', '自适应'].includes(expected)) expected = undefined
        // A pixel size and a clarity tier are comparable only as tiers.
        if (field === 'resolution' && declared && expected && (declared.includes('x') !== expected.includes('x'))) {
          declared = clarityValue(token, actual.modality); expected = clarityValue(configured, actual.modality)
        }
        replacement = configured; length = token.length
      }
    } else if (field === 'quality' || field === 'background') {
      const choices = field === 'quality' ? qualities : backgrounds, configured = actual[field]
      declared = enumValue(value, choices)
      expected = configured ? enumValue(configured, choices) : undefined
      replacement = configured || ''; length = trimValue(value).length
    } else if (field === 'mode') {
      const token = /^(text|reference|first_frame|first_last_frame|edit|extend)(?![\w])/i.exec(value)?.[0]
      if (token && actual.mode) {
        declared = token.toLowerCase(); expected = actual.mode; replacement = actual.mode; length = token.length
      }
    }
    if (declared !== undefined && expected !== undefined && declared !== expected) {
      const start = offset + match[1]!.length, original = value.slice(0, length)
      const expectedLabel = field === 'duration' ? `${replacement} 秒` : replacement
      conflicts.push({ field, label, declared: original, expected: expectedLabel, line, start, end: start + length, replacement,
        message: `提示词第 ${line} 行的“${label}”为“${original}”，实际生成参数为“${expectedLabel}”，请按生成参数同步后再提交。` })
    }
    offset += text.length + 1
  }
  return conflicts
}

/** Update only recognised conflicting values, preserving prose, section markers and reference tokens. */
export function synchronizePromptParameters(prompt: string, actual: PromptGenerationParameters): string {
  return findPromptParameterConflicts(prompt, actual).reverse().reduce((text, issue) =>
    text.slice(0, issue.start) + issue.replacement + text.slice(issue.end), prompt)
}

export function promptParameterConflictMessage(prompt: string, actual: PromptGenerationParameters): string | null {
  const issues = findPromptParameterConflicts(prompt, actual)
  return issues.length ? issues.slice(0, 8).map(issue => issue.message).join('\n') + (issues.length > 8 ? `\n另有 ${issues.length - 8} 处参数冲突，请同步后重试。` : '') : null
}
