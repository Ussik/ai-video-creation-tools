export const imageNodeMinimum = { width: 160, height: 160 }

export function fitImageNode(size: { width: number; height: number }, image: { width: number; height: number }) {
  if (![size.width, size.height, image.width, image.height].every(value => Number.isFinite(value) && value > 2)) return size
  const ratio = image.width / image.height
  // Fit the image inside the existing frame, including its 1px border.
  const width = Math.min(size.width - 2, (size.height - 2) * ratio)
  const height = width / ratio
  const scale = Math.max(1, (imageNodeMinimum.width - 2) / width, (imageNodeMinimum.height - 2) / height)
  const next = { width: width * scale + 2, height: height * scale + 2 }
  return Math.abs(next.width - size.width) < 0.5 && Math.abs(next.height - size.height) < 0.5 ? size : next
}
