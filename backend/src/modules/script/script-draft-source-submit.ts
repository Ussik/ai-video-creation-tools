import { createTextToolTransport, type GenerationModel, type GenerationProvider } from '../../infrastructure/providers/providers.js'
import { annotateTextFailure, TextProviderError } from '../../infrastructure/providers/text-errors.js'
import type { OutputContract } from '../generation/model-output.js'

const name = 'submit_source_repair'
const description = '提交当前原稿必要同步的完整结构化结果，仅供后续校验，不保存或执行修改。'
const instruction = '【本次唯一交付协议】本次显式提供submit_source_repair提交工具。仅调用一次该工具，参数必须完整符合其Schema。' +
  '此工具仅提交待验证结果，不读取、搜索、执行或保存任何文档。没有其他可用工具，不调用资料中提到的工具。' +
  '下文“没有工具”“仅返回JSON”等旧文本交付说明仅描述结果内容；本次必须把同一完整JSON对象作为submit_source_repair参数提交。' +
  '原稿默认不改，除非本次明确决定确需最小同步；全部原稿、反馈、决定与规则继续生效。\n'
/** Only the source worker opts into this transport. Include its full protocol
 * instruction in that worker identity, without invalidating candidate siblings. */
export const scriptDraftSourceSubmitIdentity = Object.freeze({ version: 1, transport: 'anthropic_single_submit', tool_name: name, tool_description: description, instruction })

/** One transport request, one complete declared submission. There is no tool
 * dispatcher, continuation loop, hidden retry or arbitrary argument adoption. */
export async function generateScriptDraftSourceSubmit(model: GenerationModel, provider: GenerationProvider, prompt: string,
  contract: OutputContract | undefined, resolveKey: (provider: GenerationProvider) => string, signal?: AbortSignal): Promise<string> {
  if (model.protocol !== 'anthropic_messages' || !contract || !['script_draft_workset_source', 'script_draft_workset_source_local_repair'].includes(contract.name)) throw new Error('原稿同步单次提交仅适用于当前原生Messages结构化契约')
  const turn = await createTextToolTransport(model, provider, instruction + prompt,
    [{ name, description, parameters: contract.schema, access: 'read' }],
    undefined, [], resolveKey, signal, undefined, undefined, undefined, { parallelCalls: false })
  signal?.throwIfAborted()
  if (turn.calls.length !== 1 || turn.calls[0]!.name !== name) {
    const issue = new TextProviderError('原稿同步必须且仅能提交一次当前声明的结果工具，未执行任何工具或文档修改', false, 'invalid_tool_call')
    annotateTextFailure(issue, { delivery: 'completed', tool: true })
    throw issue
  }
  // Arguments remain untrusted text. Existing structured-output and exact-span
  // validators own schema/business validation, correction and atomic adoption.
  return turn.calls[0]!.arguments
}

const candidateName = 'submit_draft_repair'
const candidateDescription = '提交当前候选工作集的完整精确编辑结果，仅供后续校验，不保存或执行修改。'
const candidateInstruction = '【本次唯一交付协议】本次显式提供submit_draft_repair提交工具。仅调用一次该工具，参数必须完整符合其Schema。' +
  '此工具仅提交当前工作集待验证结果，不读取、搜索、执行或保存任何文档。没有其他可用工具，不调用资料中提到的工具。' +
  '下文“没有工具”“仅返回JSON”等旧文本交付说明仅描述结果内容；本次必须把同一完整JSON对象作为submit_draft_repair参数提交。' +
  '全部冻结正文、原稿、反馈、决定与规则继续生效；仅修改当前工作集，不提交source_edits或重新决定。\n'
export const scriptDraftCandidateSubmitIdentity = Object.freeze({ version: 1, transport: 'anthropic_single_submit', tool_name: candidateName,
  tool_description: candidateDescription, instruction: candidateInstruction })

/** Candidate submission has its own explicit contract and identity. Source
 * transport instructions and all previously retained source identities stay exact. */
export async function generateScriptDraftCandidateSubmit(model: GenerationModel, provider: GenerationProvider, prompt: string,
  contract: OutputContract | undefined, resolveKey: (provider: GenerationProvider) => string, signal?: AbortSignal): Promise<string> {
  if (model.protocol !== 'anthropic_messages' || !contract || !['script_draft_workset_candidate', 'script_draft_workset_candidate_local_repair'].includes(contract.name)) throw new Error('候选修订单次提交仅适用于当前原生Messages结构化契约')
  const turn = await createTextToolTransport(model, provider, candidateInstruction + prompt,
    [{ name: candidateName, description: candidateDescription, parameters: contract.schema, access: 'read' }],
    undefined, [], resolveKey, signal, undefined, undefined, undefined, { parallelCalls: false })
  signal?.throwIfAborted()
  if (turn.calls.length !== 1 || turn.calls[0]!.name !== candidateName) {
    const issue = new TextProviderError('候选修订必须且仅能提交一次当前声明的结果工具，未执行任何工具或文档修改', false, 'invalid_tool_call')
    annotateTextFailure(issue, { delivery: 'completed', tool: true })
    throw issue
  }
  return turn.calls[0]!.arguments
}
