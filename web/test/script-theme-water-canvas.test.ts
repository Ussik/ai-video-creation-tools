import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ScriptThemeWaterCanvas } from '../src/ScriptThemeWaterCanvas.tsx'

// Exercise the component's actual lifecycle and RAF loop without relying on a
// GPU or wall-clock timers. The WebGL mock records the values used to draw each
// frame, while images stay pending until the test explicitly completes them.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'HTMLCanvasElement', 'Element']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
let now = 0
let nextFrame = 0
let reducedMotion = false
let hidden = false
let intersection: IntersectionObserverCallback | undefined
const frames = new Map<number, FrameRequestCallback>()
Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => hidden })
Object.defineProperty(globalThis.performance, 'now', { configurable: true, value: () => now })
dom.window.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame }
dom.window.cancelAnimationFrame = (id) => { frames.delete(id) }
Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: (media: string) => ({
  get matches() { return reducedMotion }, media, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
}) })

class PendingImage {
  static instances: PendingImage[] = []
  decoding = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  src = ''
  constructor() { PendingImage.instances.push(this) }
  complete() { this.onload?.() }
}
Object.defineProperty(globalThis, 'Image', { configurable: true, value: PendingImage })
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
  observe() {}
  disconnect() {}
} })
const canvasRect = { left: 0, top: 0, right: 582, bottom: 428, width: 582, height: 428, x: 0, y: 0, toJSON: () => ({}) }
Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
  constructor(callback: IntersectionObserverCallback) { intersection = callback }
  observe() {}
  disconnect() {}
} })
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => canvasRect })
after(() => dom.window.close())

type Texture = { id: number }
type Upload = { texture: Texture | null; source: string | null }
function mockWebGL() {
  const uniforms = new Map<string, number>()
  const uploads: Upload[] = []
  const deletedTextures: Texture[] = []
  let textureId = 0
  let boundTexture: Texture | null = null
  let programCount = 0
  let drawCount = 0
  const noop = () => {}
  return {
    uniforms, uploads, deletedTextures,
    get programCount() { return programCount },
    get drawCount() { return drawCount },
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713,
    LINK_STATUS: 35714, TEXTURE_2D: 3553, TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243, CLAMP_TO_EDGE: 33071, TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240, LINEAR: 9729, RGBA: 6408, UNSIGNED_BYTE: 5121,
    ARRAY_BUFFER: 34962, STATIC_DRAW: 35044, FLOAT: 5126, COLOR_BUFFER_BIT: 16384,
    BLEND: 3042, SRC_ALPHA: 770, ONE_MINUS_SRC_ALPHA: 771, TEXTURE0: 33984,
    TEXTURE1: 33985, TRIANGLES: 4, UNPACK_FLIP_Y_WEBGL: 37440,
    createShader: () => ({}), shaderSource: noop, compileShader: noop,
    getShaderParameter: () => true, deleteShader: noop,
    createProgram: () => { programCount++; return {} }, attachShader: noop,
    linkProgram: noop, getProgramParameter: () => true, deleteProgram: noop,
    createBuffer: () => ({}), bindBuffer: noop, bufferData: noop, deleteBuffer: noop,
    createTexture: () => ({ id: ++textureId }),
    bindTexture: (_target: number, texture: Texture | null) => { boundTexture = texture },
    texParameteri: noop,
    texImage2D: (...args: unknown[]) => {
      const image = args[args.length - 1]
      uploads.push({ texture: boundTexture, source: image instanceof PendingImage ? image.src : null })
    },
    deleteTexture: (texture: Texture) => { deletedTextures.push(texture) },
    pixelStorei: noop, useProgram: noop, getAttribLocation: () => 0,
    enableVertexAttribArray: noop, vertexAttribPointer: noop,
    getUniformLocation: (_program: unknown, name: string) => name,
    uniform1f: (name: string, value: number) => { uniforms.set(name, value) },
    uniform1i: noop, uniform2f: noop, viewport: noop, clearColor: noop,
    clear: noop, enable: noop, disable: noop, blendFunc: noop, activeTexture: noop, drawArrays: () => { drawCount++ },
  }
}

