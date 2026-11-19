import type { ScriptCanvasPlan } from '@video-studio/shared/api/contracts'

export type ReferenceFailure = NonNullable<ScriptCanvasPlan['failed_units']>[number]
export type ReferenceRetry = { unit_key: string; token: string }
export function referenceDisplayName(unit: { name: string; variant?: string }, peers: Array<{ name: string; variant?: string }> = []): string {
  const showVariant = unit.variant && (unit.variant !== '默认' || peers.some(peer => peer.name === unit.name && peer.variant !== unit.variant))
  return showVariant ? `${unit.name} · ${unit.variant}` : unit.name
}
export function isUncertainReferenceRequest(issue: unknown): boolean {
  const failure = issue as { outcome_certainty?: string; code?: string; name?: string } | null
  return failure?.outcome_certainty === 'unknown' || failure?.name === 'TypeError'
    || /^(?:ai_delivery_unknown|model_delivery_unknown|structured_(?:initial|correction)_delivery_pending|visual_profile_legacy_delivery_pending)$/.test(failure?.code || '')
}
export function uncertainReferenceUnits(units: ReferenceFailure[], keys: string[]): ReferenceFailure[] {
  const affected = new Set(keys)
  return units.map(unit => affected.has(unit.unit_key) ? { ...unit, code: 'model_delivery_unknown', retryable: false,
    recovery: { action: 'inspect', model_call: 'unknown' } } : unit)
}
export type ReferenceFailureView = {
  unitKey: string; name: string; objectName: string
  status: '待处理' | '可本地恢复' | '需要重试' | '候选需处理' | '结果待确认' | '达到上限' | '预算已用尽' | '已跳过'
  summary: string; nextStep: string; impact: string; modelCall: string
  canContinue: boolean; retry?: ReferenceRetry
}

export function referenceFailureView(unit: ReferenceFailure): ReferenceFailureView {
  const coverage = unit.stage === 'coverage'
  const skipped = unit.code === 'visual_profile_skipped'
  const pending = unit.code === 'visual_profile_pending' || unit.code === 'visual_profile_dependency_blocked'
  const unknown = /^(?:structured_(?:initial|correction)_delivery_pending|visual_profile_legacy_delivery_pending|(?:model_)?delivery_unknown)$/.test(unit.code)
  const action = unknown ? 'inspect' : unit.recovery?.action || (pending ? 'continue' : 'inspect')
  const call = unknown ? 'unknown' : unit.recovery?.model_call || 'unknown'
  const retry = action === 'retry' && /^[a-f0-9]{64}$/.test(unit.recovery?.token || '')
    ? { unit_key: unit.unit_key, token: unit.recovery!.token! } : undefined
  const canContinue = action === 'continue' && !skipped
  const limited = unit.recovery?.reason?.match(/次尝试|实际模型请求|次实际模型请求/u) && unit.recovery?.action === 'none'
  const budget = /budget_exceeded|budget_exhausted/u.test(unit.code)
  const status = skipped ? '已跳过' : unknown ? '结果待确认' : limited ? '达到上限' : budget ? '预算已用尽' : retry ? '需要重试' : canContinue ? call === 'none' ? '可本地恢复' : '待处理' : '候选需处理'
  const objectName = unit.name || unit.unit_key
  const name = referenceDisplayName({ name: objectName, variant: unit.variant })
  const summary = coverage ? limited ? `本镜用途核对已达上限（${unit.model_request_count ?? unit.attempt} 次实际请求）` : '档案已保留，逐镜用途待核对' : skipped ? '你选择暂时跳过这个对象。'
    : unknown ? '上次请求尚未确认'
      : unit.code === 'visual_profile_dependency_blocked' ? '需先完成基础设定'
        : pending ? '尚未生成'
          : unit.code === 'visual_profile_locked_field_changed' ? '与已确认设定冲突'
            : unit.code === 'visual_profile_migration_conflict' ? '历史记录不一致'
              : '生成结果不符合要求'
  const nextStep = coverage && limited ? (unit.recovery?.reason || '本镜用途核对达到实际请求上限。') + ' 请展开本项详情，人工核对该镜头首帧或视频原文及用途；已完成档案会保留，不要整批重做。' : unit.recovery?.reason || (skipped ? '关闭后可重新打开，已有结果会保留；当前尚未加入画布。'
    : retry ? '仅重试这个对象及未完成的必要依赖；已完成对象和技能选择会复用。同一次重试不会因重复点击再次生成。'
      : canContinue ? '继续处理这个对象及必要依赖，优先复用已有结果。'
        : unknown ? '先核对上次请求结果，再决定如何恢复。当前不能自动续跑。'
          : '当前候选无法采用，请核对保留的原答与诊断；可在任务剩余额度内明确重新整理参考。')
  const shots = new Set(unit.shot_ids || []).size, scenes = new Set(unit.scene_ids || []).size
  const impact = shots ? '预计影响 ' + shots + ' 个镜头的参考绑定' + (scenes ? '，涉及 ' + scenes + ' 场' : '') + '；这是场次候选范围，实际出镜用途尚待确认。'
    : '预计影响相关镜头的参考绑定，具体范围待当前设定完成后确认。'
  const modelCall = call === 'none' && (retry || canContinue) ? '此恢复动作仅使用本地已有结果，不发起新的模型调用。' : coverage && (retry || canContinue) ? '仅为覆盖或用途冲突调用模型；已完成档案外观保持原样，可能产生用量。' : retry ? '首次执行本次重试会发起新的模型调用，可能产生费用；已完成的依赖不重复调用。'
    : call === 'none' && canContinue ? '此恢复动作仅使用本地已有结果，不发起新的模型调用。'
      : canContinue ? '可能发起新的模型调用，产生费用；已有成功结果会复用。'
        : '当前操作不发起模型调用；后续是否调用需先核对恢复条件。'
  return { unitKey: unit.unit_key, name, objectName, status, summary, nextStep, impact, modelCall, canContinue, retry }
}

