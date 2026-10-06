import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { ParsedMessageChoices } from './director-choices'
import { shouldSendDirectorMessage } from './director-window'

export type ChoiceAnswer = { selectedId?: string; custom: boolean; text: string; fields?: Record<string, string>; status?: 'answered' | 'skipped' }

export function choiceAnswerText(choice: ParsedMessageChoices, answer: ChoiceAnswer): string {
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

export default function DirectorQuestionPanel({ choice, answer, busy, unavailable, controls, onConfigure, onStop, onChange, onSkip, onContinue }: {
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
  const textarea = useRef<HTMLTextAreaElement>(null)
  const options = choice.options.filter(option => option.kind !== 'custom')
  const selected = options.find(option => option.label === answer.selectedId)
  const needsDetails = !answer.custom && selected?.requires_details
  const reply = choiceAnswerText(choice, answer)
  const disabled = busy || submitting !== null

  async function submit() {
    if (!reply || disabled || unavailable || submitLock.current) return
    submitLock.current = true
    setSubmitting('answer')
    try { await onContinue(reply) }
    finally { submitLock.current = false; setSubmitting(null) }
  }

  async function skip() {
    if (disabled || unavailable || submitLock.current) return
    submitLock.current = true
    setSubmitting('skip')
    try { await onSkip() }
    finally { submitLock.current = false; setSubmitting(null) }
  }

  return <section className={`sd-question-panel${choice.fields?.length ? ' is-input-request' : ''}`} aria-label="当前待回答问题" aria-busy={disabled}>
    <header><strong>{choice.question}</strong></header>
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
      {onStop && disabled ? <button type="button" onClick={onStop}>停止生成</button> : <button type="button" disabled={disabled || unavailable} onClick={() => void skip()}>{submitting === 'skip' ? '正在跳过…' : '跳过'}</button>}
      <button type="button" className="sd-question-submit" disabled={disabled || unavailable || !reply} onClick={() => void submit()}>
        {submitting === 'skip' ? '继续' : disabled ? '正在提交…' : '继续'}
      </button></div></footer>
  </section>
}
