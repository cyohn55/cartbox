/**
 * A true multi-pass bloom: the wide, soft, energy-preserving glow the old
 * single-pass 3x3 tap could not produce (cinematic gap #4). The frame's bright
 * pixels are extracted through a soft knee, then blurred across a pyramid of
 * successively halved render targets using the dual-Kawase filter — a downsample
 * chain followed by an additive upsample chain — so light spreads across many
 * scales in a handful of cheap passes rather than one fixed-width kernel.
 *
 * The targets are half-float when the GPU can render and linearly filter them
 * (`OES_texture_half_float` + its linear and colour-buffer companions), which is
 * the other half of gap #4: bright light accumulates past 1.0 in the pyramid and
 * only comes back into range at the tonemap, so emissives keep their colour
 * instead of clipping to white. Where half-float is unavailable it falls back to
 * 8-bit targets — still a wide multi-scale blur, just clamped in range.
 *
 * The arithmetic (level count, soft-knee prefilter) lives in {@link bloomModel},
 * which has headless tests; the shaders here are a direct port of it. Creation
 * returns null on any GL failure so {@link PostFxPass} can fall back to its
 * inline bloom and a cart never stops playing.
 */

import { pyramidLevelCount, pyramidLevelSize, BLOOM_KNEE } from "./bloomModel.js";

/** Identity mapping: the pyramid never flips, so a bloom texel at coordinate C
 * always holds the blur of the source at coordinate C — that coupling is what
 * lets the composite sample source and bloom at the same UV and stay aligned. */
const VERTEX_SOURCE = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = (aPosition + 1.0) * 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * Bright pass: a 4-tap box downsample of the source (so it works whether the
 * source samples nearest or linear) with the soft-knee threshold applied once to
 * the averaged colour. Scaling the whole colour by one contribution factor keeps
 * the glow's hue faithful to the pixel that lit it.
 */
const PREFILTER_SOURCE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uSourceTexel;
uniform float uThreshold;
uniform float uKnee;

vec3 prefilter(vec3 c) {
  float brightest = max(c.r, max(c.g, c.b));
  float kneeWidth = max(uKnee, 1e-4);
  float soft = brightest - uThreshold + kneeWidth;
  soft = clamp(soft, 0.0, 2.0 * kneeWidth);
  soft = soft * soft / (4.0 * kneeWidth + 1e-4);
  float contribution = max(soft, brightest - uThreshold) / max(brightest, 1e-4);
  return c * max(contribution, 0.0);
}

void main() {
  vec2 o = uSourceTexel * 0.5;
  vec3 sum = texture2D(uTex, vUv + vec2(o.x, o.y)).rgb;
  sum += texture2D(uTex, vUv + vec2(-o.x, o.y)).rgb;
  sum += texture2D(uTex, vUv + vec2(o.x, -o.y)).rgb;
  sum += texture2D(uTex, vUv + vec2(-o.x, -o.y)).rgb;
  gl_FragColor = vec4(prefilter(sum * 0.25), 1.0);
}
`;

/** Dual-Kawase downsample: five bilinear taps averaged, halving the resolution
 * while spreading energy — the cheap, high-quality blur the pyramid is built on. */
const DOWNSAMPLE_SOURCE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;

void main() {
  vec2 halfTexel = uTexel * 0.5;
  vec3 sum = texture2D(uTex, vUv).rgb * 4.0;
  sum += texture2D(uTex, vUv - halfTexel).rgb;
  sum += texture2D(uTex, vUv + halfTexel).rgb;
  sum += texture2D(uTex, vUv + vec2(halfTexel.x, -halfTexel.y)).rgb;
  sum += texture2D(uTex, vUv - vec2(halfTexel.x, -halfTexel.y)).rgb;
  gl_FragColor = vec4(sum / 8.0, 1.0);
}
`;

/** Dual-Kawase upsample: an eight-tap tent, blended additively onto the finer
 * level so each coarser (blurrier) level layers its halo on. `uRadius` scales the
 * tap spread — the artist's Radius control over how wide the glow reaches. */
const UPSAMPLE_SOURCE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uRadius;

