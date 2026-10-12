import { useRef, useState } from 'react'
import { api, json } from '../../shared/api/api'

type PreparedDownload = { url: string; filename: string; count: number }

export function useAssetDownload(onNotice: (message: string) => void) {
  const [downloading, setDownloading] = useState(false)
  const pending = useRef(false)
  async function download(projectId: string, assetIds: string[]) {
    if (pending.current || !assetIds.length) return
    pending.current = true; setDownloading(true)
    try {
      const prepared = await api<PreparedDownload>(`/projects/${encodeURIComponent(projectId)}/asset-downloads`, json('POST', { asset_ids: assetIds }))
      const anchor = document.createElement('a')
      anchor.href = prepared.url; anchor.download = prepared.filename
      document.body.appendChild(anchor)
      try { anchor.click() } finally { anchor.remove() }
      onNotice(prepared.count > 1 ? `已开始下载 ZIP，包含 ${prepared.count} 个素材；进度可在浏览器下载列表查看` : '已开始下载素材；进度可在浏览器下载列表查看')
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error)) }
    finally { pending.current = false; setDownloading(false) }
  }
  return { downloading, download }
}