type Props = Parameters<typeof ScriptThemeWaterCanvas>[0]
function mount(initial: Partial<Props> = {}) {
  now = 0
  reducedMotion = false
  hidden = false
  frames.clear()
  PendingImage.instances = []
  const gl = mockWebGL()
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => gl })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let mounted = true
  let props: Props = { primary: '玄幻修仙', fusion: '', primaryArtwork: '/primary.jpg', ...initial }
  act(() => { root.render(createElement(ScriptThemeWaterCanvas, props)) })
  return {
    gl,
    render(next: Partial<Props>) {
      props = { ...props, ...next }
      act(() => { root.render(createElement(ScriptThemeWaterCanvas, props)) })
    },
    tick(milliseconds: number) {
      assert.ok(milliseconds >= now, 'manual clock must move forward')
      now = milliseconds
      const pending = [...frames.values()]
      frames.clear()
      act(() => { for (const callback of pending) callback(now) })
    },
    finishImages() { for (const image of PendingImage.instances) image.complete() },
    get progress() { return gl.uniforms.get('u_fusionProgress')! },
    get hasFusion() { return gl.uniforms.get('u_hasFusion')! },
    dispose() {
      if (mounted) act(() => { root.unmount() })
      mounted = false
      container.remove()
    },
  }
}

test('removing fusion retains its cover and visible lobe until the reverse merge settles', () => {
  const settled: boolean[] = []
  const view = mount({ fusion: '都市现实', fusionArtwork: '/fusion.jpg', onFusionSettled: value => settled.push(value) })
  try {
    view.finishImages()
    view.tick(0)
    assert.equal(view.hasFusion, 1)
    assert.equal(view.progress, 1)
    const fusionUpload = view.gl.uploads.find(upload => upload.source === '/fusion.jpg')!
    assert.ok(fusionUpload, 'the selected fusion cover must reach the texture')

    view.render({ fusion: '', fusionArtwork: undefined })
    view.tick(180)
    assert.equal(view.hasFusion, 1, 'the fusion lobe remains drawn while merging')
    assert.ok(view.progress > 0 && view.progress < 1, 'removal must animate instead of popping')
    const fusionUploads = view.gl.uploads.filter(upload => upload.texture === fusionUpload.texture)
    assert.equal(fusionUploads.at(-1)?.source, '/fusion.jpg', 'retain the fusion cover during collapse')
    assert.equal(view.gl.programCount, 1, 'removal must not recreate the GPU renderer')
    assert.deepEqual(settled, [], 'do not release the paired layout before the lobe has merged')

    view.tick(1000)
    assert.equal(view.hasFusion, 0)
    assert.equal(view.progress, 0)
    assert.deepEqual(settled, [false], 'notify the parent after the reverse merge completes')
  } finally { view.dispose() }
})

test('changing either selected topic updates its artwork without replaying the split', () => {
  const view = mount({ fusion: '都市现实', fusionArtwork: '/fusion.jpg' })
  try {
    view.tick(0)
    view.render({ primary: '悬疑推理', primaryArtwork: '/mystery.jpg', fusion: '家庭伦理', fusionArtwork: '/family.jpg' })
    view.tick(16)
    view.finishImages()
    assert.equal(view.hasFusion, 1)
    assert.equal(view.progress, 1)
    assert.ok(view.gl.uploads.some(upload => upload.source === '/mystery.jpg'))
    assert.ok(view.gl.uploads.some(upload => upload.source === '/family.jpg'))
    assert.equal(view.gl.programCount, 1)
  } finally { view.dispose() }
})

test('rapid add, remove, and add reverses the in-flight merge without snapping', () => {
  const view = mount()
  try {
    view.tick(0)
    view.render({ fusion: '都市现实', fusionArtwork: '/fusion.jpg' })
    view.tick(230)
    const opening = view.progress
    assert.ok(opening > 0 && opening < 1)

    view.render({ fusion: '', fusionArtwork: undefined })
    view.tick(310)
    const closing = view.progress
    assert.ok(closing > 0 && closing < opening)

    view.render({ fusion: '都市现实', fusionArtwork: '/fusion.jpg' })
    view.tick(310)
    assert.equal(view.progress, closing, 'reversing direction starts at the currently rendered shape')
    assert.equal(view.hasFusion, 1)
    view.tick(520)
    assert.ok(view.progress > closing && view.progress < 1)
    view.tick(1200)
    assert.equal(view.progress, 1)
    assert.equal(view.gl.programCount, 1)
  } finally { view.dispose() }
})

test('unmount cancels RAF and prevents pending image callbacks from writing deleted textures', () => {
  const view = mount({ fusion: '都市现实', fusionArtwork: '/fusion.jpg' })
  assert.ok(PendingImage.instances.filter(image => image.onload).length >= 2, 'both cover loads should be pending')
  const uploadsBeforeUnmount = view.gl.uploads.length
  view.dispose()
  assert.equal(frames.size, 0)
  assert.equal(view.gl.deletedTextures.length, 2)
  assert.ok(PendingImage.instances.every(image => image.onload === null), 'cleanup must detach pending image handlers')
  view.finishImages()
  assert.equal(view.gl.uploads.length, uploadsBeforeUnmount)
})

