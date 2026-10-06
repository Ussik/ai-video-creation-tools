import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { isCustomChoice } from './director-choices'
import type { ParsedMessageChoices } from './director-choices'
import { shouldSendDirectorMessage } from './director-window'

export type ChoiceAnswer = { selectedId?: string; custom: boolean; text: string; status?: 'answered' | 'skipped' }

export default function DirectorQuestionPanel({ choice, answer, busy, unavailable, controls, onConfigure, onStop, onChange, onSkip, onContinue }: {
  choice: ParsedMessageChoices
  answer: ChoiceAnswer
  busy: boolean
  unavailable?: boolean
  controls?: ReactNode
  onConfigure?: () => void
  onStop?: () => void
  onChange: (answer: ChoiceAnswer) => void
  onSkip: () => void
  onContinue: (text: string) => Promise<void>
}) {
  const submitLock = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const options = choice.options.filter(option => !isCustomChoice(option.text))
  const selected = options.find(option => option.label === answer.selectedId)
  const reply = answer.custom ? answer.text.trim() : selected?.text || ''
  const disabled = busy || submitting

  async function submit() {
    if (!reply || disabled || unavailable || submitLock.current) return
    submitLock.current = true
    setSubmitting(true)
    try { await onContinue(reply) }
    finally { submitLock.current = false; setSubmitting(false) }
  }

  return <section className="sd-question-panel" aria-label="当前待回答问题" aria-busy={disabled}>
    <header><strong>{choice.question}</strong></header>
    <div className="sd-question-options" role="radiogroup" aria-label={choice.question}>
      {options.map((option, index) => <button key={option.label} type="button" role="radio"
        aria-checked={!answer.custom && answer.selectedId === option.label}
        className={!answer.custom && answer.selectedId === option.label ? 'is-selected' : ''}
        disabled={disabled} onClick={() => onChange({ ...answer, custom: false, selectedId: option.label })}>
        <span className="sd-question-number">{index + 1}</span><span>{option.title}</span>
        {!answer.custom && answer.selectedId === option.label && <Check size={15} aria-hidden="true" />}
      </button>)}
      <button type="button" role="radio" aria-checked={answer.custom} className={answer.custom ? 'is-selected' : 'is-custom'}
        disabled={disabled} onClick={() => { onChange({ ...answer, custom: true }); window.requestAnimationFrame(() => textarea.current?.focus()) }}>
        <span className="sd-question-number">{options.length + 1}</span><span>我有别的想法</span>
        {answer.custom && <Check size={15} aria-hidden="true" />}
      </button>
    </div>
    {answer.custom && <textarea ref={textarea} value={answer.text} maxLength={4000} rows={3}
      aria-label="填写其他想法" placeholder="写下你的方向，或补充对这些选项的修改…" disabled={disabled}
      onChange={event => onChange({ ...answer, text: event.currentTarget.value })}
      onKeyDown={event => { if (shouldSendDirectorMessage({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) { event.preventDefault(); void submit() } }} />}
    {!controls && unavailable && <button type="button" className="sd-question-model" onClick={onConfigure}>请先配置可用文本模型</button>}
    <footer>{controls && <div className="sd-question-controls">{controls}</div>}
      {onStop && disabled ? <button type="button" onClick={onStop}>停止生成</button> : <button type="button" disabled={disabled} onClick={onSkip}>跳过</button>}
      <button type="button" className="sd-question-submit" disabled={disabled || unavailable || !reply} onClick={() => void submit()}>
        {disabled ? '正在提交…' : '继续'}
      </button></footer>
  </section>
}
