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

vec3 glassTone(vec3 tint) {
  float luma = max(dot(tint, vec3(0.30, 0.59, 0.11)), 0.08);
  return clamp(tint / luma, vec3(0.45), vec3(1.65));
}

vec3 studioReflection(vec3 direction, vec3 tint) {
  // Three softboxes reflected in the curved surface, with a dark interval
  // between the crown light and the diagonal lower-right fill.
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
  vec3 tintA = coverEnvironment(u_primary);
  vec3 tintB = fusion > 0.5 ? coverEnvironment(u_fusion) : tintA;
  // Draw the ambient light outside the union, never through the join. Its
  // colour follows each cover rather than using a universal white glow.
  vec2 flatFields = fields(vec3(screen, 0.0));
  float haloA = exp(-max(flatFields.x, 0.0) * 8.5);
  float haloB = exp(-max(flatFields.y, 0.0) * 8.5) * split;
  float haloWeight = haloA + haloB;
  vec3 haloColor = (tintA * haloA + tintB * haloB) / max(haloWeight, 0.001);
  float haloAlpha = min(0.15, haloWeight * 0.12) * (1.0 - alpha);
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
  vec3 photo = mix(secondary, primary, blend);
  vec3 coverTint = mix(tintB, tintA, blend);
  vec3 tone = glassTone(coverTint);
  float facing = clamp(normal.z, 0.0, 1.0);
  float grazing = 1.0 - facing;
  float fresnel = 0.025 + 0.975 * pow(grazing, 1.4);
  vec3 reflected = studioReflection(reflect(vec3(0.0, 0.0, -1.0), normal), coverTint);

  // Preserve the photograph's contrast. The shell gets darker at oblique
  // angles, with reflected softboxes replacing that light selectively.
  vec3 color = photo * (1.0 - 0.38 * pow(grazing, 0.65));
  color = mix(color, max(reflected, color * 0.48), 0.045 + fresnel * 0.40);
  color += reflected * (0.13 + fresnel * 0.20);

  float keySpot = pow(max(dot(normal, normalize(vec3(-0.50, -0.62, 0.70))), 0.0), 32.0);
  color += vec3(0.95, 0.98, 1.0) * keySpot * 0.12;
  float caustic = pow(max(dot(normal, normalize(vec3(0.52, 0.72, 0.23))), 0.0), 11.5);
  color += mix(vec3(0.80, 0.92, 1.0), tone, 0.55) * caustic * 0.34;

  // Use the union's contour, so the two inward rims cannot form a bright
  // circular seam at the fusion neck.
  float rim = exp(-abs(outline) * 118.0);
  float directionalRim = 0.18 + 0.82 * pow(max(dot(normal.xy, normalize(vec2(-0.70, -0.72))), 0.0), 2.0);
  color += mix(vec3(0.83, 0.92, 1.0), tone, 0.26) * rim * directionalRim * 0.50;
  float contact = fusion * (1.0 - smoothstep(0.0, 0.085, abs(d.x - d.y)));
  color += mix(vec3(0.82, 0.94, 1.0), tone, 0.35) * contact * 0.04;
  color = clamp(color, 0.0, 1.0);
  float outputAlpha = alpha + haloAlpha;
  gl_FragColor = vec4((color * alpha + haloColor * haloAlpha) / max(outputAlpha, 0.001), outputAlpha);

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
