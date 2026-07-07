/**
 * LightingLayer — a reusable, framework-agnostic WebGL renderer that relights a
 * console framebuffer. It is the LUMEN demo's pipeline lifted into the player so
 * any cart's output can be lit dynamically:
 *
 *   Pass 1  lighting  : albedo + material -> a scene texture
 *                       (Lambert diffuse from the 16-direction normals, plus
 *                        Blinn-Phong specular and height-field cast shadows).
 *   Pass 2  bright    : keep the glowing pixels, at half resolution.
 *   Pass 3  blur      : separable Gaussian, horizontal then vertical.
 *   Pass 4  composite : scene + bloom -> the canvas (this pass flips Y).
 *
 * The material buffer is optional: without it the layer lights flat pixels,
 * giving coloured, distance-attenuated pools over the cart's own art. With a
 * material buffer (from a lighting-aware cart or the editor's normal bank) it
 * upgrades to full per-pixel normals, specular, and shadows.
 *
 * The diffuse term matches {@link shade} in lightingModel.ts by construction.
 */

import { NORMAL_VECTORS } from "./lightingModel.js";
import { createFlatMaterial, type LightingBackend, type LightingRenderer } from "./LightingRenderer.js";
import type { LightingScene, MaterialBuffer } from "./types.js";

const MAX_LIGHTS = 6;
const HEIGHT_MAX = 8.0;

// Straight mapping — passes that render INTO an off-screen framebuffer.
const QUAD_VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Y-flipped mapping — only the final pass to the canvas. An off-screen
// framebuffer and the default framebuffer have opposite row order, so exactly
// one pass must flip; doing it here keeps the picture upright.
const QUAD_VS_FLIP = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;

const LIGHT_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uAlbedo;   // rgb + emissive
uniform sampler2D uMat;      // r=normalIdx/255, g=height, b=spec, a=rough
uniform vec3 uNormals[16];
uniform vec3 uLightPos[${MAX_LIGHTS}];
uniform vec3 uLightColor[${MAX_LIGHTS}];
uniform float uLightRadius[${MAX_LIGHTS}];
uniform int uLightCount;
uniform float uAmbient;
uniform vec3 uAmbientColor;
uniform vec2 uResolution;
uniform float uEnableShadows;
uniform int uUnlit;

const float HMAX = ${HEIGHT_MAX.toFixed(1)};
const vec3 VIEW = vec3(0.0, -0.34, 0.94);

vec3 normalFor(float idxF) {
  int idx = int(idxF + 0.5);
  vec3 n = vec3(0.0, 0.0, 1.0);
  for (int k = 0; k < 16; k++) { if (k == idx) n = uNormals[k]; }
  return n;
}

float heightAt(vec2 p) { return texture2D(uMat, p / uResolution).g * HMAX; }

float shadowFactor(vec2 px, float h0, vec3 lightPos) {
  vec2 d = lightPos.xy - px;
  float dist = length(d);
  if (dist < 0.001) return 1.0;
  for (int i = 1; i <= 16; i++) {
    float t = float(i) / 16.0;
    float rayH = mix(h0, lightPos.z, t);
    if (heightAt(px + d * t) > rayH + 0.45) return 0.25;
  }
  return 1.0;
}

void main() {
  vec4 alb = texture2D(uAlbedo, vUv);
  if (uUnlit == 1) { gl_FragColor = vec4(alb.rgb, 1.0); return; } // passthrough
  vec4 m = texture2D(uMat, vUv);
  vec3 n = normalFor(m.r * 255.0);
  float height = m.g * HMAX;
  float specStr = m.b;
  float rough = m.a;
  float emissive = alb.a;
  vec2 px = vUv * uResolution;

  float shininess = mix(6.0, 120.0, 1.0 - rough);
  vec3 lightSum = uAmbient * uAmbientColor;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec3 toLight = vec3(uLightPos[i].xy - px, uLightPos[i].z - height);
    float dist = length(toLight.xy);
    float atten = clamp(1.0 - dist / uLightRadius[i], 0.0, 1.0);
    atten *= atten;
    vec3 L = normalize(toLight);
    float shadow = uEnableShadows > 0.5 ? shadowFactor(px, height, uLightPos[i]) : 1.0;
    float diffuse = max(0.0, dot(n, L)) * shadow;
    vec3 halfVec = normalize(L + VIEW);
    float specular = pow(max(0.0, dot(n, halfVec)), shininess) * specStr * shadow;
    lightSum += uLightColor[i] * atten * (diffuse + specular);
  }
  float rim = pow(1.0 - max(0.0, dot(n, VIEW)), 3.0);
  lightSum += rim * uAmbientColor * 0.5;

  vec3 lit = alb.rgb * lightSum;
  lit = max(lit, alb.rgb * emissive);
  gl_FragColor = vec4(lit, 1.0);
}`;

const BRIGHT_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform float uThreshold;
void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.25, l), 1.0);
}`;

