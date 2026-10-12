import { useEffect, useRef } from 'react'
import { neutralThemeArtwork } from '@video-studio/shared/script/script-theme-catalog'

type ScriptThemeWaterCanvasProps = {
  primary: string
  fusion: string
  primaryArtwork?: string
  fusionArtwork?: string
  active?: boolean
  onFusionSettled?: (hasFusion: boolean) => void
}

const vertexSource = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

// A single liquid surface owns the silhouette, lens, reflections and halo.
const fragmentSource = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_dpr;
uniform float u_sceneScale;
uniform float u_time;
uniform float u_hasFusion;
uniform float u_fusionProgress;
uniform sampler2D u_primary;
uniform sampler2D u_fusion;
uniform float u_primaryHasPhoto;
uniform float u_fusionHasPhoto;

vec3 centerA;
vec3 centerB;
vec2 radius;
float cohesion = 0.14;

float merge(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float droplet(vec3 p, vec3 center, float r) {
  vec3 local = p - center;
  // Keep the motion phase independent of the animated lobe center. During a
  // split/merge the center moves rapidly; using it as a phase would make the
  // ellipse direction jump and create the violent shake seen in transition.
  float phase = u_time * 1.42;
  // Rotate the long axis in short, seeded direction segments. Each segment
  // chooses CCW or CW independently, while the angle returns through neutral
  // at the boundary so the water never snaps to a new pose.
  float turnLength = 1.9;
  float turnIndex = floor(u_time / turnLength);
  float turnT = (u_time - turnIndex * turnLength) / turnLength;
  float turnSeed = fract(sin(turnIndex * 127.1 + 19.7) * 43758.5453);
  float turnDirection = turnSeed > 0.5 ? 1.0 : -1.0;
  float ellipseAngle = turnDirection * 0.22 * sin(turnT * 3.14159265);
  float axisC = cos(ellipseAngle);
  float axisS = sin(ellipseAngle);
  vec2 ellipseSpace = vec2(
    local.x * axisC + local.y * axisS,
    -local.x * axisS + local.y * axisC
  );
  // Keep the original gentle deformation at the faster motion frequency.
  float stretch = 0.045 + 0.012 * (0.5 + 0.5 * sin(phase * 1.55 + 0.65));
  ellipseSpace /= vec2(1.0 + stretch, 1.0 - stretch * 0.78);
  float body = length(vec3(ellipseSpace, local.z)) - r;
  // Keep the standalone silhouette clean; the real fusion neck comes from the
  // smooth union of the two full droplets below, rather than fixed bumps on
  // each individual ball.
  return body;
}

vec2 fields(vec3 p) {
  float a = droplet(p, centerA, radius.x);
  float b = radius.y > 0.001 ? droplet(p, centerB, radius.y) : 10.0;
  return vec2(a, b);
}

float surface(vec3 p) {
  vec2 d = fields(p);
  float merged = merge(d.x, d.y, cohesion);
  // Keep the ripple inside the liquid volume so the raymarched normals and
  // the reflected light move with the silhouette instead of only changing
  // the canvas alpha edge.
  float radialA = length(p.xy - centerA.xy);
  float radialB = length(p.xy - centerB.xy);
  float radial = min(radialA, radialB);
  float rippleMask = 1.0 - smoothstep(0.30, 0.84, radial);
  // Keep the ripples broad and low frequency so the edge reads as liquid
  // movement instead of noisy blur. The signed distance field also moves
  // the highlight, at the original small ripple amplitude.
  float ripple = 0.0012 * rippleMask * (
    sin(p.x * 7.0 + u_time * 0.62) * cos(p.y * 5.8 - u_time * 0.52)
    + 0.28 * sin((p.x + p.y) * 11.0 - u_time * 0.38)
  );
  return merged + ripple;
}

vec3 normalAt(vec3 p) {
  const float e = 0.003;
  return normalize(vec3(
    surface(p + vec3(e, 0.0, 0.0)) - surface(p - vec3(e, 0.0, 0.0)),
    surface(p + vec3(0.0, e, 0.0)) - surface(p - vec3(0.0, e, 0.0)),
    surface(p + vec3(0.0, 0.0, e)) - surface(p - vec3(0.0, 0.0, e))
  ));
}

vec3 photograph(sampler2D photo, vec3 p, vec3 center, float r, vec3 normal) {
  vec2 local = (p.xy - center.xy) / max(r, 0.001);
  float radial = clamp(length(local), 0.0, 1.0);
  float sphere = sqrt(max(1.0 - radial * radial, 0.001));
  float lens = mix(1.0, 1.0 / max(sphere, 0.2), 0.026);
  vec2 uv = local * 0.497 * lens - normal.xy * 0.092 + 0.5;
  uv += vec2(sin(local.y * 5.8 + u_time * 0.52), cos(local.x * 5.2 - u_time * 0.43))
    * 0.003 * (1.0 - smoothstep(0.60, 0.98, radial));
  uv = clamp(uv, 0.005, 0.995);
  vec3 sharp = texture2D(photo, uv).rgb;
  // A narrow band of inverted, softened artwork reads as light passing
  // through a thick glass wall; the centre stays crisp.
  vec2 rimUv = vec2(uv.x, 1.0 - uv.y);
  vec2 tap = vec2(0.027);
  vec3 bleed = texture2D(photo, rimUv).rgb * 0.40;
  bleed += texture2D(photo, clamp(rimUv + tap, 0.005, 0.995)).rgb * 0.15;
  bleed += texture2D(photo, clamp(rimUv - tap, 0.005, 0.995)).rgb * 0.15;
  bleed += texture2D(photo, clamp(rimUv + vec2(tap.x, -tap.y), 0.005, 0.995)).rgb * 0.15;
  bleed += texture2D(photo, clamp(rimUv + vec2(-tap.x, tap.y), 0.005, 0.995)).rgb * 0.15;
  return mix(sharp, bleed, smoothstep(0.80, 0.985, radial) * 0.68);
}

vec3 coverEnvironment(sampler2D photo) {
  return texture2D(photo, vec2(0.5)).rgb * 0.40
    + texture2D(photo, vec2(0.28, 0.28)).rgb * 0.15
    + texture2D(photo, vec2(0.72, 0.28)).rgb * 0.15
    + texture2D(photo, vec2(0.28, 0.72)).rgb * 0.15
    + texture2D(photo, vec2(0.72, 0.72)).rgb * 0.15;
}

// Empty droplets use small highlights and thin refraction arcs on a clear body.
vec4 waterSurface(vec3 normal, float outline) {
  float grazing = 1.0 - clamp(normal.z, 0.0, 1.0);
  float fresnel = 0.020 + 0.980 * pow(grazing, 5.0);
  float glint = pow(max(dot(normal, normalize(vec3(-0.44, -0.55, 0.80))), 0.0), 160.0);
  float crown = pow(max(dot(normal, normalize(vec3(0.15, -0.87, 0.48))), 0.0), 110.0) * 0.45;
  float edgeLight = pow(max(dot(normal.xy, normalize(vec2(-0.70, -0.72))), 0.0), 3.0);
  float rim = exp(-abs(outline) * 105.0) * (0.15 + edgeLight * 0.85);
  float meniscus = exp(-pow((outline + 0.025) * 100.0, 2.0));
  float caustic = pow(max(dot(normal, normalize(vec3(0.48, 0.78, 0.28))), 0.0), 32.0);
  float lowerArc = exp(-pow((outline + 0.065) * 42.0, 2.0))
    * pow(max(dot(normal.xy, normalize(vec2(0.55, 0.83))), 0.0), 5.0);
  float reflection = clamp(glint + crown + rim * 0.75 + meniscus * caustic * 0.28 + lowerArc * 0.48, 0.0, 1.0);
  vec3 color = mix(vec3(0.36, 0.48, 0.53), vec3(0.94, 0.98, 1.0), reflection);
  float opacity = clamp(0.085 + fresnel * 0.30 + reflection * 0.70 + caustic * 0.12, 0.0, 0.90);
  return vec4(color, opacity);
}

vec3 glassTone(vec3 tint) {
  float luma = max(dot(tint, vec3(0.30, 0.59, 0.11)), 0.08);
  return clamp(tint / luma, vec3(0.45), vec3(1.65));
}

vec3 studioReflection(vec3 direction, vec3 tint) {
  // Restore the broader curved reflections for droplets with topic artwork.
  float c = cos(-0.15);
  float s = sin(-0.15);
  vec2 ray = vec2(direction.x * c - direction.y * s, -direction.x * s - direction.y * c);
  vec2 key = (ray - vec2(-0.53, 0.18)) / vec2(0.20, 1.38);
  vec2 crown = (ray - vec2(0.10, 0.78)) / vec2(0.95, 0.22);
  vec2 fill = (ray - vec2(0.70, -0.53)) / vec2(0.32, 0.48);
  float strip = exp(-key.x * key.x - key.y * key.y * key.y * key.y);
  float top = exp(-crown.x * crown.x * crown.x * crown.x - crown.y * crown.y);
  float side = exp(-dot(fill, fill));
  vec3 tone = glassTone(tint);
  return mix(vec3(0.94, 0.97, 1.0), tone, 0.32) * strip * 1.48
    + mix(vec3(0.91, 0.95, 1.0), tone, 0.22) * top * 1.10
    + mix(vec3(0.72, 0.86, 0.96), tone, 0.42) * side * 1.24;
}

vec3 illustratedSurface(vec3 photo, vec3 normal, float outline, vec3 coverTint, float contact) {
  vec3 tone = glassTone(coverTint);
  float grazing = 1.0 - clamp(normal.z, 0.0, 1.0);
  float fresnel = 0.025 + 0.975 * pow(grazing, 1.4);
  vec3 reflected = studioReflection(reflect(vec3(0.0, 0.0, -1.0), normal), coverTint);
  vec3 color = photo * (1.0 - 0.38 * pow(grazing, 0.65));
  color = mix(color, max(reflected, color * 0.48), 0.045 + fresnel * 0.40);
  color += reflected * (0.13 + fresnel * 0.20);

  float keySpot = pow(max(dot(normal, normalize(vec3(-0.50, -0.62, 0.70))), 0.0), 32.0);
  color += vec3(0.95, 0.98, 1.0) * keySpot * 0.12;
  float caustic = pow(max(dot(normal, normalize(vec3(0.52, 0.72, 0.23))), 0.0), 11.5);
  color += mix(vec3(0.80, 0.92, 1.0), tone, 0.55) * caustic * 0.34;

  // Follow the union contour to avoid a bright circular seam at the join.
  float rim = exp(-abs(outline) * 118.0);
  float directionalRim = 0.18 + 0.82 * pow(max(dot(normal.xy, normalize(vec2(-0.70, -0.72))), 0.0), 2.0);
  color += mix(vec3(0.83, 0.92, 1.0), tone, 0.26) * rim * directionalRim * 0.50;
  color += mix(vec3(0.82, 0.94, 1.0), tone, 0.35) * contact * 0.04;
  return clamp(color, 0.0, 1.0);
}

void main() {
  vec2 pixel = gl_FragCoord.xy / u_dpr;
  pixel.y = u_resolution.y - pixel.y;
  vec2 screen = (pixel - u_resolution * 0.5) / u_sceneScale;
  float fusion = u_hasFusion > 0.5 ? 1.0 : 0.0;
  // One reversible progress value controls both lobes. Easing lives in the
  // animation loop so enter/exit do not accidentally apply it twice.
  float split = clamp(u_fusionProgress, 0.0, 1.0) * fusion;
  float splitEase = split;
  vec2 targetA = vec2(-0.94, 0.19);
  vec2 targetB = vec2(0.94, -0.23);
  centerA = vec3(mix(vec2(0.0), targetA, splitEase), 0.0);
  centerB = vec3(mix(vec2(-0.02, 0.01), targetB, splitEase), 0.0);
  float divisionBulge = sin(split * 3.14159265) * 0.045;
  radius = vec2(0.983333 * (1.0 + divisionBulge), 0.983333 * pow(splitEase, 0.65));

  float outline = surface(vec3(screen, 0.0));
  float aa = 0.8 / (u_sceneScale * u_dpr);
  float alpha = 1.0 - smoothstep(-aa, aa, outline);
  vec3 tintA = mix(vec3(0.32, 0.37, 0.40), coverEnvironment(u_primary), u_primaryHasPhoto);
  vec3 tintB = fusion > 0.5 ? mix(vec3(0.32, 0.37, 0.40), coverEnvironment(u_fusion), u_fusionHasPhoto) : tintA;
  // Draw the ambient light outside the union, never through the join. Its
  // colour follows each cover rather than using a universal white glow.
  vec2 flatFields = fields(vec3(screen, 0.0));
  float haloA = exp(-max(flatFields.x, 0.0) * 8.5);
  float haloB = exp(-max(flatFields.y, 0.0) * 8.5) * split;
  float haloWeight = haloA + haloB;
  vec3 haloColor = (tintA * haloA + tintB * haloB) / max(haloWeight, 0.001);
  float photoHalo = (u_primaryHasPhoto * haloA + u_fusionHasPhoto * haloB) / max(haloWeight, 0.001);
  float haloAlpha = mix(min(0.05, haloWeight * 0.025), min(0.15, haloWeight * 0.12), photoHalo) * (1.0 - alpha);
  if (alpha < 0.001) {
    gl_FragColor = vec4(haloColor, haloAlpha);
    return;
  }

  vec3 hit = vec3(screen, 1.8);
  for (int i = 0; i < 16; i++) {
    float distance = surface(hit);
    if (distance < 0.002 || hit.z < 0.0) break;
    hit.z -= distance * 0.9;
  }
  hit.z = max(hit.z, 0.0);
  vec3 normal = normalAt(hit);
  vec2 d = fields(hit);
  float blend = fusion > 0.5 ? smoothstep(-cohesion, cohesion, d.y - d.x) : 0.0;
  vec3 primary = photograph(u_primary, hit, centerA, radius.x, normal);
  vec3 secondary = fusion > 0.5 ? photograph(u_fusion, hit, centerB, radius.y, normal) : primary;
  float weightA = (fusion > 0.5 ? blend : 1.0) * u_primaryHasPhoto;
  float weightB = (fusion > 0.5 ? 1.0 - blend : 0.0) * u_fusionHasPhoto;
  float hasPhoto = weightA + weightB;
  // Missing/failed covers contribute no illustration, including when only
  // one of the two fused topics has a cover.
  vec3 photo = (primary * weightA + secondary * weightB) / max(hasPhoto, 0.001);
  vec4 water = waterSurface(normal, outline);
  vec3 illustrated = vec3(0.0);
  if (hasPhoto > 0.001) {
    vec3 coverTint = mix(tintB, tintA, blend);
    float contact = fusion * (1.0 - smoothstep(0.0, 0.085, abs(d.x - d.y)));
    illustrated = illustratedSurface(photo, normal, outline, coverTint, contact);
  }
  // Blend the two materials with their opacity at the fusion neck. Each lobe
  // keeps its own style when only one topic has an image.
  float bodyOpacity = mix(water.a, 1.0, hasPhoto);
  vec3 color = (water.rgb * water.a * (1.0 - hasPhoto) + illustrated * hasPhoto) / max(bodyOpacity, 0.001);
  float materialAlpha = alpha * bodyOpacity;
  float outputAlpha = materialAlpha + haloAlpha;
  gl_FragColor = vec4((color * materialAlpha + haloColor * haloAlpha) / max(outputAlpha, 0.001), outputAlpha);

}
`

function compileShader(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader | null {
  const shader = gl.createShader(kind)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

// A neutral texture is present synchronously while covers load or fail.
// Missing covers render as transparent droplets until artwork is ready.
function neutralTexture(gl: WebGLRenderingContext) {
  const size = 64
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const light = Math.exp(-((x - 21) ** 2 + (y - 18) ** 2) / 1100)
    const value = 30 + light * 36
    const offset = (y * size + x) * 4
    pixels.set([value, value + 6, value + 4, 255], offset)
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
}

function createTexture(gl: WebGLRenderingContext): WebGLTexture | null {
  const texture = gl.createTexture()
  if (!texture) return null
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  neutralTexture(gl)
  return texture
}

function loadTexture(gl: WebGLRenderingContext, texture: WebGLTexture, source: string | undefined, onReady: (hasPhoto: boolean) => void): () => void {
  gl.bindTexture(gl.TEXTURE_2D, texture)
  neutralTexture(gl)
  onReady(false)
  const image = new Image()
  let cancelled = false
  image.decoding = 'async'
  image.onload = () => {
    if (cancelled) return
    gl.bindTexture(gl.TEXTURE_2D, texture)
    // sphereUv uses a top-left CSS coordinate system; keep the source image
    // orientation unchanged so covers do not appear upside down in the ball.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    onReady(Boolean(source && source !== neutralThemeArtwork))
  }
  image.onerror = () => {
    if (cancelled) return
    gl.bindTexture(gl.TEXTURE_2D, texture)
    neutralTexture(gl)
    onReady(false)
  }
  image.src = source || neutralThemeArtwork
  return () => { cancelled = true; image.onload = null; image.onerror = null }
}

export function ScriptThemeWaterCanvas({ primary, fusion, primaryArtwork, fusionArtwork, active = true, onFusionSettled }: ScriptThemeWaterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const activeRef = useRef(active)
  const invalidateRef = useRef<(() => void) | null>(null)
  useEffect(() => { activeRef.current = active; invalidateRef.current?.() }, [active])
  const settledRef = useRef(onFusionSettled)
  useEffect(() => { settledRef.current = onFusionSettled }, [onFusionSettled])
  // Retain the last fusion lobe while the shader plays its reverse merge.
  // The parent can clear the selection immediately without popping the lobe.
  const visualStateRef = useRef({
    lastFusion: fusion.trim(),
    visualFusion: fusion.trim(),
    visualArtwork: fusionArtwork,
    primaryArtwork,
    progress: fusion.trim() ? 1 : 0,
    from: fusion.trim() ? 1 : 0,
    direction: 'idle' as 'idle' | 'in' | 'out',
    startedAt: 0,
  })

  useEffect(() => {
    const state = visualStateRef.current
    const nextFusion = fusion.trim()
    const nextArtwork = fusionArtwork
    state.primaryArtwork = primaryArtwork
    if (nextFusion !== state.lastFusion) {
      if (nextFusion) {
        state.visualFusion = nextFusion
        state.visualArtwork = nextArtwork
        state.from = state.progress
        state.direction = 'in'
        state.startedAt = performance.now()
      } else if (state.visualFusion) {
        state.from = state.progress
        state.direction = 'out'
        state.startedAt = performance.now()
      }
      state.lastFusion = nextFusion
    } else if (nextFusion && nextArtwork !== state.visualArtwork) {
      state.visualArtwork = nextArtwork
    }
    invalidateRef.current?.()
  }, [fusion, fusionArtwork, primaryArtwork])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false, powerPreference: 'low-power' })
    if (!gl) { settledRef.current?.(Boolean(fusion.trim())); return }
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
    if (!vertex || !fragment) return
    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return

    const buffer = gl.createBuffer()
    const primaryTexture = createTexture(gl)
    const fusionTexture = createTexture(gl)
    if (!buffer || !primaryTexture || !fusionTexture) return
    let primaryHasPhoto = false
    let fusionHasPhoto = false
    let requestDraw = () => {}
    const primaryReady = (value: boolean) => { primaryHasPhoto = value; requestDraw() }
    const fusionReady = (value: boolean) => { fusionHasPhoto = value; requestDraw() }
    let cancelPrimaryLoad = loadTexture(gl, primaryTexture, primaryArtwork, primaryReady)
    let cancelFusionLoad = loadTexture(gl, fusionTexture, fusionArtwork, fusionReady)

    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const resolution = gl.getUniformLocation(program, 'u_resolution')
    const dprUniform = gl.getUniformLocation(program, 'u_dpr')
    const sceneScale = gl.getUniformLocation(program, 'u_sceneScale')
    const time = gl.getUniformLocation(program, 'u_time')
    const hasFusion = gl.getUniformLocation(program, 'u_hasFusion')
    const fusionProgress = gl.getUniformLocation(program, 'u_fusionProgress')
    const primarySampler = gl.getUniformLocation(program, 'u_primary')
    const fusionSampler = gl.getUniformLocation(program, 'u_fusion')
    const primaryPhotoUniform = gl.getUniformLocation(program, 'u_primaryHasPhoto')
    const fusionPhotoUniform = gl.getUniformLocation(program, 'u_fusionHasPhoto')
    let frame = 0
    let lastDraw = -Infinity
    let dirty = true
    let visible = true
    let disposed = false
    const canDraw = () => !disposed && activeRef.current && visible && !document.hidden
    const start = performance.now()
    let loadedPrimarySource = primaryArtwork
    let loadedFusionSource = fusionArtwork
    let cssWidth = 0
    let cssHeight = 0
    let sceneUnit = 100
    let devicePixelRatio = Math.min(1.5, window.devicePixelRatio || 1)
    const fusionDuration = 620
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const requestedUnit = parseFloat(window.getComputedStyle(canvas).getPropertyValue('--water-unit')) || 100
      cssWidth = Math.max(1, rect.width)
      cssHeight = Math.max(1, rect.height)
      // Fit both lobes, including their strongest sway and soft halo. Keep
      // this scale stable when adding/removing fusion, and share it with the
      // DOM controls so their positions follow the actual rendered water.
      sceneUnit = Math.max(0.1, Math.min(requestedUnit, (cssWidth - 16) / 4.4, (cssHeight - 16) / 2.9))
      canvas.parentElement?.style.setProperty('--water-render-unit', `${sceneUnit}px`)
      devicePixelRatio = Math.min(1.5, window.devicePixelRatio || 1)
      const width = Math.max(1, Math.round(cssWidth * devicePixelRatio))
      const height = Math.max(1, Math.round(cssHeight * devicePixelRatio))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        gl.viewport(0, 0, width, height)
      }
      requestDraw()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    const render = (now: number) => {
      frame = 0
      if (!canDraw()) return
      // Render changes immediately, but cap the ongoing liquid motion at 24fps.
      if (!dirty && now - lastDraw < 1000 / 24) {
        frame = window.requestAnimationFrame(render)
        return
      }
      lastDraw = now
      dirty = false
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(program)
      gl.disable(gl.BLEND)
      // Full-screen pass writes straight alpha; blending here would apply
      // the transparent halo alpha twice before browser compositing.
      gl.uniform2f(resolution, cssWidth, cssHeight)
      gl.uniform1f(dprUniform, devicePixelRatio)
      gl.uniform1f(sceneScale, sceneUnit)
      gl.uniform1f(time, reducedMotion.matches ? 0 : (now - start) / 1000)
      const state = visualStateRef.current
      if (state.direction !== 'idle') {
        const elapsed = reducedMotion.matches ? 1 : Math.min(1, (now - state.startedAt) / fusionDuration)
        const eased = 1 - Math.pow(1 - elapsed, 3)
        state.progress = state.direction === 'in'
          ? state.from + (1 - state.from) * eased
          : state.from * (1 - eased)
        if (elapsed >= 1) {
          if (state.direction === 'out') {
            state.progress = 0
            state.visualFusion = ''
            state.visualArtwork = undefined
          } else {
            state.progress = 1
          }
          state.direction = 'idle'
          settledRef.current?.(Boolean(state.visualFusion))
        }
      }
      // Artwork can change while this component stays mounted. Keep the
      // previous fusion texture available until the reverse transition ends.
      if (state.primaryArtwork !== loadedPrimarySource) {
        loadedPrimarySource = state.primaryArtwork
        cancelPrimaryLoad()
        cancelPrimaryLoad = loadTexture(gl, primaryTexture, state.primaryArtwork, primaryReady)
      }
      if (state.visualFusion && state.visualArtwork !== loadedFusionSource) {
        loadedFusionSource = state.visualArtwork
        cancelFusionLoad()
        cancelFusionLoad = loadTexture(gl, fusionTexture, state.visualArtwork, fusionReady)
      }
      const hasFusionValue = state.visualFusion ? 1 : 0
      gl.uniform1f(hasFusion, hasFusionValue)
      gl.uniform1f(fusionProgress, state.progress)
      gl.uniform1f(primaryPhotoUniform, primaryHasPhoto ? 1 : 0)
      gl.uniform1f(fusionPhotoUniform, fusionHasPhoto ? 1 : 0)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, primaryTexture)
      gl.uniform1i(primarySampler, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, fusionTexture)
      gl.uniform1i(fusionSampler, 1)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      if (!reducedMotion.matches && !frame) frame = window.requestAnimationFrame(render)
    }
    requestDraw = () => {
      dirty = true
      if (!canDraw()) { window.cancelAnimationFrame(frame); frame = 0; return }
      if (!frame) frame = window.requestAnimationFrame(render)
    }
    invalidateRef.current = requestDraw
    const visibility = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      visible = !!entries[0]?.isIntersecting
      requestDraw()
    })
    visibility?.observe(canvas)
    document.addEventListener('visibilitychange', requestDraw)
    reducedMotion.addEventListener('change', requestDraw)
    requestDraw()
    return () => {
      disposed = true
      invalidateRef.current = null
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      visibility?.disconnect()
      document.removeEventListener('visibilitychange', requestDraw)
      reducedMotion.removeEventListener('change', requestDraw)
      cancelPrimaryLoad()
      cancelFusionLoad()
      gl.deleteTexture(primaryTexture)
      gl.deleteTexture(fusionTexture)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
    }
  }, [])

  return <>
    <div className="script-director-theme-orb-wrap is-primary" aria-label={`主题材：${primary || '自定义题材'}`} role="img">
      <span className="script-director-theme-circle tone-neutral" aria-hidden="true" />
    </div>
    <canvas
      ref={canvasRef}
      className="script-director-theme-water-canvas"
      data-ready="true"
      aria-label={`题材关系：${primary || '自定义题材'}${fusion ? `与${fusion}融合` : ''}`}
      role="img"
    />
  </>
}
