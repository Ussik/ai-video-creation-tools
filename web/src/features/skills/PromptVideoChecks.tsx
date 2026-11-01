import { Alert } from '@mantine/core'
import type { VideoPromptDiagnostics } from '@video-studio/shared/media/video-prompt-checks'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'

export default function PromptVideoChecks({ diagnostics, files, edited, stale = false }: { diagnostics?: VideoPromptDiagnostics; files: string[]; edited: boolean; stale?: boolean }) {
  const review = diagnostics?.content_review
  return <section aria-label="动作与剧情核对">
    {diagnostics && <>
      <p>生成时长：{diagnostics.generation_duration === null ? '跟随素材' : `${diagnostics.generation_duration} 秒`} · 剪辑目标：{diagnostics.edit_duration === null ? '未绑定分镜' : `${diagnostics.edit_duration} 秒`}</p>
      <p>{diagnostics.references.mode === 'pixels' ? `已查看 ${diagnostics.references.inspected_asset_ids.length} 张参考图` : '仅依据文字，未查看参考图像素'} · {review ? '已独立核对动作与剧情' : '已检查逐字对白，尚未进行独立内容核对'}</p>
      {edited && <Alert color="yellow">正文已手动编辑，以下报告对应编辑前的结果；可继续调整以重新核对。</Alert>}
      {stale && <Alert color="yellow">镜头内容、参考图或生成配置已变化，以下报告依据已过期；重新整理后再应用。</Alert>}
      {review && <WorkspaceDisclosure label="主动作、次动作与剧情保留">
        <p><strong>主动作：</strong>{review.primary_action || '未明确'}</p>
        <p><strong>起始：</strong>{review.start_state || '未明确'}<br /><strong>结束：</strong>{review.end_state || '未明确'}</p>
        <p><strong>可见结果：</strong>{review.visible_result || '未明确'}</p>
        {!!review.secondary_actions.length && <p><strong>次动作：</strong>{review.secondary_actions.join('；')}</p>}
        {review.facts.map((fact, index) => <p key={index}><strong>{({ preserved: '保留', changed: '变化', missing: '遗漏', uncertain: '待确认' })[fact.status]}：</strong>{fact.fact}<br />{fact.evidence}</p>)}
      </WorkspaceDisclosure>}
      {diagnostics.issues.map((issue, index) => <Alert key={index} color={issue.severity === 'error' ? 'red' : 'yellow'} title={issue.message}>{issue.suggestion}</Alert>)}
      {!!review?.reference_findings.length && <WorkspaceDisclosure label="参考图视觉诊断">
        {review.reference_findings.map((finding, index) => <p key={index}><strong>图片 {finding.image_number}：</strong>{finding.observation}<br />{finding.suggestion}</p>)}
      </WorkspaceDisclosure>}
      <small>这是生成前的内容核对；实际动作效果需要生成后复核。</small>
    </>}
    {!!files.length && <WorkspaceDisclosure label={`本次实际加载资料 · ${files.length} 个文件`}>
      {files.map(file => <p key={file}>{file}</p>)}
    </WorkspaceDisclosure>}
  </section>
}