const BLUR_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform vec2 uTexel;
void main() {
  vec3 sum = texture2D(uTex, vUv).rgb * 0.227;
  sum += texture2D(uTex, vUv + uDir * uTexel * 1.0).rgb * 0.194;
  sum += texture2D(uTex, vUv - uDir * uTexel * 1.0).rgb * 0.194;
  sum += texture2D(uTex, vUv + uDir * uTexel * 2.0).rgb * 0.121;
  sum += texture2D(uTex, vUv - uDir * uTexel * 2.0).rgb * 0.121;
  sum += texture2D(uTex, vUv + uDir * uTexel * 3.0).rgb * 0.054;
  sum += texture2D(uTex, vUv - uDir * uTexel * 3.0).rgb * 0.054;
  gl_FragColor = vec4(sum, 1.0);
}`;

const COMPOSITE_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform int uUseBloom;
void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  if (uUseBloom == 1) c += texture2D(uBloom, vUv).rgb * uBloomStrength;
  gl_FragColor = vec4(c, 1.0);
}`;

interface Program {
  program: WebGLProgram;
  aPos: number;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

/** A minimal canvas shape — the real `HTMLCanvasElement` satisfies it, and so
 * can a fake in tests. */
export interface RenderCanvas {
  width: number;
  height: number;
  getContext(contextId: string, options?: unknown): unknown;
}

export class LightingLayer implements LightingRenderer {
  readonly backend: LightingBackend = "webgl";
  private readonly gl: WebGLRenderingContext;
  private readonly quad: WebGLBuffer;
  private readonly pLight: Program;
  private readonly pBright: Program;
  private readonly pBlur: Program;
  private readonly pComposite: Program;
  private readonly albedoTex: WebGLTexture;
  private readonly matTex: WebGLTexture;
  private readonly scene: Target;
  private readonly bright: Target;
  private readonly blurA: Target;
  private readonly blurB: Target;
  private readonly flatNormals: Float32Array;
  private readonly lightPos = new Float32Array(MAX_LIGHTS * 3);
  private readonly lightColor = new Float32Array(MAX_LIGHTS * 3);
  private readonly lightRadius = new Float32Array(MAX_LIGHTS);
  private flatMaterial: Uint8Array | null = null;

  /** Whether a WebGL lighting context can be created on this canvas. */
  static isSupported(canvas: RenderCanvas): boolean {
    try {
      return Boolean(
        canvas.getContext("webgl") || canvas.getContext("experimental-webgl"),
      );
    } catch {
      return false;
    }
  }

  constructor(
    private readonly renderCanvas: RenderCanvas,
    private readonly width: number,
    private readonly height: number,
  ) {
    renderCanvas.width = width;
    renderCanvas.height = height;
    const gl = (renderCanvas.getContext("webgl", { antialias: false, alpha: false })
      || renderCanvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) throw new Error("WebGL is unavailable; cannot create a LightingLayer");
    this.gl = gl;

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.pLight = this.build(LIGHT_FS);
    this.pBright = this.build(BRIGHT_FS);
    this.pBlur = this.build(BLUR_FS);
    this.pComposite = this.build(COMPOSITE_FS, QUAD_VS_FLIP);

    this.albedoTex = this.makeDataTexture();
    this.matTex = this.makeDataTexture();

    const halfW = Math.max(1, width >> 1);
    const halfH = Math.max(1, height >> 1);
    this.scene = this.makeTarget(width, height, false);
    this.bright = this.makeTarget(halfW, halfH, true);
    this.blurA = this.makeTarget(halfW, halfH, true);
    this.blurB = this.makeTarget(halfW, halfH, true);

    this.flatNormals = new Float32Array(16 * 3);
    NORMAL_VECTORS.forEach((v, i) => {
      this.flatNormals[i * 3] = v[0];
      this.flatNormals[i * 3 + 1] = v[1];
      this.flatNormals[i * 3 + 2] = v[2];
    });
  }

  /**
   * Relight one frame and present it to the canvas.
   *
   * @param albedo   The cart's RGBA framebuffer (width*height*4 bytes).
   * @param material Optional per-pixel material (normal/height/spec/rough); when
   *                 null, pixels are lit flat.
   * @param scene    The lights and ambient for this frame.
   */
  render(albedo: Uint8Array, material: MaterialBuffer | null, scene: LightingScene): void {
    const gl = this.gl;
    const material0 = material ?? this.flatMaterialBuffer();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.albedoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, albedo);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, material0);

    // ---- Pass 1: lighting -> scene ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.width, this.height);
    this.bindQuad(this.pLight);
    this.bindSampler(0, this.albedoTex, this.pLight, "uAlbedo");
    this.bindSampler(1, this.matTex, this.pLight, "uMat");
    gl.uniform3fv(this.uni(this.pLight, "uNormals"), this.flatNormals);
    gl.uniform2f(this.uni(this.pLight, "uResolution"), this.width, this.height);

