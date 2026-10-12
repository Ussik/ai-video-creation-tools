export type DirectorWindowRect = { x: number; y: number; width: number; height: number }
export type DirectorViewport = { width: number; height: number }

export function clampDirectorWindow(rect: DirectorWindowRect, viewport: DirectorViewport): DirectorWindowRect {
  const margin = 12
  const availableWidth = Math.max(1, viewport.width - margin * 2)
  const availableHeight = Math.max(1, viewport.height - margin * 2)
  const width = Math.min(availableWidth, Math.max(Math.min(360, availableWidth), Math.min(720, rect.width)))
  const height = Math.min(availableHeight, Math.max(Math.min(400, availableHeight), rect.height))
  return {
    width, height,
    x: Math.min(Math.max(margin, rect.x), Math.max(margin, viewport.width - width - margin)),
    y: Math.min(Math.max(margin, rect.y), Math.max(margin, viewport.height - height - margin)),
  }
}

export function defaultDirectorWindow(viewport: DirectorViewport): DirectorWindowRect {
  return clampDirectorWindow({ x: viewport.width - 456, y: viewport.height - 696, width: 440, height: 680 }, viewport)
}

export function shouldSendDirectorMessage(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229
}
