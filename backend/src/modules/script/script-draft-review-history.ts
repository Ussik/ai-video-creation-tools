export const scriptDraftReviewHistoryGuidance = '既有处理记录中的历史问题（problem）和批次修补摘要（summaries）只说明过去发现的问题与处理过程，不是当前仍存在缺陷的证据，也不代表所有旧方案继续生效。' +
  '已核实记录（status 为 verified）中的具体 decision 是该事项已经采用的规则，核对当前正文是否落实，不重新要求创作者作同一决定；没有具体 decision 的旧记录不能据此推定答案。' +
  '决定或答复可能通过自由表达引用旧问答、其他文档或批次摘要，须结合保留的完整历史理解；没有命中某种指代词不表示这些资料无关。' +
  '同一事项存在明确相互矛盾的决定时，按有明确采用时间依据的较晚具体决定核对；不能仅凭数组顺序推定先后，不能从旧问题或整批摘要重新发明事实。创作者原话、完整原稿与当前候选正文仍按本次要求作为依据。\n'

/** Legacy decisions are free text with no complete dependency contract. Keep
 * their evidence intact; semantic independence cannot be proven by a word list. */
export function scriptDraftReviewHistory(context: unknown): unknown {
  return context
}
