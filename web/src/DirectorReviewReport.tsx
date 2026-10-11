import { WorkspaceDisclosure } from './WorkspaceDisclosure'
import type { DocumentReview } from '../../backend/src/script-review-types'

export default function DirectorReviewReport({ review }: { review: DocumentReview }) {
  const categories = { pending: '待定设定', missing: '缺失内容', contradiction: '设定矛盾', downstream_impact: '关联影响' }
  return <WorkspaceDisclosure className="sd-review-report" initiallyOpen={true} label={<>专业评审 · {review.findings.length} 项</>}><p>{review.summary}</p>
    <small>评审对应当时读取的文档版本；资料修改后需重新核对。</small>
    {review.findings.map((finding, index) => <article key={index}><strong>{categories[finding.category]}</strong><blockquote>{finding.quote}</blockquote><p>{finding.explanation}</p><p>建议：{finding.suggestion}</p>
      {!!finding.related.length && <small>关联：{finding.related.map(item => item.title).join('、')}</small>}
    </article>)}
  </WorkspaceDisclosure>
}
