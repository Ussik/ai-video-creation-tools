import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { ParsedMessageChoices } from './director-choices'
import { shouldSendDirectorMessage } from './director-window'

export type ChoiceAnswer = { selectedId?: string; custom: boolean; text: string; fields?: Record<string, string>; status?: 'answered' | 'skipped'; responses?: Record<string, ChoiceAnswer> }

export function restoreChoiceAnswer(value: unknown, leaf = false): ChoiceAnswer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const answer = value as ChoiceAnswer
  if (typeof answer.custom !== 'boolean' || typeof answer.text !== 'string') return null
  const fields = answer.fields && typeof answer.fields === 'object' && !Array.isArray(answer.fields)
    ? Object.fromEntries(Object.entries(answer.fields).filter(([, value]) => typeof value === 'string').slice(0, 4).map(([key, value]) => [key.slice(0, 80), value.slice(0, 1600)])) : undefined
  const responses = !leaf && answer.responses && typeof answer.responses === 'object' && !Array.isArray(answer.responses)
    ? Object.fromEntries(Object.entries(answer.responses).slice(0, 4).flatMap(([key, value]) => {
      const restored = restoreChoiceAnswer(value, true)
      return restored ? [[key.slice(0, 80), restored]] : []
    })) : undefined
  return { custom: answer.custom, text: answer.text.slice(0, 4000),
    ...(typeof answer.selectedId === 'string' ? { selectedId: answer.selectedId.slice(0, 80) } : {}),
    ...(answer.status === 'answered' || answer.status === 'skipped' ? { status: answer.status } : {}),
    ...(fields ? { fields } : {}), ...(responses ? { responses } : {}) }
}

export function choiceAnswerText(choice: ParsedMessageChoices, answer: ChoiceAnswer): string {
  if (choice.questions?.length) {
    const answers = choice.questions.map(item => {
      const response = answer.responses?.[item.id]
      if (!response) return ''
      const value = response.status === 'skipped'
        ? '这项交给模型决定。结合已确认故事作出具体决定并说明理由，不保留待定、不再次询问；这不授权生成或保存文档。'
        : choiceAnswerText(item, response)
      return value ? `${item.question}\n${value}` : ''
    })
    return answers.every(Boolean) ? answers.join('\n\n') : ''
  }
  if (choice.fields?.length) {
    const entries = choice.fields.map(field => ({ label: field.label, value: answer.fields?.[field.id]?.trim() || '' }))
    if (entries.some(entry => !entry.value)) return ''
    return entries.map(entry => `${entry.label}：${entry.value}`).join('\n')
  }
  if (answer.custom) return answer.text.trim()
  const selected = choice.options.find(option => option.label === answer.selectedId)
  if (!selected) return ''
  if (!selected.requires_details) return selected.text
  const details = answer.text.trim()
  return details ? `${selected.text}\n补充：${details}` : ''
}