test('a replaced cover request cannot overwrite the newer selected topic texture', () => {
  const view = mount({ fusion: '都市现实', fusionArtwork: '/old-fusion.jpg' })
  try {
    view.tick(0)
    const oldCover = PendingImage.instances.find(image => image.src === '/old-fusion.jpg')!
    view.render({ fusion: '家庭伦理', fusionArtwork: '/new-fusion.jpg' })
    view.tick(16)
    const newCover = PendingImage.instances.find(image => image.src === '/new-fusion.jpg')!
    assert.ok(newCover, 'selecting a new topic starts its cover request')
    newCover.complete()
    const uploadsBeforeOldCompletion = view.gl.uploads.length
    oldCover.complete()
    assert.equal(oldCover.onload, null)
    assert.equal(view.gl.uploads.length, uploadsBeforeOldCompletion, 'the stale load cannot replace the current cover')
    assert.equal(view.gl.uploads.at(-1)?.source, '/new-fusion.jpg')
  } finally { view.dispose() }
})

test('missing and failed covers use neutral mist and cannot retain another topic photo', () => {
  const view = mount({ fusion: '民俗恐怖', fusionArtwork: undefined })
  try {
    view.tick(0)
    assert.equal(view.gl.uniforms.get('u_fusionHasPhoto'), 0)
    assert.ok(PendingImage.instances.some(image => image.src.endsWith('/neutral.svg')))
    view.finishImages()
    view.tick(16)
    assert.equal(view.gl.uniforms.get('u_primaryHasPhoto'), 1)
    assert.equal(view.gl.uniforms.get('u_fusionHasPhoto'), 0, 'unknown fusion never borrows primary cover')
    view.render({ primaryArtwork: '/broken.jpg' })
    view.tick(32)
    assert.equal(view.gl.uniforms.get('u_primaryHasPhoto'), 0, 'reset old artwork while loading another genre')
    PendingImage.instances.find(image => image.src === '/broken.jpg')!.onerror?.()
    view.tick(48)
    assert.equal(view.gl.uniforms.get('u_primaryHasPhoto'), 0)
    view.render({ primaryArtwork: undefined })
    view.tick(64)
    view.finishImages()
    view.tick(80)
    assert.equal(view.gl.uniforms.get('u_primaryHasPhoto'), 0)
    assert.equal(view.gl.programCount, 1)
  } finally { view.dispose() }
})

test('water motion caps draw frequency and resolution while hidden/closed surfaces stop completely', () => {
  Object.defineProperty(dom.window, 'devicePixelRatio', { configurable: true, value: 2 })
  const view = mount()
  try {
    view.finishImages()
    for (let time = 0; time <= 1000; time += 10) view.tick(time)
    assert.ok(view.gl.drawCount >= 18 && view.gl.drawCount <= 25, 'ongoing shader work stays at or below24fps')
    assert.equal(document.querySelector('canvas')!.width, Math.round(canvasRect.width * 1.5))
    const before = view.gl.drawCount
    act(() => intersection!([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
    assert.equal(frames.size, 0)
    view.tick(1300); assert.equal(view.gl.drawCount, before)
    act(() => intersection!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    view.tick(1400); assert.ok(view.gl.drawCount > before)
    view.render({ active: false }); assert.equal(frames.size, 0)
    const closed = view.gl.drawCount; view.tick(1500); assert.equal(view.gl.drawCount, closed)
    view.render({ active: true }); view.tick(1600); assert.ok(view.gl.drawCount > closed)
    hidden = true; act(() => document.dispatchEvent(new dom.window.Event('visibilitychange')))
    assert.equal(frames.size, 0)
    hidden = false; act(() => document.dispatchEvent(new dom.window.Event('visibilitychange')))
    view.tick(1700); assert.ok(frames.size > 0)
  } finally { view.dispose() }
})

test('reduced motion renders changes and loaded textures once instead of keeping a RAF loop', () => {
  const view = mount({ fusion: '都市现实', fusionArtwork: '/fusion.jpg' })
  try {
    reducedMotion = true
    view.tick(0)
    assert.equal(frames.size, 0)
    const before = view.gl.drawCount
    view.finishImages(); view.tick(20)
    assert.equal(view.gl.drawCount, before + 1); assert.equal(frames.size, 0)
    view.tick(1000); assert.equal(view.gl.drawCount, before + 1)
    view.render({ fusion: '' }); view.tick(1100)
    assert.equal(view.hasFusion, 0); assert.equal(view.progress, 0); assert.equal(frames.size, 0)
    view.render({ primaryArtwork: '/changed.jpg' }); view.tick(1200)
    PendingImage.instances.find(image => image.src === '/changed.jpg')!.complete(); view.tick(1210)
    assert.equal(view.gl.uniforms.get('u_primaryHasPhoto'), 1); assert.equal(frames.size, 0)
  } finally { view.dispose() }
})
