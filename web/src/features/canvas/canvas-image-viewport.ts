export type ImageSize = { width: number; height: number }
export type ImageView = { scale: number; x: number; y: number }

export const imagePreviewMaxScale = 4

export function imageFitScale(image: ImageSize, viewport: ImageSize) {
  if (!image.width || !image.height || !viewport.width || !viewport.height) return 1
  return Math.min(1, Math.max(1, viewport.width - 24) / image.width, Math.max(1, viewport.height - 24) / image.height)
}

export function clampImageView(view: ImageView, image: ImageSize, viewport: ImageSize): ImageView {
  const scale = Math.min(imagePreviewMaxScale, Math.max(Math.min(0.1, imageFitScale(image, viewport)), view.scale))
  const maxX = Math.max(0, (image.width * scale - viewport.width) / 2)
  const maxY = Math.max(0, (image.height * scale - viewport.height) / 2)
  return { scale, x: Math.max(-maxX, Math.min(maxX, view.x)), y: Math.max(-maxY, Math.min(maxY, view.y)) }
}

/** Keep the image point under the cursor in place while changing scale. */
export function zoomImageView(view: ImageView, scale: number, anchor: { x: number; y: number }, image: ImageSize, viewport: ImageSize): ImageView {
  const nextScale = clampImageView({ ...view, scale }, image, viewport).scale
  const ratio = nextScale / view.scale
  return clampImageView({ scale: nextScale, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio }, image, viewport)
}
