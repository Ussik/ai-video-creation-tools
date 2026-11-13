import type { Asset, Shot } from '../../shared/api/api'

export type AssetLibraryView = 'history' | 'personal'
export type AssetLibraryFilters = { kind: 'all' | Asset['kind']; source: 'all' | Asset['source']; query: string; sort: 'oldest' | 'newest' }

export function libraryCollection(assets: Asset[], view: AssetLibraryView): Asset[] {
  return assets.filter(asset => view === 'history' ? asset.source === 'generated' : asset.saved)
}

export function filterLibraryAssets(assets: Asset[], shots: Pick<Shot, 'id' | 'title'>[], filters: AssetLibraryFilters, displayNames?: ReadonlyMap<string, string>): Asset[] {
  const query = filters.query.trim().toLocaleLowerCase()
  const titles = new Map(shots.map(shot => [shot.id, shot.title]))
  return assets.filter(asset => filters.kind === 'all' || asset.kind === filters.kind)
    .filter(asset => filters.source === 'all' || asset.source === filters.source)
    .filter(asset => !query || `${displayNames?.get(asset.id) || ''} ${asset.display_name || ''} ${asset.filename} ${asset.prompt || ''} ${titles.get(asset.shot_id || '') || ''}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => filters.sort === 'oldest' ? left.created_at.localeCompare(right.created_at) : right.created_at.localeCompare(left.created_at))
}

export function libraryEmptyText(view: AssetLibraryView, collectionCount: number): string {
  return collectionCount > 0 ? '没有符合条件的素材' : view === 'history' ? '暂无历史记录' : '暂无个人资产'
}
