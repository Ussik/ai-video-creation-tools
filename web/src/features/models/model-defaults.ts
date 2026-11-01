// Pass only models eligible for the task so capability requirements take priority.
export function preferredModel<T extends { is_default?: boolean }>(models: readonly T[]): T | undefined {
  return models.find(model => model.is_default) || models[0]
}

export function orderModelsByDefault<T extends { is_default?: boolean }>(models: readonly T[]): T[] {
  return [...models].sort((left, right) => Number(!!right.is_default) - Number(!!left.is_default))
}
