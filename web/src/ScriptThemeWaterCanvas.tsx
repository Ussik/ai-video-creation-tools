import { useEffect, useRef } from 'react'

type ScriptThemeWaterCanvasProps = {
  primary: string
  fusion: string
  primaryArtwork?: string
  fusionArtwork?: string
  onFusionSettled?: (hasFusion: boolean) => void
}

const vertexSource = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

// mature project uses a WebGL SDF surface rather than two CSS circles. Keep the same
// stages locally: droplet fields, smooth union, a short raymarch for normals,
// lens mapping for the cover, and three restrained studio reflections.
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
  // Run the oval sway a little faster so the lobe feels alive without
  // increasing the silhouette distortion or introducing noisy edge ripples.
  float phase = u_time * 0.92;
  // Rotate the long axis in short, seeded direction segments. Each segment
  // chooses CCW or CW independently, while the angle returns through neutral
  // at the boundary so the water never snaps to a new pose.
  // Direction changes remain eased through neutral; shortening the segment
  // makes the requested motion quicker while avoiding a snap during fusion.
  float turnLength = 2.8;
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
  // A slightly stronger oval pulse keeps the silhouette visibly elliptical
  // while remaining smooth enough to read as a gentle liquid sway.
  // The live range is approximately 4.5% to 5.7% (previously 3.5% to 4.5%).
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
  // movement instead of noisy blur.  The larger amplitude is deliberately
  // applied to the signed distance field, which also moves the highlight.
  float ripple = 0.0012 * rippleMask * (
    sin(p.x * 7.0 + u_time * 0.36) * cos(p.y * 5.8 - u_time * 0.30)
    + 0.28 * sin((p.x + p.y) * 11.0 - u_time * 0.22)
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
  float dome = mix(1.0, 1.0 / max(sqrt(max(1.0 - radial * radial, 0.001)), 0.2), 0.019 * 1.15);
  // the mature project's default lens amount is about .02, so its zoom stays near .50.
  // Using .36 here cropped the artwork into a soft, cloudy close-up.
  vec2 mapped = clamp(local * 0.50 * dome - normal.xy * 0.15 + 0.5, 0.005, 0.995);
  vec2 wave = vec2(
    sin(local.y * 5.8 + u_time * 0.52) * 0.006,
    cos(local.x * 5.2 - u_time * 0.43) * 0.0055
  ) * (1.0 - smoothstep(0.62, 1.08, radial));
  mapped = clamp(mapped + wave, 0.005, 0.995);
  vec3 sharp = texture2D(photo, mapped).rgb;
  float rim = smoothstep(0.78, 1.0, radial);
  vec2 tap = vec2(0.0035);
  vec3 edge = texture2D(photo, mapped).rgb * 0.55;
  edge += texture2D(photo, clamp(mapped + tap, 0.005, 0.995)).rgb * 0.1125;
  edge += texture2D(photo, clamp(mapped - tap, 0.005, 0.995)).rgb * 0.1125;
  edge += texture2D(photo, clamp(mapped + vec2(tap.x, -tap.y), 0.005, 0.995)).rgb * 0.1125;
  edge += texture2D(photo, clamp(mapped + vec2(-tap.x, tap.y), 0.005, 0.995)).rgb * 0.1125;
  return mix(sharp, edge, rim * 0.22);
}

// Reflections should read as the clear neutral shell, while the artwork
// beneath remains fully saturated. Keep only a trace of the cover's hue in
// the lighting so a blue cover cannot turn the whole droplet cyan.
vec3 glassTone(vec3 coverTint) {
  float luma = max(dot(coverTint, vec3(0.30, 0.59, 0.11)), 0.08);
  vec3 normalized = clamp(coverTint / luma, vec3(0.45), vec3(1.75));
  return mix(vec3(1.0), normalized, 0.08);
}

