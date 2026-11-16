import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'

/** Observed execution steps, subordinate to the single source task status. */
export default function SourceRuntimeActivity({ analysis }: { analysis: ScriptSourceAnalysis }) {
  if (!analysis.runtime_events?.length) return null
  return <details className="sd-analysis-runtime"><summary>处理步骤（{analysis.runtime_events.length}）</summary>
    <ol>{analysis.runtime_events.map(event => <li key={event.id}>
      <span>{event.label}</span>{event.status === 'running' && <small> · 进行中</small>}
    </li>)}</ol>
    {!!analysis.runtime_events_omitted && <small>更早的 {analysis.runtime_events_omitted} 条步骤已归并。</small>}
  </details>
}
