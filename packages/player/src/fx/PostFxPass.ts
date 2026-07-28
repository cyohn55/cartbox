/**
 * Single-pass WebGL1 post-process renderer shared by the editor's FX tab and
 * the runtime player. Takes one frame — either raw RGBA bytes at native cart
 * resolution or a source canvas — as a nearest-filtered texture and draws it
 * through one fragment shader implementing the whole effect chain; per-effect
 * intensity arrives as uniforms (neutral when disabled), so the pipeline
 * compiles once. WebGL1 is used (not WebGPU) because this is a one-texture
 * full-screen quad — maximum compatibility, no async device setup.
 *
 * Effect order mirrors a physical signal path. The frame is folded and bowed
 * first (kaleidoscope, then CRT curvature), sampled through chromatic
 * aberration, and lit (bloom, god rays, streaks). The composed colour is then
 * graded and split-toned, quantised (dither feeding posterize), screened
 * (halftone), and finally passed through the things that sit in front of the
 * picture rather than in it: fog, vignette, grain, scanlines.
 *
 * Everything stays in one pass. That constraint is why the effects here are the
 * ones they are — a separable blur or a depth-aware effect would need a second
 * render target, and the whole point of the flat-uniform design is that there is
 * exactly one program, compiled once, whatever the artist switches on.
 */

import type { PostFxUniforms } from "./postfx.js";

/** A frame to post-process: raw RGBA bytes or a canvas to sample. */
export type PostFxSource = Uint8Array | Uint8ClampedArray | TexImageSource;

