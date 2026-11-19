import { Accordion } from '@mantine/core'
import type { ShotPurgePreview } from '@video-studio/shared/storyboard/shot-management'
import './shot-purge-details.css'

const deletionTypes: Record<string, string> = {
  shots: '分镜', assets: '生成素材', visual_profiles: '专属参考档案', shot_visual_bindings: '镜头参考关联',
  visual_profile_candidates: '参考候选', visual_profile_reference_assets: '参考素材关联',
  jobs: '生成任务', asset_tasks: '参考任务', asset_task_events: '参考任务历史',
  model_request_tasks: '模型任务记录', model_request_attempts: '模型请求记录',
  ai_operations: '操作历史', business_tasks: '业务任务历史', asset_reviews: '素材复核历史',
  shot_candidate_archives: '镜头候选历史', video_reviews: '视频复核历史', video_comparisons: '视频对照历史', cut_reviews: '接镜历史',
  model_unit_checkpoints: '生成恢复记录', script_step_checkpoints: '流程恢复记录', candidate_review_evidence: '候选证据',
  shot_plan_requests: '分镜恢复记录', script_generation_checkpoints: '剧本恢复记录',
  resource_submissions: '提交关联', job_image_recovery: '图片恢复记录', job_video_recovery: '视频恢复记录', job_generation_attempts: '生成请求记录',
}
const protectedTypes: Record<string, string> = { profile: '共享参考', asset: '共享素材', file: '共享文件', history: '共享历史' }
function counts(items: Array<{kind:string}>, labels: Record<string,string>) {
  const groups = new Map<string, number>()
  for (const item of items) { const label=labels[item.kind] || '其他关联记录'; groups.set(label,(groups.get(label)||0)+1) }
  return [...groups]
}
export function shotPurgeMessage(preview: ShotPurgePreview) {
  const protectedCounts=counts(preview.protected,protectedTypes)
  return '这些分镜及其专属生成资源、参考和历史将一并删除，不可恢复。' +
    (preview.files.length ? `同时删除 ${preview.files.length} 个本地媒体文件。` : '') +
    (protectedCounts.length ? `将保留${protectedCounts.map(([label,count])=>`${count} 项${label}`).join('、')}。` : '') +
    '不会取消远端请求或消除已产生的费用。'
}
export function ShotPurgeDetails({ preview }: {preview:ShotPurgePreview}) {
  return <Accordion className="shot-purge-details" variant="default">
    <Accordion.Item value="scope"><Accordion.Control>查看删除范围</Accordion.Control><Accordion.Panel>
      <div className="shot-purge-details-scroll" tabIndex={0}>
        <dl>{counts(preview.delete,deletionTypes).map(([label,count])=><div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
        {preview.protected.length>0 && <><strong>以下共享内容保留</strong><dl>{counts(preview.protected,protectedTypes).map(([label,count])=><div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl><p>仍被其他镜头、画布或素材记录引用的共享内容不会删除。</p></>}
      </div>
    </Accordion.Panel></Accordion.Item>
  </Accordion>
}
export function ShotPurgeBlockers({ reasons }: {reasons:string[]}) {
  return <Accordion className="shot-purge-details" variant="default"><Accordion.Item value="blockers"><Accordion.Control>查看阻止删除的原因</Accordion.Control><Accordion.Panel><ul className="shot-purge-details-scroll" tabIndex={0}>{[...new Set(reasons)].map(reason=><li key={reason}>{reason}</li>)}</ul></Accordion.Panel></Accordion.Item></Accordion>
}