vec3 studioReflection(vec3 direction, vec3 coverTint) {
  float c = cos(-0.15);
  float s = sin(-0.15);
  vec2 xy = vec2(direction.x * c - direction.y * s, direction.x * s + direction.y * c);
  vec3 ray = vec3(xy.x, -xy.y, direction.z);
  vec2 strip = (ray.xy - vec2(-0.52, 0.18)) / vec2(0.22, 1.64);
  float key = exp(-dot(strip, strip));
  vec2 top = (ray.xy - vec2(0.12, 0.78)) / vec2(1.10, 0.28);
  float fill = exp(-dot(top, top));
  vec2 side = (ray.xy - vec2(0.69, -0.52)) / vec2(0.40, 0.60);
  float rim = exp(-dot(side, side));
  vec3 tone = glassTone(coverTint);
  // mature project keeps the studio light nearly neutral; the cover supplies the
  // environment tint. Avoid a cyan wash that makes the whole droplet blue.
  return mix(vec3(0.94, 0.94, 0.92), tone, 0.28) * key * 0.34
    + mix(vec3(0.86, 0.87, 0.85), tone, 0.24) * fill * 0.13
    + mix(vec3(0.68, 0.70, 0.69), tone, 0.38) * rim * 0.54;
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
  if (alpha < 0.001) { gl_FragColor = vec4(0.0); return; }

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
  vec3 photo = mix(secondary, primary, blend);
  vec3 primaryTint = texture2D(u_primary, vec2(0.5)).rgb;
  vec3 coverTint = fusion > 0.5
    ? mix(texture2D(u_fusion, vec2(0.5)).rgb, primaryTint, blend)
    : primaryTint;
  float radialA = length((hit.xy - centerA.xy) / max(radius.x, 0.001));
  float radialB = length((hit.xy - centerB.xy) / max(radius.y, 0.001));
  float sphereRadius = fusion > 0.5 ? mix(radialB, radialA, blend) : radialA;
  float edgeInside = 1.0 - smoothstep(0.0, 0.32, clamp(1.0 - sphereRadius, 0.0, 1.0));
  float fresnel = 0.025 + 0.975 * pow(1.0 - clamp(normal.z, 0.0, 1.0), 1.0);
  vec3 reflected = studioReflection(reflect(vec3(0.0, 0.0, -1.0), normal), coverTint);
  vec3 reflectionTone = glassTone(coverTint);
  float grazing = pow(1.0 - clamp(normal.z, 0.0, 1.0), 1.15);
  vec3 base = pow(max(photo, vec3(0.0)), vec3(1.08));
  base *= mix(1.0, 0.74, grazing);
  vec3 color = base * (0.92 + 0.08 * normal.z);
  color *= mix(1.0, 0.82, edgeInside * 0.55);
  // The source covers can contain symbols near their crop edge. At the
  // fusion neck those pixels should sit behind the liquid thickness instead
  // of becoming a visible circular mark, so mute the artwork locally while
  // retaining a narrow reflective transition.
  float neckMask = fusion * (1.0 - smoothstep(0.0, 0.14, abs(d.x - d.y)));
  vec3 neckGlass = mix(color * 0.46, reflectionTone * 0.56, 0.28);
  color = mix(color, neckGlass, neckMask * 0.42);
  // Keep the cover legible through the shell. Reflections are deliberately
  // split into a low-opacity body reflection and a much brighter edge pass;
  // putting all of the energy in reflected makes the ball look fogged over.
  color = mix(color, max(reflected, color * 0.72), clamp(0.045 + 0.070 * fresnel, 0.0, 0.34));
  color += reflected * (0.020 + fresnel * 0.038);
  // A curved key reflection follows the sphere normal. This is the bright
  // upper-left arc visible on mature project, rather than a flat white ellipse.
  float arcDot = max(dot(normal, normalize(vec3(-0.50, -0.62, 0.70))), 0.0);
  float arc = pow(arcDot, 12.0);
  float arcSoft = pow(arcDot, 4.5);
  float arcTight = pow(arcDot, 28.0);
  // Keep the broad upper-left key restrained so it does not erase the cover
  // detail inside the ball; the narrow grazing rim below carries the shine.
  color += mix(vec3(0.92, 0.93, 0.92), reflectionTone, 0.16) * arc * 0.16;
  color += mix(vec3(0.80, 0.82, 0.81), reflectionTone, 0.24) * arcSoft * 0.045;
  color += vec3(0.98, 0.98, 0.95) * arcTight * 0.22;
  // Keep the brighter reflection confined to the grazing-angle rim. This
  // strengthens the glass edge without washing a white veil over the cover.
  float edgeFresnel = pow(1.0 - clamp(normal.z, 0.0, 1.0), 2.45);
  vec3 shellLight = mix(vec3(0.68, 0.71, 0.70), reflectionTone, 0.14);
  color += shellLight * edgeFresnel * 0.72;
  // A tighter pass gives the contour the fine, wet-looking line visible in
  // the reference instead of a broad gray halo.
  float edgeSpark = pow(1.0 - clamp(normal.z, 0.0, 1.0), 6.6);
  color += mix(vec3(0.90, 0.92, 0.91), reflectionTone, 0.10) * edgeSpark * 0.52;
  // A restrained cool environmental glint appears only on the grazing side.
  // This gives the right lobe the blue glass reflection seen in the reference
  // while keeping the cover and the upper highlight neutral.
  float sideGlint = pow(max(dot(normal, normalize(vec3(0.72, 0.18, 0.68))), 0.0), 7.0);
  color += mix(vec3(0.48, 0.69, 0.78), reflectionTone, 0.30) * sideGlint * 0.16;
  // Let the bright rim bleed into the artwork by a short radial distance. A
  // normal-only Fresnel term makes the whole edge uniformly hazy; this local
  // radius fade creates the visible glass wall in the reference and naturally
  // blends across the neck when two droplets are fused.
  // The WebGL union already supplies the glass neck.  Do not stack the
  // lobe's inward rim on the overlap region, otherwise the two inner rims
  // close into the isolated halo visible at the centre of the pair.
  float neckRimFade = 1.0 - neckMask * 0.66;
  float innerSpread = edgeInside * (0.30 + 0.70 * edgeFresnel) * neckRimFade;
  color += mix(vec3(0.40, 0.43, 0.42), reflectionTone, 0.14) * innerSpread * 0.17;
  color += vec3(0.56, 0.57, 0.55) * pow(edgeInside, 1.9) * 0.075 * neckRimFade;
  float innerRim = pow(max(dot(normal, normalize(vec3(-0.48, -0.56, 0.68))), 0.0), 5.0);
  color += mix(vec3(0.86, 0.87, 0.84), reflectionTone, 0.13) * innerRim * 0.42 * neckRimFade;
  // Keep the fusion neck as a soft material transition. A bright contact ring
  // makes the seam look like a floating halo, which is not present in the
  // reference glass blob.
  float contact = fusion * (1.0 - smoothstep(0.0, 0.075, abs(d.x - d.y)));
  color += mix(vec3(0.84, 0.84, 0.81), reflectionTone, 0.30) * contact * 0.045;
  float edge = exp(-abs(outline) * 340.0 / 1.72);
  color += mix(vec3(0.70, 0.72, 0.70), reflectionTone, 0.14) * edge * 0.44;
  color = color / (1.0 + color * 0.24);
  gl_FragColor = vec4(color, alpha * 0.98);
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

function createTexture(gl: WebGLRenderingContext): WebGLTexture | null {
  const texture = gl.createTexture()
  if (!texture) return null
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([72, 102, 120, 255]))
  return texture
}