void main() {
  vec2 spread = uTexel * 0.5 * (0.5 + uRadius);
  vec3 sum = texture2D(uTex, vUv + vec2(-spread.x * 2.0, 0.0)).rgb;
  sum += texture2D(uTex, vUv + vec2(-spread.x, spread.y)).rgb * 2.0;
  sum += texture2D(uTex, vUv + vec2(0.0, spread.y * 2.0)).rgb;
  sum += texture2D(uTex, vUv + vec2(spread.x, spread.y)).rgb * 2.0;
  sum += texture2D(uTex, vUv + vec2(spread.x * 2.0, 0.0)).rgb;
  sum += texture2D(uTex, vUv + vec2(spread.x, -spread.y)).rgb * 2.0;
  sum += texture2D(uTex, vUv + vec2(0.0, -spread.y * 2.0)).rgb;
  sum += texture2D(uTex, vUv + vec2(-spread.x, -spread.y)).rgb * 2.0;
  gl_FragColor = vec4(sum / 12.0, 1.0);
}
`;

interface Program {
  readonly program: WebGLProgram;
  readonly attribLocation: number;
  readonly uniforms: Map<string, WebGLUniformLocation | null>;
}

interface Level {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

export class BloomPyramid {
  private levels: Level[] = [];
  private baseWidth = 0;
  private baseHeight = 0;

  private constructor(
    private readonly gl: WebGLRenderingContext,
    private readonly quad: WebGLBuffer,
    private readonly prefilter: Program,
    private readonly downsample: Program,
    private readonly upsample: Program,
    /** The pixel type of the render targets: half-float for HDR, else 8-bit. */
    private readonly textureType: number,
  ) {}

  /** Whether the pyramid can hold light past 1.0 (true HDR) or clamps at it. */
  get isHdr(): boolean {
    return this.textureType !== this.gl.UNSIGNED_BYTE;
  }

  /**
   * Build the pyramid against an existing GL context, or return null if any
   * shader/buffer allocation fails. The context is shared with the owning pass;
   * this class only ever renders into its own framebuffers and leaves the
   * default framebuffer bound when it is done.
   */
  static create(gl: WebGLRenderingContext): BloomPyramid | null {
    const quad = gl.createBuffer();
    if (!quad) return null;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const prefilter = buildProgram(gl, PREFILTER_SOURCE, ["uTex", "uSourceTexel", "uThreshold", "uKnee"]);
    const downsample = buildProgram(gl, DOWNSAMPLE_SOURCE, ["uTex", "uTexel"]);
    const upsample = buildProgram(gl, UPSAMPLE_SOURCE, ["uTex", "uTexel", "uRadius"]);
    if (!prefilter || !downsample || !upsample) {
      gl.deleteBuffer(quad);
      return null;
    }

    return new BloomPyramid(gl, quad, prefilter, downsample, upsample, detectTargetType(gl));
  }

  /**
   * Generate the bloom for one frame and return the finest pyramid level (a
   * half-resolution texture holding the accumulated glow), ready to be sampled
   * and added by the composite pass. Targets are reallocated only when the base
   * resolution changes, so steady-state playback allocates nothing.
   */
  generate(
    source: WebGLTexture,
    baseWidth: number,
    baseHeight: number,
    threshold: number,
    radius: number,
  ): WebGLTexture | null {
    const gl = this.gl;
    if (baseWidth !== this.baseWidth || baseHeight !== this.baseHeight) {
      this.allocate(baseWidth, baseHeight);
    }
    if (this.levels.length === 0) return null;

    gl.disable(gl.BLEND);

    // Bright pass: source -> level 0 (half resolution). Indices below are all
    // in-bounds by construction (the loops derive from this.levels.length), so
    // the assertions only satisfy noUncheckedIndexedAccess.
    this.begin(this.prefilter, this.levels[0]!);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(this.prefilter.uniforms.get("uTex")!, 0);
    gl.uniform2f(this.prefilter.uniforms.get("uSourceTexel")!, 1 / baseWidth, 1 / baseHeight);
    gl.uniform1f(this.prefilter.uniforms.get("uThreshold")!, threshold);
    gl.uniform1f(this.prefilter.uniforms.get("uKnee")!, BLOOM_KNEE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Downsample chain: each level blurs the one above into half its size.
    for (let index = 1; index < this.levels.length; index++) {
      const finer = this.levels[index - 1]!;
      this.begin(this.downsample, this.levels[index]!);
      gl.bindTexture(gl.TEXTURE_2D, finer.texture);
      gl.uniform1i(this.downsample.uniforms.get("uTex")!, 0);
      gl.uniform2f(this.downsample.uniforms.get("uTexel")!, 1 / finer.width, 1 / finer.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // Upsample chain: additively fold each coarse level back into the finer one,
    // so level 0 ends up holding every scale of blur summed together.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let index = this.levels.length - 2; index >= 0; index--) {
      const coarser = this.levels[index + 1]!;
      this.begin(this.upsample, this.levels[index]!);
      gl.bindTexture(gl.TEXTURE_2D, coarser.texture);
      gl.uniform1i(this.upsample.uniforms.get("uTex")!, 0);
      gl.uniform2f(this.upsample.uniforms.get("uTexel")!, 1 / coarser.width, 1 / coarser.height);
      gl.uniform1f(this.upsample.uniforms.get("uRadius")!, radius);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.levels[0]!.texture;
  }

  dispose(): void {
    const gl = this.gl;
    this.freeLevels();
    gl.deleteBuffer(this.quad);
    gl.deleteProgram(this.prefilter.program);
    gl.deleteProgram(this.downsample.program);
    gl.deleteProgram(this.upsample.program);
  }

  /** Bind a program and its target framebuffer, and point the shared quad at the
   * program's attribute — GLSL ES 1.00 has no VAOs, so this repeats per draw. */
  private begin(program: Program, level: Level): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, level.framebuffer);
    gl.viewport(0, 0, level.width, level.height);
    gl.useProgram(program.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(program.attribLocation);
    gl.vertexAttribPointer(program.attribLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
  }

  private allocate(baseWidth: number, baseHeight: number): void {
    this.freeLevels();
    this.baseWidth = baseWidth;
    this.baseHeight = baseHeight;
    const count = pyramidLevelCount(baseWidth, baseHeight);
    for (let index = 0; index < count; index++) {
      const { width, height } = pyramidLevelSize(baseWidth, baseHeight, index);
      const level = this.makeLevel(width, height);
      if (!level) break; // A half-built pyramid still blooms with the levels it got.
      this.levels.push(level);
    }
  }

  private makeLevel(width: number, height: number): Level | null {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) return null;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, this.textureType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      return null;
    }
    return { texture, framebuffer, width, height };
  }

  private freeLevels(): void {
    const gl = this.gl;
    for (const level of this.levels) {
      gl.deleteTexture(level.texture);
      gl.deleteFramebuffer(level.framebuffer);
    }
    this.levels = [];
  }
}

/** Compile, link, and cache the uniform locations of one pyramid program. */
function buildProgram(gl: WebGLRenderingContext, fragmentSource: string, uniformNames: string[]): Program | null {
  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("BloomPyramid shader compile failed:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vertex = compile(gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("BloomPyramid program link failed:", gl.getProgramInfoLog(program));
    return null;
  }

  const uniforms = new Map<string, WebGLUniformLocation | null>();
  for (const name of uniformNames) uniforms.set(name, gl.getUniformLocation(program, name));
  return { program, attribLocation: gl.getAttribLocation(program, "aPosition"), uniforms };
}

/**
 * Pick the best render-target pixel type the context can actually render into
 * *and* filter linearly: half-float for HDR when all three extensions are
 * present and a probe framebuffer comes back complete, otherwise plain 8-bit.
 * The probe matters because an extension can be advertised yet fail to render.
 */
function detectTargetType(gl: WebGLRenderingContext): number {
  const halfFloat = gl.getExtension("OES_texture_half_float");
  const halfFloatLinear = gl.getExtension("OES_texture_half_float_linear");
  const colorBufferHalfFloat = gl.getExtension("EXT_color_buffer_half_float");
  if (!halfFloat || !halfFloatLinear || !colorBufferHalfFloat) return gl.UNSIGNED_BYTE;

  const type = halfFloat.HALF_FLOAT_OES as number;
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) return gl.UNSIGNED_BYTE;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, type, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteTexture(texture);
  gl.deleteFramebuffer(framebuffer);
  return complete ? type : gl.UNSIGNED_BYTE;
}