export default function DirectorQuestionPanel({ choice: group, answer: groupAnswer, busy, unavailable, controls, onConfigure, onStop, onChange: updateAnswer, onSkip, onContinue }: {
  choice: ParsedMessageChoices
  answer: ChoiceAnswer
  busy: boolean
  unavailable?: boolean
  controls?: ReactNode
  onConfigure?: () => void
  onStop?: () => void
  onChange: (answer: ChoiceAnswer) => void
  onSkip: () => Promise<void>
  onContinue: (text: string) => Promise<void>
}) {
  const submitLock = useRef(false)
  const [submitting, setSubmitting] = useState<'answer' | 'skip' | null>(null)
  const [questionIndex, setQuestionIndex] = useState(() => {
    const pending = group.questions?.findIndex(item => groupAnswer.responses?.[item.id]?.status !== 'skipped' && !choiceAnswerText(item, groupAnswer.responses?.[item.id] || { custom: false, text: '' }))
    return pending === undefined ? 0 : pending < 0 ? group.questions!.length - 1 : pending
  })
  const item = group.questions?.[questionIndex]
  const choice = item || group
  const answer = item ? groupAnswer.responses?.[item.id] || { custom: false, text: '' } : groupAnswer
  const onChange = (next: ChoiceAnswer) => updateAnswer(item ? { ...groupAnswer, responses: { ...groupAnswer.responses, [item.id]: { ...next, status: undefined } } } : next)
  const hasNext = !!group.questions && questionIndex < group.questions.length - 1
  const textarea = useRef<HTMLTextAreaElement>(null)
  const options = choice.options.filter(option => option.kind !== 'custom')
  const selected = options.find(option => option.label === answer.selectedId)
  const needsDetails = !answer.custom && selected?.requires_details
  const reply = item && answer.status === 'skipped' ? 'skipped' : choiceAnswerText(choice, answer)
  const disabled = busy || submitting !== null

  async function submit() {
    if (!reply || disabled || unavailable || submitLock.current) return
    if (hasNext) { setQuestionIndex(questionIndex + 1); return }
    const complete = group.questions ? choiceAnswerText(group, groupAnswer) : reply
    if (!complete) return
    submitLock.current = true
    setSubmitting('answer')
    try { await onContinue(complete) }
    finally { submitLock.current = false; setSubmitting(null) }
  }

  async function skip() {
    if (disabled || unavailable || submitLock.current) return
    if (item) {
      const next = { ...groupAnswer, responses: { ...groupAnswer.responses, [item.id]: { ...answer, status: 'skipped' as const } } }
      updateAnswer(next)
      if (hasNext) { setQuestionIndex(questionIndex + 1); return }
      const complete = choiceAnswerText(group, next)
      if (!complete) return
      submitLock.current = true; setSubmitting('skip')
      try { await onContinue(complete) } finally { submitLock.current = false; setSubmitting(null) }
      return
    }
    submitLock.current = true
    setSubmitting('skip')
    try { await onSkip() }
    finally { submitLock.current = false; setSubmitting(null) }
  }

  return <section className={`sd-question-panel${choice.fields?.length ? ' is-input-request' : ''}`} aria-label="当前待回答问题" aria-busy={disabled}>
    <header>{group.questions && <span className="sd-question-hint">第 {questionIndex + 1} / {group.questions.length} 项 · 全部回答后统一提交</span>}<strong>{choice.question}</strong></header>
    {choice.fields?.length ? <div className="sd-question-fields">
      <p className="sd-question-hint">填写你的设定；下方参考可多选，也可以自由补充。</p>
      {choice.fields.map(field => <div className="sd-question-field" key={field.id}>
        <label><span>{field.label}</span><textarea value={answer.fields?.[field.id] || ''} rows={2} maxLength={1600}
          aria-label={field.label} placeholder="填写你的设定…" disabled={disabled}
          onChange={event => onChange({ ...answer, fields: { ...answer.fields, [field.id]: event.currentTarget.value } })}
          onKeyDown={event => { if (shouldSendDirectorMessage({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) { event.preventDefault(); void submit() } }} /></label>
        {!!field.suggestions?.length && <div className="sd-question-suggestions" aria-label={`${field.label}的参考`}>
          {field.suggestions.map(suggestion => {
            const values = (answer.fields?.[field.id] || '').split('、').map(value => value.trim()).filter(Boolean)
            const selected = values.includes(suggestion)
            return <button key={suggestion} type="button" aria-pressed={selected} disabled={disabled} onClick={() => onChange({ ...answer,
              fields: { ...answer.fields, [field.id]: (selected ? values.filter(value => value !== suggestion) : [...values, suggestion]).join('、') },
            })}>{selected && <Check size={12} aria-hidden="true" />}{suggestion}</button>
          })}
        </div>}
      </div>)}
    </div> : <div className="sd-question-options" role="radiogroup" aria-label={choice.question}>
      {options.map((option, index) => <button key={option.label} type="button" role="radio"
        aria-checked={!answer.custom && answer.selectedId === option.label}
        className={!answer.custom && answer.selectedId === option.label ? 'is-selected' : ''}
        disabled={disabled} onClick={() => {
          onChange({ ...answer, custom: false, selectedId: option.label, text: answer.selectedId === option.label && !answer.custom ? answer.text : '' })
          if (option.requires_details) window.requestAnimationFrame(() => textarea.current?.focus())
        }}>
        <span className="sd-question-number">{index + 1}</span><span>{option.title}</span>
        {!answer.custom && answer.selectedId === option.label && <Check size={15} aria-hidden="true" />}
      </button>)}
      <button type="button" role="radio" aria-checked={answer.custom} className={answer.custom ? 'is-selected' : 'is-custom'}
        disabled={disabled} onClick={() => { onChange({ ...answer, custom: true }); window.requestAnimationFrame(() => textarea.current?.focus()) }}>
        <span className="sd-question-number">{options.length + 1}</span><span>我有别的想法</span>
        {answer.custom && <Check size={15} aria-hidden="true" />}
      </button>
    </div>}
    {!choice.fields?.length && (answer.custom || needsDetails) && <textarea ref={textarea} value={answer.text} maxLength={4000} rows={3}
      aria-label={needsDetails ? '补充所选方案' : '填写其他想法'} placeholder={needsDetails ? '请补充具体人选或范围…' : '写下你的方向，或补充对这些选项的修改…'} disabled={disabled}
      onChange={event => onChange({ ...answer, text: event.currentTarget.value })}
      onKeyDown={event => { if (shouldSendDirectorMessage({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) { event.preventDefault(); void submit() } }} />}
    {!controls && unavailable && <button type="button" className="sd-question-model" onClick={onConfigure}>请先配置可用文本模型</button>}
    <footer>{controls && <div className="sd-question-controls">{controls}</div>}
      <div className="sd-question-actions">
      {!!group.questions && questionIndex > 0 && <button type="button" disabled={disabled} onClick={() => setQuestionIndex(index => index - 1)}>上一项</button>}
      {onStop && disabled ? <button type="button" onClick={onStop}>停止生成</button> : <button type="button" disabled={disabled || unavailable} onClick={() => void skip()}>{submitting === 'skip' ? '正在跳过…' : '跳过'}</button>}
      <button type="button" className="sd-question-submit" disabled={disabled || unavailable || !reply || !!group.questions && !hasNext && !choiceAnswerText(group, groupAnswer)} onClick={() => void submit()}>
        {submitting === 'skip' ? '继续' : disabled ? '正在提交…' : hasNext ? '下一项' : '继续'}
      </button></div></footer>
  </section>
}