function loadTexture(gl: WebGLRenderingContext, texture: WebGLTexture, source: string | undefined): () => void {
  if (!source) {
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([72, 102, 120, 255]))
    return () => {}
  }
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
  }
  image.src = source
  return () => { cancelled = true; image.onload = null }
}

export function ScriptThemeWaterCanvas({ primary, fusion, primaryArtwork, fusionArtwork, onFusionSettled }: ScriptThemeWaterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const settledRef = useRef(onFusionSettled)
  useEffect(() => { settledRef.current = onFusionSettled }, [onFusionSettled])
  // Retain the last fusion lobe while the shader plays its reverse merge.
  // The parent can clear the selection immediately without popping the lobe.
  const visualStateRef = useRef({
    lastFusion: fusion.trim(),
    visualFusion: fusion.trim(),
    visualArtwork: fusionArtwork || primaryArtwork,
    primaryArtwork,
    progress: fusion.trim() ? 1 : 0,
    from: fusion.trim() ? 1 : 0,
    direction: 'idle' as 'idle' | 'in' | 'out',
    startedAt: 0,
  })

  useEffect(() => {
    const state = visualStateRef.current
    const nextFusion = fusion.trim()
    const nextArtwork = fusionArtwork || primaryArtwork
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
    } else if (nextFusion && nextArtwork && nextArtwork !== state.visualArtwork) {
      state.visualArtwork = nextArtwork
    }
  }, [fusion, fusionArtwork, primaryArtwork])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false })
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
    let cancelPrimaryLoad = loadTexture(gl, primaryTexture, primaryArtwork)
    let cancelFusionLoad = loadTexture(gl, fusionTexture, fusionArtwork || primaryArtwork)

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
    let frame = 0
    const start = performance.now()
    let loadedPrimarySource = primaryArtwork
    let loadedFusionSource = fusionArtwork || primaryArtwork
    let cssWidth = 0
    let cssHeight = 0
    let sceneUnit = 100
    let devicePixelRatio = Math.min(2, window.devicePixelRatio || 1)
    const fusionDuration = 620
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      sceneUnit = parseFloat(window.getComputedStyle(canvas).getPropertyValue('--water-unit')) || 100
      cssWidth = Math.max(1, rect.width)
      cssHeight = Math.max(1, rect.height)
      devicePixelRatio = Math.min(2, window.devicePixelRatio || 1)
      const width = Math.max(1, Math.round(cssWidth * devicePixelRatio))
      const height = Math.max(1, Math.round(cssHeight * devicePixelRatio))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        gl.viewport(0, 0, width, height)
      }
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    const render = (now: number) => {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(program)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
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
        cancelPrimaryLoad = loadTexture(gl, primaryTexture, state.primaryArtwork)
      }
      if (state.visualArtwork && state.visualArtwork !== loadedFusionSource) {
        loadedFusionSource = state.visualArtwork
        cancelFusionLoad()
        cancelFusionLoad = loadTexture(gl, fusionTexture, state.visualArtwork)
      }
      const hasFusionValue = state.visualFusion ? 1 : 0
      gl.uniform1f(hasFusion, hasFusionValue)
      gl.uniform1f(fusionProgress, state.progress)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, primaryTexture)
      gl.uniform1i(primarySampler, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, fusionTexture)
      gl.uniform1i(fusionSampler, 1)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      frame = window.requestAnimationFrame(render)
    }
    frame = window.requestAnimationFrame(render)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
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