const VERTEX_SOURCE = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  // Screen-space UV with a top-left origin, so uv.y matches image row order.
  vUv = vec2((aPosition.x + 1.0) * 0.5, (1.0 - aPosition.y) * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SOURCE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uSourceSize;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uFogDensity;
uniform float uFogHorizon;
uniform vec3 uFogColor;
uniform float uBloomStrength;
uniform float uBloomThreshold;
uniform float uCurvature;
uniform float uScanlines;
uniform float uAberration;
uniform float uVignette;
uniform float uPosterize;
uniform float uDitherAmount;
uniform float uDitherScale;
uniform float uHalftoneStrength;
uniform float uHalftoneScale;
uniform float uHalftoneAngle;
uniform float uGodrayStrength;
uniform float uGodrayDensity;
uniform float uGodrayDecay;
uniform vec2 uGodrayOrigin;
uniform float uStreakStrength;
uniform float uStreakLength;
uniform float uSplitStrength;
uniform float uSplitBalance;
uniform vec3 uSplitShadows;
uniform vec3 uSplitHighlights;
uniform float uKaleidoSegments;
uniform float uKaleidoAngle;
uniform float uGrainAmount;
uniform float uGrainSize;
uniform float uTime;

const float TAU = 6.2831853;
// Fixed sample counts: GLSL ES 1.00 requires constant loop bounds, so the cost
// is decided at compile time and the effects are switched off by branching
// around the loop rather than by shortening it.
const int GODRAY_SAMPLES = 16;
const int STREAK_SAMPLES = 8;

float luma(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

vec3 brightPass(vec2 uv) {
  vec3 color = texture2D(uSource, uv).rgb;
  return color * smoothstep(uBloomThreshold, 1.0, luma(color));
}

/**
 * The 2x2 Bayer threshold, and the recursive construction of the 4x4 and 8x8
 * from it. Built arithmetically rather than from a lookup table because GLSL ES
 * 1.00 forbids indexing a local array with a computed index.
 */
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}

float bayer4(vec2 a) {
  return bayer2(a * 0.5) * 0.25 + bayer2(a);
}

float bayer8(vec2 a) {
  // Each level halves the coordinate before recursing: an 8x8 matrix is a 4x4
  // of 2x2 blocks, so the coarser level must be sampled at half the frequency.
  return bayer4(a * 0.5) * 0.25 + bayer2(a);
}

/** A deterministic 0..1 hash of a 2D point — the grain's noise source. */
float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 folded = vUv;

  // Kaleidoscope: fold the frame into one wedge and mirror it around. Done
  // before curvature so the tube still bows the composed image, not each wedge.
  if (uKaleidoSegments >= 2.0) {
    vec2 offset = folded - 0.5;
    float radius = length(offset);
    float segment = TAU / uKaleidoSegments;
    float angle = mod(atan(offset.y, offset.x) + uKaleidoAngle, segment);
    // Reflecting about the wedge's midline is what makes neighbouring wedges
    // mirror rather than repeat, which is the difference between a kaleidoscope
    // and a pinwheel.
    angle = abs(angle - segment * 0.5);
    // A wedge reaches past the frame at the corners, where the radius exceeds a
    // half-width. Clamping samples the edge there; letting it fall through would
    // hit the out-of-frame test below and punch four black corners.
    folded = clamp(vec2(cos(angle), sin(angle)) * radius + 0.5, 0.0, 1.0);
  }

  // CRT barrel curvature: bow the sampling grid outward from the centre.
  vec2 centered = folded - 0.5;
  vec2 uv = folded + centered * dot(centered, centered) * uCurvature * 4.0;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Chromatic aberration: R and B sampled slightly toward/away from centre.
  vec2 fringe = centered * uAberration / uSourceSize;
  vec3 color = vec3(
    texture2D(uSource, uv + fringe).r,
    texture2D(uSource, uv).g,
    texture2D(uSource, uv - fringe).b
  );

  // Bloom: 3x3 bright-pass blur added on top (cheap at cart resolution).
  if (uBloomStrength > 0.0) {
    vec2 texel = 1.0 / uSourceSize;
    vec3 glow = vec3(0.0);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        float weight = (dx == 0 && dy == 0) ? 0.25 : (dx == 0 || dy == 0) ? 0.125 : 0.0625;
        glow += brightPass(uv + vec2(float(dx), float(dy)) * texel) * weight;
      }
    }
    color += glow * uBloomStrength;
  }

  // God rays: march back toward the light, accumulating the bright pass with a
  // geometric falloff. A 2D scene has no depth to occlude with, so what forms
  // the shafts is the artwork's own dark pixels contributing nothing.
  if (uGodrayStrength > 0.0) {
    // Named around the builtins: "step" is a GLSL function and "sample" is a
    // reserved word, and shadowing either is a trap.
    vec2 marchStep = (uv - uGodrayOrigin) * uGodrayDensity / float(GODRAY_SAMPLES);
    vec2 probe = uv;
    float decay = 1.0;
    vec3 shafts = vec3(0.0);
    for (int i = 0; i < GODRAY_SAMPLES; i++) {
      probe -= marchStep;
      shafts += brightPass(clamp(probe, 0.0, 1.0)) * decay;
      decay *= uGodrayDecay;
    }
    color += shafts * (uGodrayStrength / float(GODRAY_SAMPLES));
  }

  // Anamorphic streaks: the same bright pass smeared horizontally only, which is
  // what a cylindrical lens does and what reads as "cinematic" on a light source.
  if (uStreakStrength > 0.0) {
    float reach = uStreakLength * 0.25;
    vec3 streak = vec3(0.0);
    float total = 0.0;
    for (int i = 1; i <= STREAK_SAMPLES; i++) {
      float distance = float(i) / float(STREAK_SAMPLES);
      float weight = 1.0 - distance;
      vec2 offset = vec2(reach * distance, 0.0);
      streak += (brightPass(clamp(uv + offset, 0.0, 1.0)) + brightPass(clamp(uv - offset, 0.0, 1.0))) * weight;
      total += weight * 2.0;
    }
    color += streak * (uStreakStrength / max(total, 1.0));
  }

  // Grade: brightness, then contrast around mid-grey, then saturation.
  color *= uBrightness;
  color = (color - 0.5) * uContrast + 0.5;
  color = mix(vec3(luma(color)), color, uSaturation);

  // Split tone: pick a tint by brightness and multiply it in. The tints are
  // doubled so a mid-grey pick is the identity, which lets "no tint" be
  // expressible rather than only approachable.
  if (uSplitStrength > 0.0) {
    float tone = smoothstep(uSplitBalance - 0.25, uSplitBalance + 0.25, luma(color));
    vec3 tint = mix(uSplitShadows, uSplitHighlights, tone) * 2.0;
    color = mix(color, color * tint, uSplitStrength);
  }

  // Ordered dither: offset each channel by up to half a posterisation step
  // before quantising, so pixels straddling a boundary alternate and read as the
  // colour between the two available ones. Applied to the *source* pixel grid so
  // the pattern stays put when the FX canvas renders above native resolution.
  if (uDitherAmount > 0.0 && uPosterize >= 2.0) {
    vec2 cell = floor(uv * uSourceSize / max(uDitherScale, 1.0));
    color += (bayer8(cell) - 0.5) * (uDitherAmount / uPosterize);
  }

  // Posterize: quantise each channel to uPosterize levels (0 = off).
  if (uPosterize >= 2.0) {
    color = floor(color * uPosterize) / (uPosterize - 1.0);
    color = min(color, vec3(1.0));
  }

  // Halftone: a rotated grid of dots whose radius tracks brightness. The square
  // root is deliberate — ink coverage goes as the dot's *area*, so a linear
  // radius would darken the midtones.
  if (uHalftoneStrength > 0.0) {
    vec2 grid = uv * uSourceSize / max(uHalftoneScale, 1.0);
    float sinA = sin(uHalftoneAngle);
    float cosA = cos(uHalftoneAngle);
    vec2 rotated = vec2(grid.x * cosA - grid.y * sinA, grid.x * sinA + grid.y * cosA);
    float radius = sqrt(clamp(luma(color), 0.0, 1.0)) * 0.7;
    float ink = step(length(fract(rotated) - 0.5), radius);
    color = mix(color, color * mix(0.15, 1.0, ink), uHalftoneStrength);
  }

  // Fog: thickens from the horizon line upward (distance in a 2D scene).
  // smoothstep needs edge0 < edge1, so invert the ramp instead of the edges.
  float fogAmount = uFogDensity * (1.0 - smoothstep(uFogHorizon - 0.35, uFogHorizon + 0.35, uv.y));
  color = mix(color, uFogColor, clamp(fogAmount, 0.0, 1.0));

  // Vignette: radial darkening toward the corners.
  float falloff = 1.0 - uVignette * smoothstep(0.25, 0.75, dot(centered, centered) * 2.0);
  color *= falloff;

  // Film grain: noise keyed to the source pixel grid and the clock, so it
  // shimmers between frames rather than sitting still as a fixed dirt pattern.
  if (uGrainAmount > 0.0) {
    vec2 grainCell = floor(uv * uSourceSize / max(uGrainSize, 1.0));
    color += (hash12(grainCell + fract(uTime) * 71.0) - 0.5) * uGrainAmount;
  }

  // Scanlines: darken alternate source rows (identity when strength is 0).
  float scan = 1.0 - uScanlines * 0.25 * (1.0 + sin(uv.y * uSourceSize.y * 3.14159));
  color *= scan;

  gl_FragColor = vec4(color, 1.0);
}
`;

export class PostFxPass {
  private readonly uniformLocations = new Map<string, WebGLUniformLocation | null>();

  private constructor(
    private readonly gl: WebGLRenderingContext,
    private readonly program: WebGLProgram,
    private readonly texture: WebGLTexture,
  ) {}

  /** Returns null when WebGL is unavailable or the shaders fail to compile. */
  static create(canvas: HTMLCanvasElement): PostFxPass | null {
    const gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) return null;

    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("PostFx shader compile failed:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("PostFx program link failed:", gl.getProgramInfoLog(program));
      return null;
    }
    gl.useProgram(program);

    // Fullscreen quad as a two-triangle strip.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return new PostFxPass(gl, program, texture);
  }

  private location(name: string): WebGLUniformLocation | null {
    if (!this.uniformLocations.has(name)) {
      this.uniformLocations.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniformLocations.get(name) ?? null;
  }

  /**
   * Upload one frame and draw it through the effect chain.
   *
   * `time` (seconds) drives the only effect that moves, the grain. It is a
   * parameter rather than a clock read inside the pass so a still preview — the
   * editor's FX tab, a test — renders deterministically, and only a caller that
   * actually has a running frame loop supplies one.
   */
  render(source: PostFxSource, width: number, height: number, uniforms: PostFxUniforms, time = 0): void {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (source instanceof Uint8Array || source instanceof Uint8ClampedArray) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
      );
    } else {
      // Canvas/image sources upload GPU-side (no CPU readback of the frame).
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    gl.uniform1i(this.location("uSource"), 0);
    gl.uniform2f(this.location("uSourceSize"), width, height);
    gl.uniform1f(this.location("uBrightness"), uniforms.brightness);
    gl.uniform1f(this.location("uContrast"), uniforms.contrast);
    gl.uniform1f(this.location("uSaturation"), uniforms.saturation);
    gl.uniform1f(this.location("uFogDensity"), uniforms.fogDensity);
    gl.uniform1f(this.location("uFogHorizon"), uniforms.fogHorizon);
    gl.uniform3f(this.location("uFogColor"), ...uniforms.fogColor);
    gl.uniform1f(this.location("uBloomStrength"), uniforms.bloomStrength);
    gl.uniform1f(this.location("uBloomThreshold"), uniforms.bloomThreshold);
    gl.uniform1f(this.location("uCurvature"), uniforms.curvature);
    gl.uniform1f(this.location("uScanlines"), uniforms.scanlines);
    gl.uniform1f(this.location("uAberration"), uniforms.aberration);
    gl.uniform1f(this.location("uVignette"), uniforms.vignette);
    gl.uniform1f(this.location("uPosterize"), uniforms.posterize);
    gl.uniform1f(this.location("uDitherAmount"), uniforms.ditherAmount);
    gl.uniform1f(this.location("uDitherScale"), uniforms.ditherScale);
    gl.uniform1f(this.location("uHalftoneStrength"), uniforms.halftoneStrength);
    gl.uniform1f(this.location("uHalftoneScale"), uniforms.halftoneScale);
    gl.uniform1f(this.location("uHalftoneAngle"), uniforms.halftoneAngle);
    gl.uniform1f(this.location("uGodrayStrength"), uniforms.godrayStrength);
    gl.uniform1f(this.location("uGodrayDensity"), uniforms.godrayDensity);
    gl.uniform1f(this.location("uGodrayDecay"), uniforms.godrayDecay);
    gl.uniform2f(this.location("uGodrayOrigin"), ...uniforms.godrayOrigin);
    gl.uniform1f(this.location("uStreakStrength"), uniforms.streakStrength);
    gl.uniform1f(this.location("uStreakLength"), uniforms.streakLength);
    gl.uniform1f(this.location("uSplitStrength"), uniforms.splitStrength);
    gl.uniform1f(this.location("uSplitBalance"), uniforms.splitBalance);
    gl.uniform3f(this.location("uSplitShadows"), ...uniforms.splitShadows);
    gl.uniform3f(this.location("uSplitHighlights"), ...uniforms.splitHighlights);
    gl.uniform1f(this.location("uKaleidoSegments"), uniforms.kaleidoSegments);
    gl.uniform1f(this.location("uKaleidoAngle"), uniforms.kaleidoAngle);
    gl.uniform1f(this.location("uGrainAmount"), uniforms.grainAmount);
    gl.uniform1f(this.location("uGrainSize"), uniforms.grainSize);
    gl.uniform1f(this.location("uTime"), time);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
  }
}