    const count = Math.min(scene.lights.length, MAX_LIGHTS);
    for (let i = 0; i < count; i += 1) {
      const light = scene.lights[i]!;
      this.lightPos[i * 3] = light.x;
      this.lightPos[i * 3 + 1] = light.y;
      this.lightPos[i * 3 + 2] = light.z;
      this.lightColor[i * 3] = light.color[0];
      this.lightColor[i * 3 + 1] = light.color[1];
      this.lightColor[i * 3 + 2] = light.color[2];
      this.lightRadius[i] = light.radius;
    }
    gl.uniform3fv(this.uni(this.pLight, "uLightPos"), this.lightPos);
    gl.uniform3fv(this.uni(this.pLight, "uLightColor"), this.lightColor);
    gl.uniform1fv(this.uni(this.pLight, "uLightRadius"), this.lightRadius);
    gl.uniform1i(this.uni(this.pLight, "uLightCount"), count);
    gl.uniform1f(this.uni(this.pLight, "uAmbient"), scene.ambient);
    gl.uniform3f(this.uni(this.pLight, "uAmbientColor"), scene.ambientColor[0], scene.ambientColor[1], scene.ambientColor[2]);
    gl.uniform1f(this.uni(this.pLight, "uEnableShadows"), scene.shadows && material ? 1 : 0);
    gl.uniform1i(this.uni(this.pLight, "uUnlit"), scene.unlit ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // An unlit passthrough has nothing to bloom.
    const useBloom = scene.bloom && !scene.unlit;
    if (useBloom) {
      // ---- Pass 2: bright pass ----
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bright.fbo);
      gl.viewport(0, 0, this.bright.width, this.bright.height);
      this.bindQuad(this.pBright);
      this.bindSampler(0, this.scene.tex, this.pBright, "uScene");
      gl.uniform1f(this.uni(this.pBright, "uThreshold"), 0.72);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // ---- Pass 3: separable blur ----
      this.bindQuad(this.pBlur);
      gl.uniform2f(this.uni(this.pBlur, "uTexel"), 1 / this.bright.width, 1 / this.bright.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurA.fbo);
      gl.viewport(0, 0, this.blurA.width, this.blurA.height);
      this.bindSampler(0, this.bright.tex, this.pBlur, "uTex");
      gl.uniform2f(this.uni(this.pBlur, "uDir"), 1, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurB.fbo);
      gl.viewport(0, 0, this.blurB.width, this.blurB.height);
      this.bindSampler(0, this.blurA.tex, this.pBlur, "uTex");
      gl.uniform2f(this.uni(this.pBlur, "uDir"), 0, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ---- Pass 4: composite -> canvas (flips Y) ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    this.bindQuad(this.pComposite);
    this.bindSampler(0, this.scene.tex, this.pComposite, "uScene");
    this.bindSampler(1, useBloom ? this.blurB.tex : this.scene.tex, this.pComposite, "uBloom");
    gl.uniform1f(this.uni(this.pComposite, "uBloomStrength"), 1.1);
    gl.uniform1i(this.uni(this.pComposite, "uUseBloom"), useBloom ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Releases all GL resources. */
  dispose(): void {
    const gl = this.gl;
    for (const p of [this.pLight, this.pBright, this.pBlur, this.pComposite]) gl.deleteProgram(p.program);
    for (const t of [this.albedoTex, this.matTex]) gl.deleteTexture(t);
    for (const target of [this.scene, this.bright, this.blurA, this.blurB]) {
      gl.deleteTexture(target.tex);
      gl.deleteFramebuffer(target.fbo);
    }
    gl.deleteBuffer(this.quad);
  }

  private flatMaterialBuffer(): Uint8Array {
    if (!this.flatMaterial) this.flatMaterial = createFlatMaterial(this.width, this.height);
    return this.flatMaterial;
  }

  private uni(p: Program, name: string): WebGLUniformLocation | null {
    if (!(name in p.uniforms)) p.uniforms[name] = this.gl.getUniformLocation(p.program, name);
    return p.uniforms[name] ?? null;
  }

  private bindQuad(p: Program): void {
    const gl = this.gl;
    gl.useProgram(p.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
  }

  private bindSampler(unit: number, tex: WebGLTexture, p: Program, name: string): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.uni(p, name), unit);
  }

  private build(fs: string, vs: string = QUAD_VS): Program {
    const program = linkProgram(this.gl, vs, fs);
    return { program, aPos: this.gl.getAttribLocation(program, "aPos"), uniforms: {} };
  }

  private makeDataTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private makeTarget(width: number, height: number, linear: boolean): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, width, height };
  }
}

function linkProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error("Lighting shader compile failed: " + gl.getShaderInfoLog(shader));
    }
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error("Lighting program link failed: " + gl.getProgramInfoLog(program));
  }
  return program;
}
