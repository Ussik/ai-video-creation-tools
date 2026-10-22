import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import type { DocumentReview } from '@video-studio/shared/script/script-review-types'
import { documentFindingLabels } from '@video-studio/shared/script/script-quality'
import { scriptReviewDisplayText } from './script-display-text'

export default function DirectorReviewReport({ review }: { review: DocumentReview }) {
  return <WorkspaceDisclosure className="sd-review-report" initiallyOpen={true} label={<>专业评审 · {review.findings.length} 项</>}><p>{scriptReviewDisplayText(review.summary, review.findings.map(finding => finding.quote))}</p>
    <small>评审对应当时读取的文档版本；资料修改后需重新核对。</small>
    {review.findings.map((finding, index) => <article key={index}><strong>{documentFindingLabels[finding.category]}</strong><blockquote>{finding.quote}</blockquote><p>{scriptReviewDisplayText(finding.explanation, [finding.quote])}</p><p>建议：{scriptReviewDisplayText(finding.suggestion, [finding.quote])}</p>
      {!!finding.related.length && <small>关联：{finding.related.map(item => item.title).join('、')}</small>}
    </article>)}
  </WorkspaceDisclosure>
}
