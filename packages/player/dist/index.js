// src/audio.ts
var AudioController = class {
  constructor(sampleRate) {
    this.nextStartTime = 0;
    this.context = new AudioContext({ sampleRate });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
  }
  /** Resumes the context. Call from within a user-gesture handler. */
  async resume() {
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }
  /** Suspends output so a paused player makes no sound. */
  async pause() {
    if (this.context.state === "running") {
      await this.context.suspend();
    }
  }
  /**
   * Queues one frame's worth of samples for gapless playback.
   *
   * Each buffer is scheduled to begin exactly where the previous one ended,
   * which avoids clicks between frames. If the scheduler falls behind (e.g. a
   * background tab), it resyncs to the context clock.
   */
  enqueue(samples) {
    if (samples.length === 0) {
      return;
    }
    const buffer = this.context.createBuffer(1, samples.length, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      channel[i] = (samples[i] ?? 0) / 32768;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const now = this.context.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }
  destroy() {
    this.gain.disconnect();
    void this.context.close();
  }
};

// src/cartridge.ts
var CartridgeLoadError = class extends Error {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
    this.name = "CartridgeLoadError";
  }
};
var MINIMUM_CARTRIDGE_BYTES = 4;
async function fetchCartridge(cartUrl, signal) {
  let response;
  try {
    response = await fetch(cartUrl, { signal });
  } catch (networkError) {
    throw new CartridgeLoadError(`Failed to reach cartridge at ${cartUrl}`, networkError);
  }
  if (!response.ok) {
    throw new CartridgeLoadError(`Cartridge request failed (${response.status}) for ${cartUrl}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < MINIMUM_CARTRIDGE_BYTES) {
    throw new CartridgeLoadError(`Cartridge at ${cartUrl} is empty or truncated`);
  }
  return bytes;
}

// src/display.ts
function computeScaledSize(containerWidth, containerHeight, nativeWidth, nativeHeight, mode) {
  let scale;
  if (typeof mode === "number") {
    scale = mode;
  } else {
    const bestFitScale = Math.min(containerWidth / nativeWidth, containerHeight / nativeHeight);
    scale = mode === "integer" ? Math.max(1, Math.floor(bestFitScale)) : bestFitScale;
  }
  return {
    width: nativeWidth * scale,
    height: nativeHeight * scale,
    scale
  };
}
var CanvasSurface = class {
  constructor(container, scaleMode, model) {
    this.container = container;
    this.scaleMode = scaleMode;
    this.model = model;
    this.canvas = container.ownerDocument.createElement("canvas");
    this.canvas.width = model.width;
    this.canvas.height = model.height;
    this.canvas.style.imageRendering = "pixelated";
    this.canvas.style.display = "block";
    this.canvas.style.margin = "auto";
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("2D canvas context unavailable in this environment");
    }
    this.context = context;
    this.frame = context.createImageData(model.width, model.height);
    container.appendChild(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);
    this.applyScale();
  }
  /** Copies an RGBA framebuffer from the engine to the canvas. */
  blit(rgba) {
    const expected = this.model.width * this.model.height * this.model.pixelBytes;
    if (rgba.byteLength !== expected) {
      throw new Error(`Framebuffer size mismatch: expected ${expected}, got ${rgba.byteLength}`);
    }
    this.frame.data.set(rgba);
    this.context.putImageData(this.frame, 0, 0);
  }
  /** Recomputes CSS size from the current container dimensions. */
  applyScale() {
    const { width, height } = computeScaledSize(
      this.container.clientWidth,
      this.container.clientHeight,
      this.model.width,
      this.model.height,
      this.scaleMode
    );
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }
  /** Removes the canvas and stops observing resizes. */
  destroy() {
    this.resizeObserver.disconnect();
    this.canvas.remove();
  }
};

// src/lighting/lightingModel.ts
var NORMAL_DIRECTION_COUNT = 16;
var COMPASS_TILT = 0.55;
function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
function buildNormalVectors() {
  const compassOffsets = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1]
  ];
  const directions = [[0, 0, 1]];
  for (const [offsetX, offsetY] of compassOffsets) {
    const x = offsetX * COMPASS_TILT;
    const y = offsetY * COMPASS_TILT;
    const z = Math.sqrt(Math.max(1e-4, 1 - x * x - y * y));
    directions.push(normalize([x, y, z]));
  }
  while (directions.length < NORMAL_DIRECTION_COUNT) directions.push([0, 0, 1]);
  return directions;
}
var NORMAL_VECTORS = buildNormalVectors();
function normalVector(direction) {
  return NORMAL_VECTORS[direction] ?? NORMAL_VECTORS[0];
}
function nearestDirection(vector) {
  const target = normalize(vector);
  let best = 0;
  let bestDot = -Infinity;
  for (let index = 0; index < NORMAL_VECTORS.length; index += 1) {
    const [nx, ny, nz] = NORMAL_VECTORS[index];
    const dot = nx * target[0] + ny * target[1] + nz * target[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = index;
    }
  }
  return best;
}
function shade(albedo, normal, toLight, ambient) {
  const n = normalize(normal);
  const l = normalize(toLight);
  const diffuse = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
  const intensity = ambient + (1 - ambient) * diffuse;
  const clamp = (value) => Math.max(0, Math.min(255, Math.round(value * intensity)));
  return [clamp(albedo[0]), clamp(albedo[1]), clamp(albedo[2])];
}

// src/lighting/LightingRenderer.ts
function createFlatMaterial(width, height) {
  const material = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) material[i * 4 + 3] = 255;
  return material;
}

// src/lighting/LightingLayer.ts
var MAX_LIGHTS = 6;
var HEIGHT_MAX = 8;
var QUAD_VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
var QUAD_VS_FLIP = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;
var LIGHT_FS = `
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
var BRIGHT_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform float uThreshold;
void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.25, l), 1.0);
}`;
var BLUR_FS = `
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
var COMPOSITE_FS = `
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
var LightingLayer = class {
  constructor(renderCanvas, width, height) {
    this.renderCanvas = renderCanvas;
    this.width = width;
    this.height = height;
    this.backend = "webgl";
    this.lightPos = new Float32Array(MAX_LIGHTS * 3);
    this.lightColor = new Float32Array(MAX_LIGHTS * 3);
    this.lightRadius = new Float32Array(MAX_LIGHTS);
    this.flatMaterial = null;
    renderCanvas.width = width;
    renderCanvas.height = height;
    const gl = renderCanvas.getContext("webgl", { antialias: false, alpha: false }) || renderCanvas.getContext("experimental-webgl");
    if (!gl) throw new Error("WebGL is unavailable; cannot create a LightingLayer");
    this.gl = gl;
    this.quad = gl.createBuffer();
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
  /** Whether a WebGL lighting context can be created on this canvas. */
  static isSupported(canvas) {
    try {
      return Boolean(
        canvas.getContext("webgl") || canvas.getContext("experimental-webgl")
      );
    } catch {
      return false;
    }
  }
  /**
   * Relight one frame and present it to the canvas.
   *
   * @param albedo   The cart's RGBA framebuffer (width*height*4 bytes).
   * @param material Optional per-pixel material (normal/height/spec/rough); when
   *                 null, pixels are lit flat.
   * @param scene    The lights and ambient for this frame.
   */
  render(albedo, material, scene) {
    const gl = this.gl;
    const material0 = material ?? this.flatMaterialBuffer();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.albedoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, albedo);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, material0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.width, this.height);
    this.bindQuad(this.pLight);
    this.bindSampler(0, this.albedoTex, this.pLight, "uAlbedo");
    this.bindSampler(1, this.matTex, this.pLight, "uMat");
    gl.uniform3fv(this.uni(this.pLight, "uNormals"), this.flatNormals);
    gl.uniform2f(this.uni(this.pLight, "uResolution"), this.width, this.height);
    const count = Math.min(scene.lights.length, MAX_LIGHTS);
    for (let i = 0; i < count; i += 1) {
      const light = scene.lights[i];
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
    const useBloom = scene.bloom && !scene.unlit;
    if (useBloom) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bright.fbo);
      gl.viewport(0, 0, this.bright.width, this.bright.height);
      this.bindQuad(this.pBright);
      this.bindSampler(0, this.scene.tex, this.pBright, "uScene");
      gl.uniform1f(this.uni(this.pBright, "uThreshold"), 0.72);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
  dispose() {
    const gl = this.gl;
    for (const p of [this.pLight, this.pBright, this.pBlur, this.pComposite]) gl.deleteProgram(p.program);
    for (const t of [this.albedoTex, this.matTex]) gl.deleteTexture(t);
    for (const target of [this.scene, this.bright, this.blurA, this.blurB]) {
      gl.deleteTexture(target.tex);
      gl.deleteFramebuffer(target.fbo);
    }
    gl.deleteBuffer(this.quad);
  }
  flatMaterialBuffer() {
    if (!this.flatMaterial) this.flatMaterial = createFlatMaterial(this.width, this.height);
    return this.flatMaterial;
  }
  uni(p, name) {
    if (!(name in p.uniforms)) p.uniforms[name] = this.gl.getUniformLocation(p.program, name);
    return p.uniforms[name] ?? null;
  }
  bindQuad(p) {
    const gl = this.gl;
    gl.useProgram(p.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
  }
  bindSampler(unit, tex, p, name) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.uni(p, name), unit);
  }
  build(fs, vs = QUAD_VS) {
    const program = linkProgram(this.gl, vs, fs);
    return { program, aPos: this.gl.getAttribLocation(program, "aPos"), uniforms: {} };
  }
  makeDataTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  makeTarget(width, height, linear) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, width, height };
  }
};
function linkProgram(gl, vsSrc, fsSrc) {
  const compile = (type, src) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error("Lighting shader compile failed: " + gl.getShaderInfoLog(shader));
    }
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error("Lighting program link failed: " + gl.getProgramInfoLog(program));
  }
  return program;
}

// src/lighting/WebgpuLightingLayer.ts
var MAX_LIGHTS2 = 6;
var HEIGHT_MAX2 = 8;
var TEXTURE_BINDING = 4;
var COPY_DST_TEX = 2;
var RENDER_ATTACHMENT = 16;
var UNIFORM = 64;
var COPY_DST_BUF = 8;
var VS = (
  /* wgsl */
  `
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let xy = corners[vi];
  var out: VSOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return out;
}`
);
var LIGHT_WGSL = VS + /* wgsl */
`
struct LightU {
  dims: vec4<f32>,                              // resX, resY, ambient, unlit
  misc: vec4<f32>,                              // ambientColor.rgb, lightCount
  flags: vec4<f32>,                             // enableShadows, _, _, _
  normals: array<vec4<f32>, 16>,                // xyz = normal
  lightPosRadius: array<vec4<f32>, ${MAX_LIGHTS2}>,
  lightColor: array<vec4<f32>, ${MAX_LIGHTS2}>,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var albedoTex: texture_2d<f32>;
@group(0) @binding(2) var matTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: LightU;

const HMAX = ${HEIGHT_MAX2.toFixed(1)};
const VIEW = vec3<f32>(0.0, -0.34, 0.94);

fn heightAt(p: vec2<f32>) -> f32 {
  return textureSampleLevel(matTex, samp, p / u.dims.xy, 0.0).g * HMAX;
}

fn shadowFactor(px: vec2<f32>, h0: f32, lp: vec3<f32>) -> f32 {
  let d = lp.xy - px;
  let dist = length(d);
  if (dist < 0.001) { return 1.0; }
  for (var i = 1; i <= 16; i = i + 1) {
    let t = f32(i) / 16.0;
    let rayH = mix(h0, lp.z, t);
    if (heightAt(px + d * t) > rayH + 0.45) { return 0.25; }
  }
  return 1.0;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let alb = textureSampleLevel(albedoTex, samp, in.uv, 0.0);
  if (u.dims.w > 0.5) { return vec4<f32>(alb.rgb, 1.0); } // unlit passthrough
  let m = textureSampleLevel(matTex, samp, in.uv, 0.0);
  let idx = clamp(i32(m.r * 255.0 + 0.5), 0, 15);
  let n = normalize(u.normals[idx].xyz);
  let height = m.g * HMAX;
  let specStr = m.b;
  let rough = m.a;
  let emissive = alb.a;
  let px = in.uv * u.dims.xy;
  let shininess = mix(6.0, 120.0, 1.0 - rough);
  var lightSum = u.dims.z * u.misc.xyz;
  let count = i32(u.misc.w);
  for (var i = 0; i < ${MAX_LIGHTS2}; i = i + 1) {
    if (i >= count) { break; }
    let lp = u.lightPosRadius[i];
    let toLight = vec3<f32>(lp.xy - px, lp.z - height);
    let dist = length(toLight.xy);
    var atten = clamp(1.0 - dist / lp.w, 0.0, 1.0);
    atten = atten * atten;
    let L = normalize(toLight);
    var shadow = 1.0;
    if (u.flags.x > 0.5) { shadow = shadowFactor(px, height, lp.xyz); }
    let diffuse = max(0.0, dot(n, L)) * shadow;
    let halfVec = normalize(L + VIEW);
    let spec = pow(max(0.0, dot(n, halfVec)), shininess) * specStr * shadow;
    lightSum = lightSum + u.lightColor[i].xyz * atten * (diffuse + spec);
  }
  let rim = pow(1.0 - max(0.0, dot(n, VIEW)), 3.0);
  lightSum = lightSum + rim * u.misc.xyz * 0.5;
  var lit = alb.rgb * lightSum;
  lit = max(lit, alb.rgb * emissive);
  return vec4<f32>(lit, 1.0);
}`;
var BRIGHT_WGSL = VS + /* wgsl */
`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: vec4<f32>; // threshold, _, _, _
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(sceneTex, samp, in.uv, 0.0).rgb;
  let l = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  return vec4<f32>(c * smoothstep(u.x, u.x + 0.25, l), 1.0);
}`;
var BLUR_WGSL = VS + /* wgsl */
`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: vec4<f32>; // dir.xy, texel.xy
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let o = u.xy * u.zw;
  var sum = textureSampleLevel(srcTex, samp, in.uv, 0.0).rgb * 0.227;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv + o * 1.0, 0.0).rgb * 0.194;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv - o * 1.0, 0.0).rgb * 0.194;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv + o * 2.0, 0.0).rgb * 0.121;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv - o * 2.0, 0.0).rgb * 0.121;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv + o * 3.0, 0.0).rgb * 0.054;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv - o * 3.0, 0.0).rgb * 0.054;
  return vec4<f32>(sum, 1.0);
}`;
var COMPOSITE_WGSL = VS + /* wgsl */
`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: vec4<f32>; // bloomStrength, useBloom, _, _
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  var c = textureSampleLevel(sceneTex, samp, in.uv, 0.0).rgb;
  if (u.y > 0.5) { c = c + textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb * u.x; }
  return vec4<f32>(c, 1.0);
}`;
var WebgpuLightingLayer = class _WebgpuLightingLayer {
  constructor(device, context, width, height, textures, targets, pipelines, binds, buffers) {
    this.device = device;
    this.context = context;
    this.width = width;
    this.height = height;
    this.textures = textures;
    this.targets = targets;
    this.pipelines = pipelines;
    this.binds = binds;
    this.buffers = buffers;
    this.backend = "webgpu";
    this.flatMaterial = null;
    this.lightData = new Float32Array(124);
    // matches LightU (496 bytes)
    this.compData = new Float32Array(4);
    NORMAL_VECTORS.forEach((v, i) => {
      this.lightData[12 + i * 4] = v[0];
      this.lightData[12 + i * 4 + 1] = v[1];
      this.lightData[12 + i * 4 + 2] = v[2];
    });
  }
  static async create(canvas, width, height, device) {
    try {
      const gpu = globalThis.navigator?.gpu;
      if (!gpu || !device) return null;
      const context = canvas.getContext("webgpu");
      if (!context) return null;
      canvas.width = width;
      canvas.height = height;
      const format = gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "opaque" });
      const dataTexture = () => device.createTexture({ size: [width, height], format: "rgba8unorm", usage: TEXTURE_BINDING | COPY_DST_TEX });
      const targetTexture = () => device.createTexture({ size: [width, height], format: "rgba8unorm", usage: TEXTURE_BINDING | RENDER_ATTACHMENT });
      const albedo = dataTexture();
      const mat = dataTexture();
      const scene = targetTexture();
      const bright = targetTexture();
      const blurA = targetTexture();
      const blurB = targetTexture();
      const nearest = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
      const linear = device.createSampler({ magFilter: "linear", minFilter: "linear" });
      const pipe = (code, targetFormat) => {
        const module = device.createShaderModule({ code });
        return device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs" },
          fragment: { module, entryPoint: "fs", targets: [{ format: targetFormat }] },
          primitive: { topology: "triangle-list" }
        });
      };
      const light = pipe(LIGHT_WGSL, "rgba8unorm");
      const brightPipe = pipe(BRIGHT_WGSL, "rgba8unorm");
      const blurPipe = pipe(BLUR_WGSL, "rgba8unorm");
      const composite = pipe(COMPOSITE_WGSL, format);
      const uniform = (size) => device.createBuffer({ size, usage: UNIFORM | COPY_DST_BUF });
      const lightBuffer = uniform(496);
      const brightBuffer = uniform(16);
      const blurBufferH = uniform(16);
      const blurBufferV = uniform(16);
      const compositeBuffer = uniform(16);
      device.queue.writeBuffer(brightBuffer, 0, new Float32Array([0.72, 0, 0, 0]));
      device.queue.writeBuffer(blurBufferH, 0, new Float32Array([1, 0, 1 / width, 1 / height]));
      device.queue.writeBuffer(blurBufferV, 0, new Float32Array([0, 1, 1 / width, 1 / height]));
      const bind = (pipeline, entries) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const tex = (t) => t.createView();
      const binds = {
        light: bind(light, [
          { binding: 0, resource: nearest },
          { binding: 1, resource: tex(albedo) },
          { binding: 2, resource: tex(mat) },
          { binding: 3, resource: { buffer: lightBuffer } }
        ]),
        bright: bind(brightPipe, [
          { binding: 0, resource: nearest },
          { binding: 1, resource: tex(scene) },
          { binding: 2, resource: { buffer: brightBuffer } }
        ]),
        blurA: bind(blurPipe, [
          { binding: 0, resource: linear },
          { binding: 1, resource: tex(bright) },
          { binding: 2, resource: { buffer: blurBufferH } }
        ]),
        blurB: bind(blurPipe, [
          { binding: 0, resource: linear },
          { binding: 1, resource: tex(blurA) },
          { binding: 2, resource: { buffer: blurBufferV } }
        ]),
        composite: bind(composite, [
          { binding: 0, resource: nearest },
          { binding: 1, resource: tex(scene) },
          { binding: 2, resource: tex(blurB) },
          { binding: 3, resource: { buffer: compositeBuffer } }
        ])
      };
      return new _WebgpuLightingLayer(
        device,
        context,
        width,
        height,
        { albedo, mat },
        { scene, bright, blurA, blurB },
        { light, bright: brightPipe, blur: blurPipe, composite },
        binds,
        { light: lightBuffer, composite: compositeBuffer }
      );
    } catch {
      return null;
    }
  }
  render(albedo, material, scene) {
    const q = this.device.queue;
    const mat = material ?? this.flatMaterialBuffer();
    const layout = { bytesPerRow: this.width * 4, rowsPerImage: this.height };
    const size = { width: this.width, height: this.height };
    q.writeTexture({ texture: this.textures.albedo }, albedo, layout, size);
    q.writeTexture({ texture: this.textures.mat }, mat, layout, size);
    const u = this.lightData;
    const count = Math.min(scene.lights.length, MAX_LIGHTS2);
    u[0] = this.width;
    u[1] = this.height;
    u[2] = scene.ambient;
    u[3] = scene.unlit ? 1 : 0;
    u[4] = scene.ambientColor[0];
    u[5] = scene.ambientColor[1];
    u[6] = scene.ambientColor[2];
    u[7] = count;
    u[8] = scene.shadows && material ? 1 : 0;
    u[9] = 0;
    u[10] = 0;
    u[11] = 0;
    for (let i = 0; i < count; i += 1) {
      const light = scene.lights[i];
      u[76 + i * 4] = light.x;
      u[76 + i * 4 + 1] = light.y;
      u[76 + i * 4 + 2] = light.z;
      u[76 + i * 4 + 3] = light.radius;
      u[100 + i * 4] = light.color[0];
      u[100 + i * 4 + 1] = light.color[1];
      u[100 + i * 4 + 2] = light.color[2];
    }
    q.writeBuffer(this.buffers.light, 0, u);
    const useBloom = scene.bloom && !scene.unlit;
    this.compData[0] = 1.1;
    this.compData[1] = useBloom ? 1 : 0;
    q.writeBuffer(this.buffers.composite, 0, this.compData);
    const encoder = this.device.createCommandEncoder();
    this.runPass(encoder, this.targets.scene.createView(), this.pipelines.light, this.binds.light);
    if (useBloom) {
      this.runPass(encoder, this.targets.bright.createView(), this.pipelines.bright, this.binds.bright);
      this.runPass(encoder, this.targets.blurA.createView(), this.pipelines.blur, this.binds.blurA);
      this.runPass(encoder, this.targets.blurB.createView(), this.pipelines.blur, this.binds.blurB);
    }
    this.runPass(encoder, this.context.getCurrentTexture().createView(), this.pipelines.composite, this.binds.composite);
    q.submit([encoder.finish()]);
  }
  dispose() {
    for (const t of [this.textures.albedo, this.textures.mat, this.targets.scene, this.targets.bright, this.targets.blurA, this.targets.blurB]) {
      try {
        t.destroy();
      } catch {
      }
    }
  }
  runPass(encoder, view, pipeline, bindGroup) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }]
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }
  flatMaterialBuffer() {
    if (!this.flatMaterial) this.flatMaterial = createFlatMaterial(this.width, this.height);
    return this.flatMaterial;
  }
};

// src/lighting/webgpuDevice.ts
var devicePromise;
function getWebgpuDevice() {
  if (!devicePromise) devicePromise = acquireDevice();
  return devicePromise;
}
async function acquireDevice() {
  try {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    return await adapter.requestDevice();
  } catch {
    return null;
  }
}

// src/lighting/createLightingLayer.ts
async function createLightingLayer(doc, width, height, deviceProvider = getWebgpuDevice) {
  const device = await deviceProvider();
  if (device) {
    const canvas2 = doc.createElement("canvas");
    const renderer = await WebgpuLightingLayer.create(canvas2, width, height, device);
    if (renderer) return { renderer, canvas: canvas2 };
  }
  const canvas = doc.createElement("canvas");
  try {
    return { renderer: new LightingLayer(canvas, width, height), canvas };
  } catch {
    return null;
  }
}

// src/lighting/LitCanvasSurface.ts
var DEFAULT_AMBIENT = 0.16;
var DEFAULT_AMBIENT_COLOR = [0.5, 0.55, 0.8];
var LitCanvasSurface = class _LitCanvasSurface {
  constructor(container, scaleMode, model, options, built) {
    this.container = container;
    this.scaleMode = scaleMode;
    this.model = model;
    this.options = options;
    this.frame = 0;
    this.cartLights = [];
    // A stable, non-resizable copy of the framebuffer for GPU upload. The engine's
    // framebuffer is a view over WASM memory whose backing ArrayBuffer is growable,
    // and WebGL/WebGPU texture uploads reject resizable ArrayBufferViews. Copying
    // into a plain buffer once per frame satisfies the upload contract.
    this.albedoCopy = null;
    const view = container.ownerDocument.defaultView;
    this.performanceNow = () => view?.performance.now() ?? Date.now();
    if (!built) {
      this.fallback = new CanvasSurface(container, scaleMode, model);
      this.resizeObserver = new ResizeObserver(() => {
      });
      return;
    }
    this.renderer = built.renderer;
    this.canvas = built.canvas;
    this.canvas.style.imageRendering = "pixelated";
    this.canvas.style.display = "block";
    this.canvas.style.margin = "auto";
    container.appendChild(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);
    this.applyScale();
  }
  /** Builds the surface, choosing the best available lighting backend. */
  static async create(container, scaleMode, model, options) {
    const built = await createLightingLayer(container.ownerDocument, model.width, model.height);
    return new _LitCanvasSurface(container, scaleMode, model, options, built);
  }
  /** Whether the lit path is active (false means it fell back to plain 2D). */
  get isLit() {
    return !this.fallback;
  }
  /** The active backend: "webgpu", "webgl", or "2d" when unlit. */
  get backend() {
    return this.renderer?.backend ?? "2d";
  }
  /**
   * Sets the lights the running cart emitted this frame (via `cartbox.light`).
   * They are combined with any host-provided lights on the next {@link blit}.
   */
  setCartLights(lights) {
    this.cartLights = lights;
  }
  blit(albedo) {
    if (this.fallback || !this.renderer) {
      this.fallback?.blit(albedo);
      return;
    }
    const context = {
      frame: this.frame,
      timeMs: this.performanceNow(),
      width: this.model.width,
      height: this.model.height
    };
    const hostLights = this.options.lights?.(context) ?? [];
    const lights = this.cartLights.length ? [...this.cartLights, ...hostLights] : hostLights;
    const material = this.resolveMaterial(context);
    const unlit = (this.options.autoDetect ?? false) && lights.length === 0;
    if (!this.albedoCopy || this.albedoCopy.length !== albedo.length) {
      this.albedoCopy = new Uint8Array(albedo.length);
    }
    this.albedoCopy.set(albedo);
    this.renderer.render(this.albedoCopy, material, {
      lights,
      ambient: this.options.ambient ?? DEFAULT_AMBIENT,
      ambientColor: this.options.ambientColor ?? DEFAULT_AMBIENT_COLOR,
      bloom: this.options.bloom ?? true,
      shadows: this.options.shadows ?? false,
      unlit
    });
    this.frame += 1;
  }
  destroy() {
    if (this.fallback) {
      this.fallback.destroy();
      return;
    }
    this.resizeObserver.disconnect();
    this.renderer?.dispose();
    this.canvas?.remove();
  }
  resolveMaterial(context) {
    const source = this.options.material;
    if (typeof source === "function") return source(context);
    return source ?? null;
  }
  applyScale() {
    if (!this.canvas) return;
    const { width, height } = computeScaledSize(
      this.container.clientWidth,
      this.container.clientHeight,
      this.model.width,
      this.model.height,
      this.scaleMode
    );
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }
};

// src/fx/PostFxPass.ts
var VERTEX_SOURCE = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  // Screen-space UV with a top-left origin, so uv.y matches image row order.
  vUv = vec2((aPosition.x + 1.0) * 0.5, (1.0 - aPosition.y) * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;
var FRAGMENT_SOURCE = `
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

float luma(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

vec3 brightPass(vec2 uv) {
  vec3 color = texture2D(uSource, uv).rgb;
  return color * smoothstep(uBloomThreshold, 1.0, luma(color));
}

void main() {
  // CRT barrel curvature: bow the sampling grid outward from the centre.
  vec2 centered = vUv - 0.5;
  vec2 uv = vUv + centered * dot(centered, centered) * uCurvature * 4.0;
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

  // Grade: brightness, then contrast around mid-grey, then saturation.
  color *= uBrightness;
  color = (color - 0.5) * uContrast + 0.5;
  color = mix(vec3(luma(color)), color, uSaturation);

  // Posterize: quantise each channel to uPosterize levels (0 = off).
  if (uPosterize >= 2.0) {
    color = floor(color * uPosterize) / (uPosterize - 1.0);
    color = min(color, vec3(1.0));
  }

  // Fog: thickens from the horizon line upward (distance in a 2D scene).
  // smoothstep needs edge0 < edge1, so invert the ramp instead of the edges.
  float fogAmount = uFogDensity * (1.0 - smoothstep(uFogHorizon - 0.35, uFogHorizon + 0.35, uv.y));
  color = mix(color, uFogColor, clamp(fogAmount, 0.0, 1.0));

  // Vignette: radial darkening toward the corners.
  float falloff = 1.0 - uVignette * smoothstep(0.25, 0.75, dot(centered, centered) * 2.0);
  color *= falloff;

  // Scanlines: darken alternate source rows (identity when strength is 0).
  float scan = 1.0 - uScanlines * 0.25 * (1.0 + sin(uv.y * uSourceSize.y * 3.14159));
  color *= scan;

  gl_FragColor = vec4(color, 1.0);
}
`;
var PostFxPass = class _PostFxPass {
  constructor(gl, program, texture) {
    this.gl = gl;
    this.program = program;
    this.texture = texture;
    this.uniformLocations = /* @__PURE__ */ new Map();
  }
  /** Returns null when WebGL is unavailable or the shaders fail to compile. */
  static create(canvas) {
    const gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) return null;
    const compile = (type, source) => {
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
    return new _PostFxPass(gl, program, texture);
  }
  location(name) {
    if (!this.uniformLocations.has(name)) {
      this.uniformLocations.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniformLocations.get(name) ?? null;
  }
  /** Upload one frame and draw it through the effect chain. */
  render(source, width, height, uniforms) {
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
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      );
    } else {
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
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  dispose() {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
  }
};

// src/fx/postfx.ts
var POST_FX_EFFECTS = [
  {
    id: "grade",
    label: "Color grade",
    description: "Brightness, contrast, and saturation over the whole frame.",
    params: [
      { id: "brightness", label: "Brightness", min: 0.5, max: 1.5, step: 0.01, defaultValue: 1 },
      { id: "contrast", label: "Contrast", min: 0.5, max: 1.5, step: 0.01, defaultValue: 1 },
      { id: "saturation", label: "Saturation", min: 0, max: 2, step: 0.01, defaultValue: 1 }
    ]
  },
  {
    id: "fog",
    label: "Fog",
    description: "Screen-space fog that thickens toward the chosen horizon.",
    hasColor: true,
    params: [
      { id: "density", label: "Density", min: 0, max: 1, step: 0.01, defaultValue: 0.35 },
      { id: "horizon", label: "Horizon", min: 0, max: 1, step: 0.01, defaultValue: 0.4 }
    ]
  },
  {
    id: "bloom",
    label: "Bloom",
    description: "Bright pixels glow past their edges.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1.5, step: 0.01, defaultValue: 0.6 },
      // Max stays below 1: the shader's smoothstep(threshold, 1.0, …) needs edge0 < edge1.
      { id: "threshold", label: "Threshold", min: 0, max: 0.95, step: 0.01, defaultValue: 0.6 }
    ]
  },
  {
    id: "crt",
    label: "CRT",
    description: "Barrel curvature and scanlines, like a tube television.",
    params: [
      { id: "curvature", label: "Curvature", min: 0, max: 0.25, step: 5e-3, defaultValue: 0.08 },
      { id: "scanlines", label: "Scanlines", min: 0, max: 1, step: 0.01, defaultValue: 0.35 }
    ]
  },
  {
    id: "chroma",
    label: "Chromatic aberration",
    description: "Red/blue fringing that grows toward the frame edge.",
    params: [{ id: "amount", label: "Amount", min: 0, max: 3, step: 0.05, defaultValue: 1 }]
  },
  {
    id: "vignette",
    label: "Vignette",
    description: "Darkens the corners of the frame.",
    params: [{ id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.35 }]
  },
  {
    id: "posterize",
    label: "Posterize",
    description: "Quantises colours to a fixed number of levels.",
    params: [{ id: "levels", label: "Levels", min: 2, max: 16, step: 1, defaultValue: 4 }]
  }
];
function paramKey(effect, param) {
  return `${effect}.${param}`;
}
var DEFAULT_FOG_COLOR = "#9db4c8";
function defaultPostFxSettings() {
  const enabled = {};
  const values = {};
  for (const effect of POST_FX_EFFECTS) {
    enabled[effect.id] = false;
    for (const param of effect.params) {
      values[paramKey(effect.id, param.id)] = param.defaultValue;
    }
  }
  return { enabled, values, fogColor: DEFAULT_FOG_COLOR };
}
function anyPostFxEnabled(settings) {
  return POST_FX_EFFECTS.some((effect) => settings.enabled[effect.id]);
}
function parsePostFxSettings(value) {
  if (typeof value !== "object" || value === null) return null;
  const record = value;
  const rawEnabled = record.enabled;
  const rawValues = record.values;
  if (typeof rawEnabled !== "object" || rawEnabled === null) return null;
  if (typeof rawValues !== "object" || rawValues === null) return null;
  const settings = defaultPostFxSettings();
  for (const effect of POST_FX_EFFECTS) {
    const enabled = rawEnabled[effect.id];
    if (typeof enabled === "boolean") settings.enabled[effect.id] = enabled;
    for (const param of effect.params) {
      const key = paramKey(effect.id, param.id);
      const raw = rawValues[key];
      if (typeof raw === "number" && Number.isFinite(raw)) {
        settings.values[key] = Math.min(param.max, Math.max(param.min, raw));
      }
    }
  }
  if (typeof record.fogColor === "string" && /^#[0-9a-fA-F]{6}$/.test(record.fogColor)) {
    settings.fogColor = record.fogColor;
  }
  return settings;
}
function hexToRgb01(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}
function uniformsFromSettings(settings) {
  const value = (effect, param, neutral) => settings.enabled[effect] ? settings.values[paramKey(effect, param)] ?? neutral : neutral;
  return {
    brightness: value("grade", "brightness", 1),
    contrast: value("grade", "contrast", 1),
    saturation: value("grade", "saturation", 1),
    fogDensity: value("fog", "density", 0),
    fogHorizon: settings.values[paramKey("fog", "horizon")] ?? 0.4,
    fogColor: hexToRgb01(settings.fogColor),
    bloomStrength: value("bloom", "strength", 0),
    bloomThreshold: settings.values[paramKey("bloom", "threshold")] ?? 0.6,
    curvature: value("crt", "curvature", 0),
    scanlines: value("crt", "scanlines", 0),
    aberration: value("chroma", "amount", 0),
    vignette: value("vignette", "strength", 0),
    posterize: settings.enabled.posterize ? settings.values[paramKey("posterize", "levels")] ?? 4 : 0
  };
}

// src/fx/PostFxSurface.ts
var MAX_RENDER_SCALE = 3;
var MAX_RENDER_WIDTH = 1280;
var PostFxSurface = class _PostFxSurface {
  constructor(container, scaleMode, model, inner, innerCanvas, canvas, pass, settings) {
    this.container = container;
    this.scaleMode = scaleMode;
    this.model = model;
    this.inner = inner;
    this.innerCanvas = innerCanvas;
    this.canvas = canvas;
    this.pass = pass;
    this.uniforms = uniformsFromSettings(settings);
    this.canvas.style.imageRendering = "pixelated";
    this.canvas.style.display = "block";
    this.canvas.style.margin = "auto";
    container.appendChild(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);
    this.applyScale();
  }
  /**
   * Builds the FX surface, or returns null when post-processing cannot run
   * (the caller should then mount the inner surface directly). The inner
   * factory is only invoked once the FX pass itself is viable.
   */
  static async create(container, scaleMode, model, settings, makeInner) {
    const document = container.ownerDocument;
    const canvas = document.createElement("canvas");
    const renderScale = Math.max(1, Math.min(MAX_RENDER_SCALE, Math.floor(MAX_RENDER_WIDTH / model.width)));
    canvas.width = model.width * renderScale;
    canvas.height = model.height * renderScale;
    const pass = PostFxPass.create(canvas);
    if (!pass) return null;
    const innerContainer = document.createElement("div");
    const inner = await makeInner(innerContainer);
    const innerCanvas = innerContainer.querySelector("canvas");
    if (!innerCanvas) {
      inner.destroy();
      pass.dispose();
      return null;
    }
    return new _PostFxSurface(container, scaleMode, model, inner, innerCanvas, canvas, pass, settings);
  }
  /** Swap the effect stack without rebuilding the pipeline. */
  setSettings(settings) {
    this.uniforms = uniformsFromSettings(settings);
  }
  blit(rgba) {
    this.inner.blit(rgba);
    this.pass.render(this.innerCanvas, this.model.width, this.model.height, this.uniforms);
  }
  destroy() {
    this.resizeObserver.disconnect();
    this.pass.dispose();
    this.canvas.remove();
    this.inner.destroy();
  }
  applyScale() {
    const { width, height } = computeScaledSize(
      this.container.clientWidth,
      this.container.clientHeight,
      this.model.width,
      this.model.height,
      this.scaleMode
    );
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }
};

// src/models.ts
var MODELS = {
  classic: {
    id: "classic",
    label: "Classic",
    kind: "raster2d",
    width: 240,
    height: 136,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 2,
    sampleRate: 44100,
    paletteSize: 16,
    cartSizeBytes: 64 * 1024,
    engineUrl: "/engine/classic/tic80.js",
    inputs: ["gamepad", "mouse", "keyboard"]
  },
  pro: {
    id: "pro",
    label: "Pro",
    kind: "raster2d",
    // 16:9 (640x360): scales to 1080p at exact 3x and 4K at 6x. Big enough that a
    // Classic cart (240x136) composites at pixel-perfect integer 2x (480x272)
    // pillarboxed inside with even 80px side / 44px top-bottom margins, rather
    // than being non-integer-scaled to fit. Both dimensions divide the 8px tile
    // grid (80x45 cells).
    width: 640,
    height: 360,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    // 64-color authoring palette (editor-enforced), 4x Classic's 16. The pro core's
    // framebuffer is 8bpp/256-capable (6bpp is not byte-aligned; see the engine
    // build note), so 64 is the creative limit, not a hardware cap.
    paletteSize: 64,
    cartSizeBytes: 1024 * 1024,
    engineUrl: "/engine/pro/engine.js",
    inputs: ["gamepad", "mouse", "keyboard"]
  },
  voxel: {
    id: "voxel",
    label: "Voxel",
    kind: "voxel3d",
    width: 320,
    height: 180,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    paletteSize: 256,
    cartSizeBytes: 2 * 1024 * 1024,
    engineUrl: "/engine/voxel/engine.js",
    inputs: ["gamepad", "mouse"]
  }
};
var DEFAULT_MODEL_ID = "classic";
function getModel(id = DEFAULT_MODEL_ID) {
  const model = MODELS[id];
  if (!model) {
    throw new Error(`Unknown console model: ${id}`);
  }
  return model;
}
function framebufferBytes(model) {
  return model.width * model.height * model.pixelBytes;
}
function frameDurationMs(model) {
  return 1e3 / model.fps;
}

// src/engine.ts
var moduleCache = /* @__PURE__ */ new Map();
async function loadEngineModule(engineUrl) {
  const cached = moduleCache.get(engineUrl);
  if (cached) {
    return cached;
  }
  const pending = import(
    /* @vite-ignore */
    /* webpackIgnore: true */
    engineUrl
  ).then((glue) => glue.default()).catch((error) => {
    moduleCache.delete(engineUrl);
    throw error;
  });
  moduleCache.set(engineUrl, pending);
  return pending;
}
function createConsole(module, model, sampleRate = model.sampleRate) {
  const handle = module._cbx_create(sampleRate);
  if (handle === 0) {
    throw new Error("Engine failed to create a console instance");
  }
  const frameBytes = framebufferBytes(model);
  return {
    loadCartridge(bytes) {
      const ptr = module._malloc(bytes.byteLength);
      try {
        module.HEAPU8.set(bytes, ptr);
        return module._cbx_load(handle, ptr, bytes.byteLength) === 1;
      } finally {
        module._free(ptr);
      }
    },
    tick(gamepadMask) {
      module._cbx_tick(handle, gamepadMask);
    },
    readFramebuffer() {
      const ptr = module._cbx_screen_ptr(handle);
      return module.HEAPU8.subarray(ptr, ptr + frameBytes);
    },
    readAudioSamples() {
      const count = module._cbx_samples_count(handle);
      if (count === 0) {
        return new Int16Array(0);
      }
      const ptr = module._cbx_samples_ptr(handle);
      const start = ptr / Int16Array.BYTES_PER_ELEMENT;
      return module.HEAP16.slice(start, start + count);
    },
    readMailbox() {
      const ptr = module._cbx_mailbox_ptr(handle);
      const words = module._cbx_mailbox_words(handle);
      if (ptr === 0 || words === 0) {
        return new Uint32Array(0);
      }
      return new Uint32Array(module.HEAPU8.buffer, ptr, words).slice();
    },
    dispose() {
      module._cbx_delete(handle);
    }
  };
}

// src/types.ts
var ConsoleButton = /* @__PURE__ */ ((ConsoleButton2) => {
  ConsoleButton2[ConsoleButton2["Up"] = 0] = "Up";
  ConsoleButton2[ConsoleButton2["Down"] = 1] = "Down";
  ConsoleButton2[ConsoleButton2["Left"] = 2] = "Left";
  ConsoleButton2[ConsoleButton2["Right"] = 3] = "Right";
  ConsoleButton2[ConsoleButton2["A"] = 4] = "A";
  ConsoleButton2[ConsoleButton2["B"] = 5] = "B";
  ConsoleButton2[ConsoleButton2["X"] = 6] = "X";
  ConsoleButton2[ConsoleButton2["Y"] = 7] = "Y";
  return ConsoleButton2;
})(ConsoleButton || {});

// src/input.ts
var DEFAULT_KEY_BINDINGS = {
  ArrowUp: 0 /* Up */,
  ArrowDown: 1 /* Down */,
  ArrowLeft: 2 /* Left */,
  ArrowRight: 3 /* Right */,
  KeyZ: 4 /* A */,
  KeyX: 5 /* B */,
  KeyA: 6 /* X */,
  KeyS: 7 /* Y */
};
function resolveButton(keyCode, bindings = DEFAULT_KEY_BINDINGS) {
  return bindings[keyCode];
}
var GamepadState = class {
  constructor() {
    this.mask = 0;
  }
  press(button) {
    this.mask |= 1 << button;
  }
  release(button) {
    this.mask &= ~(1 << button);
  }
  /** The engine-facing bitmask for player one. */
  get value() {
    return this.mask;
  }
  reset() {
    this.mask = 0;
  }
};
var KeyboardInput = class {
  constructor(target, state, bindings = DEFAULT_KEY_BINDINGS) {
    this.target = target;
    this.onKeyDown = (event) => {
      const button = resolveButton(event.code, bindings);
      if (button !== void 0) {
        state.press(button);
        event.preventDefault();
      }
    };
    this.onKeyUp = (event) => {
      const button = resolveButton(event.code, bindings);
      if (button !== void 0) {
        state.release(button);
      }
    };
    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
  }
  destroy() {
    this.target.removeEventListener("keydown", this.onKeyDown);
    this.target.removeEventListener("keyup", this.onKeyUp);
  }
};
var TouchInput = class {
  constructor(container, state) {
    const doc = container.ownerDocument;
    this.root = doc.createElement("div");
    this.root.setAttribute("data-cbx-touch", "");
    const directions = [
      ["\u2191", 0 /* Up */],
      ["\u2193", 1 /* Down */],
      ["\u2190", 2 /* Left */],
      ["\u2192", 3 /* Right */]
    ];
    const actions = [
      ["A", 4 /* A */],
      ["B", 5 /* B */]
    ];
    for (const [label, button] of [...directions, ...actions]) {
      this.root.appendChild(this.createButton(doc, label, button, state));
    }
    container.appendChild(this.root);
  }
  createButton(doc, label, button, state) {
    const element = doc.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.setAttribute("data-cbx-button", ConsoleButton[button]);
    const press = (event) => {
      event.preventDefault();
      state.press(button);
    };
    const release = (event) => {
      event.preventDefault();
      state.release(button);
    };
    element.addEventListener("touchstart", press, { passive: false });
    element.addEventListener("touchend", release);
    element.addEventListener("touchcancel", release);
    return element;
  }
  destroy() {
    this.root.remove();
  }
};

// src/replay.ts
var REPLAY_VERSION = 1;
var DEFAULT_SEED = 0;
function randomSeed() {
  return Math.floor(Math.random() * 2147483647);
}
var ReplayError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ReplayError";
  }
};
var ReplayRecorder = class {
  // sentinel: guarantees frame 0 is always recorded
  constructor(meta) {
    this.meta = meta;
    this.inputs = [];
    this.frame = 0;
    this.lastMask = -1;
  }
  record(mask) {
    if (mask !== this.lastMask) {
      this.inputs.push({ frame: this.frame, mask });
      this.lastMask = mask;
    }
    this.frame++;
  }
  get frameCount() {
    return this.frame;
  }
  /** Produces the immutable replay captured so far. */
  finish() {
    return {
      version: REPLAY_VERSION,
      modelId: this.meta.modelId,
      cartHash: this.meta.cartHash,
      seed: this.meta.seed ?? DEFAULT_SEED,
      frameCount: this.frame,
      inputs: this.inputs.map((change) => ({ ...change }))
    };
  }
};
var ReplaySource = class {
  constructor(inputs) {
    this.inputs = inputs;
    this.cursor = 0;
    this.currentMask = 0;
    this.lastFrame = -1;
  }
  /** The gamepad mask effective at the given frame. */
  maskForFrame(frame) {
    if (frame < this.lastFrame) {
      this.cursor = 0;
      this.currentMask = 0;
    }
    this.lastFrame = frame;
    while (this.cursor < this.inputs.length) {
      const change = this.inputs[this.cursor];
      if (!change || change.frame > frame) {
        break;
      }
      this.currentMask = change.mask;
      this.cursor++;
    }
    return this.currentMask;
  }
};
function hashCart(bytes) {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function serializeReplay(replay) {
  return JSON.stringify(replay);
}
function parseReplay(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new ReplayError("Replay is not valid JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new ReplayError("Replay must be an object");
  }
  const candidate = value;
  if (candidate.version !== REPLAY_VERSION) {
    throw new ReplayError(`Unsupported replay version: ${String(candidate.version)}`);
  }
  if (typeof candidate.cartHash !== "string" || !Array.isArray(candidate.inputs)) {
    throw new ReplayError("Replay is missing required fields");
  }
  return candidate;
}

// src/cartseed.ts
var CHUNK_CODE = 5;
var MAX_CHUNK_SIZE = 65535;
function locateCodeChunk(bytes) {
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const headerByte0 = bytes[offset] ?? 0;
    const type = headerByte0 & 31;
    const size = (bytes[offset + 1] ?? 0) | (bytes[offset + 2] ?? 0) << 8;
    const dataStart = offset + 4;
    const dataEnd = dataStart + size;
    if (type === CHUNK_CODE && size > 0 && dataEnd <= bytes.length) {
      return { headerStart: offset, dataStart, dataEnd, headerByte0, reserved: bytes[offset + 3] ?? 0 };
    }
    offset = dataEnd;
  }
  return null;
}
function detectLanguage(code) {
  const firstLine = code.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/script:\s*([a-z0-9]+)/i);
  return match?.[1]?.toLowerCase() ?? "lua";
}
function readCartCode(bytes) {
  const chunk = locateCodeChunk(bytes);
  if (!chunk) {
    return null;
  }
  return new TextDecoder().decode(bytes.subarray(chunk.dataStart, chunk.dataEnd));
}
function prependLuaCode(bytes, prelude) {
  const chunk = locateCodeChunk(bytes);
  if (!chunk) {
    return bytes;
  }
  const code = new TextDecoder().decode(bytes.subarray(chunk.dataStart, chunk.dataEnd));
  if (detectLanguage(code) !== "lua") {
    return bytes;
  }
  const merged = `${prelude}
${code}`;
  const mergedData = new TextEncoder().encode(merged);
  if (mergedData.length > MAX_CHUNK_SIZE) {
    return bytes;
  }
  const before = bytes.subarray(0, chunk.headerStart);
  const after = bytes.subarray(chunk.dataEnd);
  const header = new Uint8Array([
    chunk.headerByte0,
    mergedData.length & 255,
    mergedData.length >> 8 & 255,
    chunk.reserved
  ]);
  const out = new Uint8Array(before.length + header.length + mergedData.length + after.length);
  out.set(before, 0);
  out.set(header, before.length);
  out.set(mergedData, before.length + header.length);
  out.set(after, before.length + header.length + mergedData.length);
  return out;
}
function seedCartridge(bytes, seed) {
  return prependLuaCode(bytes, `math.randomseed(${Math.trunc(seed)})`);
}

// src/sdk.ts
var CARTBOX_SDK_LUA = `local _MB = 192
local _CAP = 8
local _LB = _MB + 25
local _LCAP = 6
local _ln = 0
local function _emit(kind, id, value)
  local seq = pmem(_MB)
  local slot = seq % _CAP
  local base = _MB + 1 + slot * 3
  pmem(base, kind)
  pmem(base + 1, id)
  pmem(base + 2, value)
  pmem(_MB, seq + 1)
end
local function _hash(s)
  local h = 2166136261
  for i = 1, #s do
    h = ((h ~ string.byte(s, i)) * 16777619) & 0xffffffff
  end
  return h
end
cartbox = {
  unlock = function(id) _emit(1, _hash(id), 0) end,
  score = function(v) _emit(2, 0, v // 1) end,
  progress = function(id, v) _emit(3, _hash(id), v // 1) end,
  clearlights = function() _ln = 0 pmem(_LB, 0) end,
  light = function(x, y, radius, r, g, b, z, intensity)
    if _ln >= _LCAP then return end
    local base = _LB + 1 + _ln * 6
    pmem(base, x // 1)
    pmem(base + 1, y // 1)
    pmem(base + 2, (z or 12) // 1)
    pmem(base + 3, radius // 1)
    local rr = (r or 255) & 0xff
    local gg = (g or 255) & 0xff
    local bb = (b or 255) & 0xff
    pmem(base + 4, (rr << 16) | (gg << 8) | bb)
    pmem(base + 5, ((intensity or 1) * 256) // 1)
    _ln = _ln + 1
    pmem(_LB, _ln)
  end,
}`;
function injectSdk(bytes) {
  return prependLuaCode(bytes, CARTBOX_SDK_LUA);
}

// src/mailbox.ts
var MAILBOX_TYPE_ACHIEVEMENT = 1;
var MAILBOX_TYPE_SCORE = 2;
var MAILBOX_TYPE_PROGRESS = 3;
var MAILBOX_WORDS = 64;
var EVENT_CAPACITY = 8;
var LIGHTS_BASE = 1 + EVENT_CAPACITY * 3;
var LIGHTS_CAPACITY = 6;
var LIGHT_STRIDE = 6;
var LIGHT_INTENSITY_SCALE = 256;
function kindOf(type) {
  switch (type) {
    case MAILBOX_TYPE_ACHIEVEMENT:
      return "achievement";
    case MAILBOX_TYPE_SCORE:
      return "score";
    case MAILBOX_TYPE_PROGRESS:
      return "progress";
    default:
      return "unknown";
  }
}
function decodeMailbox(words, lastSeq) {
  const seq = words[0] ?? 0;
  const capacity = words.length > 0 ? EVENT_CAPACITY : 0;
  if (capacity === 0 || seq <= lastSeq) {
    return { events: [], seq };
  }
  const start = Math.max(lastSeq, seq - capacity);
  const events = [];
  for (let i = start; i < seq; i++) {
    const slot = i % capacity;
    const base = 1 + slot * 3;
    const type = words[base] ?? 0;
    events.push({
      type,
      kind: kindOf(type),
      id: words[base + 1] ?? 0,
      value: words[base + 2] ?? 0
    });
  }
  return { events, seq };
}
function decodeLights(words) {
  if (words.length <= LIGHTS_BASE) {
    return [];
  }
  const count = Math.min(words[LIGHTS_BASE] ?? 0, LIGHTS_CAPACITY);
  const lights = [];
  for (let i = 0; i < count; i++) {
    const base = LIGHTS_BASE + 1 + i * LIGHT_STRIDE;
    const packed = words[base + 4] ?? 16777215;
    const intensity = (words[base + 5] ?? LIGHT_INTENSITY_SCALE) / LIGHT_INTENSITY_SCALE;
    lights.push({
      x: words[base] ?? 0,
      y: words[base + 1] ?? 0,
      z: words[base + 2] ?? 0,
      radius: words[base + 3] ?? 0,
      color: [
        (packed >>> 16 & 255) / 255 * intensity,
        (packed >>> 8 & 255) / 255 * intensity,
        (packed & 255) / 255 * intensity
      ]
    });
  }
  return lights;
}
function hashEventId(id) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash ^ id.charCodeAt(i)) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

// src/player.ts
function shouldUseTouch(scheme, view) {
  if (scheme === "touch") return true;
  if (scheme === "keyboard") return false;
  return view.matchMedia?.("(pointer: coarse)").matches ?? false;
}
var Player = class {
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this.gamepad = new GamepadState();
    this.tickFrame = 0;
    this.lastMailboxSeq = 0;
    this.frameHandle = 0;
    this.lastFrameTime = 0;
    this.frameAccumulatorMs = 0;
    this.destroyed = false;
    this.abortController = new AbortController();
    this.running = false;
    /**
     * Fixed-timestep loop: advance one console frame per 1/60s of elapsed time.
     * Decoupling console frames from the display refresh keeps game speed correct
     * on 120Hz+ screens and after the tab was backgrounded.
     */
    this.loop = (now) => {
      if (!this.running) return;
      this.frameAccumulatorMs += now - this.lastFrameTime;
      this.lastFrameTime = now;
      const maxFramesPerRender = 4;
      const frameMs = frameDurationMs(this.model);
      let advanced = 0;
      while (this.frameAccumulatorMs >= frameMs && advanced < maxFramesPerRender) {
        this.tickOnce();
        this.frameAccumulatorMs -= frameMs;
        advanced++;
      }
      if (advanced > 0) {
        this.present();
      }
      this.frameHandle = this.view.requestAnimationFrame(this.loop);
    };
    const view = container.ownerDocument.defaultView;
    if (!view) {
      throw new Error("Container is not attached to a window");
    }
    this.view = view;
    this.model = getModel(options.modelId);
  }
  /** Loads the cartridge and engine, then starts (or arms) playback. */
  async start() {
    try {
      const engineUrl = this.options.engineUrl ?? this.model.engineUrl;
      const [bytes, module] = await Promise.all([
        fetchCartridge(this.options.cartUrl, this.abortController.signal),
        loadEngineModule(engineUrl)
      ]);
      if (this.destroyed) return;
      const sampleRate = this.options.sampleRate ?? this.model.sampleRate;
      const seed = this.options.replay ? this.options.replay.seed : randomSeed();
      const preparedBytes = injectSdk(seedCartridge(bytes, seed));
      this.console = createConsole(module, this.model, sampleRate);
      if (!this.console.loadCartridge(preparedBytes)) {
        throw new Error("Engine rejected the cartridge");
      }
      this.lastMailboxSeq = this.console.readMailbox()[0] ?? 0;
      const scale = this.options.scale ?? "fit";
      const makeBaseSurface = async (target) => {
        if (this.options.lighting) {
          this.litSurface = await LitCanvasSurface.create(target, scale, this.model, this.options.lighting);
          return this.litSurface;
        }
        return new CanvasSurface(target, scale, this.model);
      };
      const postFx = this.options.postFx;
      if (postFx && anyPostFxEnabled(postFx)) {
        this.surface = await PostFxSurface.create(this.container, scale, this.model, postFx, makeBaseSurface) ?? await makeBaseSurface(this.container);
      } else {
        this.surface = await makeBaseSurface(this.container);
      }
      if (this.destroyed) {
        this.surface.destroy();
        return;
      }
      this.audio = new AudioController(sampleRate);
      this.setupReplay(bytes, seed);
      this.renderSingleFrame();
      this.options.onReady?.();
      if (this.options.autostart ?? false) {
        void this.resume();
      }
    } catch (error) {
      if (this.destroyed) return;
      this.fail(error);
    }
  }
  attachInput() {
    if (shouldUseTouch(this.options.controls ?? "auto", this.view)) {
      this.touch = new TouchInput(this.container, this.gamepad);
    } else {
      this.keyboard = new KeyboardInput(this.view, this.gamepad);
    }
  }
  /**
   * Chooses the input source. In playback mode the console is driven by the
   * replay and no user input is attached; otherwise live input is attached and
   * (unless disabled) the session is recorded.
   */
  setupReplay(cartBytes, seed) {
    if (this.options.replay) {
      this.replaySource = new ReplaySource(this.options.replay.inputs);
      return;
    }
    this.attachInput();
    if (this.options.record !== false) {
      this.recorder = new ReplayRecorder({
        modelId: this.model.id,
        cartHash: hashCart(cartBytes),
        seed
      });
    }
  }
  /** The replay captured so far, or null when not recording. */
  getReplay() {
    return this.recorder ? this.recorder.finish() : null;
  }
  async resume() {
    if (this.running || this.destroyed || !this.console) return;
    this.running = true;
    this.lastFrameTime = this.view.performance.now();
    this.frameAccumulatorMs = 0;
    this.frameHandle = this.view.requestAnimationFrame(this.loop);
    try {
      await this.audio?.resume();
    } catch {
    }
  }
  pause() {
    if (!this.running) return;
    this.running = false;
    this.view.cancelAnimationFrame(this.frameHandle);
    this.gamepad.reset();
    void this.audio?.pause();
  }
  tickOnce() {
    const mask = this.replaySource ? this.replaySource.maskForFrame(this.tickFrame) : this.gamepad.value;
    this.console?.tick(mask);
    this.recorder?.record(mask);
    this.tickFrame++;
    this.pollEvents();
    const samples = this.console?.readAudioSamples();
    if (samples && samples.length > 0) {
      this.audio?.enqueue(samples);
    }
  }
  /** Reads any platform events the cart emitted this frame and dispatches them. */
  pollEvents() {
    const onEvent = this.options.onEvent;
    if (!onEvent || !this.console) {
      return;
    }
    const { events, seq } = decodeMailbox(this.console.readMailbox(), this.lastMailboxSeq);
    this.lastMailboxSeq = seq;
    for (const event of events) {
      onEvent(event);
    }
  }
  present() {
    const framebuffer = this.console?.readFramebuffer();
    if (framebuffer) {
      if (this.litSurface && this.console) {
        this.litSurface.setCartLights(decodeLights(this.console.readMailbox()));
      }
      this.surface?.blit(framebuffer);
    }
  }
  renderSingleFrame() {
    this.tickOnce();
    this.present();
  }
  fail(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(normalized);
    this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;
    this.abortController.abort();
    this.view.cancelAnimationFrame(this.frameHandle);
    this.keyboard?.destroy();
    this.touch?.destroy();
    this.audio?.destroy();
    this.surface?.destroy();
    this.console?.dispose();
  }
};

// src/verify.ts
function runReplayEvents(console2, replay) {
  const source = new ReplaySource(replay.inputs);
  let lastSeq = decodeMailbox(console2.readMailbox(), 0).seq;
  const events = [];
  for (let frame = 0; frame < replay.frameCount; frame++) {
    console2.tick(source.maskForFrame(frame));
    const read = decodeMailbox(console2.readMailbox(), lastSeq);
    lastSeq = read.seq;
    events.push(...read.events);
  }
  return events;
}
function extractScore(events) {
  let best = null;
  for (const event of events) {
    if (event.kind === "score") {
      best = best === null ? event.value : Math.max(best, event.value);
    }
  }
  return best;
}
function extractUnlocks(events) {
  const ids = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.kind === "achievement") {
      ids.add(event.id);
    }
  }
  return [...ids];
}
function verifyReplayScore(console2, replay, claimedScore) {
  const events = runReplayEvents(console2, replay);
  const score = extractScore(events);
  return {
    score,
    unlocks: extractUnlocks(events),
    verified: score !== null && score === claimedScore
  };
}

// src/achievements.ts
function resolveUnlockedAchievements(unlockHashes, registered) {
  const unlocked = new Set(unlockHashes.map((hash) => hash >>> 0));
  return registered.filter((achievement) => unlocked.has(achievement.hash >>> 0));
}

// src/index.ts
function mount(container, options) {
  const player = new Player(container, options);
  void player.start();
  return {
    pause: () => player.pause(),
    resume: () => void player.resume(),
    destroy: () => player.destroy(),
    getReplay: () => player.getReplay(),
    get running() {
      return player.running;
    }
  };
}
export {
  CARTBOX_SDK_LUA,
  CartridgeLoadError,
  ConsoleButton,
  DEFAULT_MODEL_ID,
  EVENT_CAPACITY,
  LIGHTS_BASE,
  LIGHTS_CAPACITY,
  LIGHT_STRIDE,
  LightingLayer,
  LitCanvasSurface,
  MAILBOX_TYPE_ACHIEVEMENT,
  MAILBOX_TYPE_PROGRESS,
  MAILBOX_TYPE_SCORE,
  MAILBOX_WORDS,
  MODELS,
  NORMAL_DIRECTION_COUNT,
  NORMAL_VECTORS,
  POST_FX_EFFECTS,
  PostFxPass,
  PostFxSurface,
  REPLAY_VERSION,
  ReplayError,
  ReplayRecorder,
  ReplaySource,
  WebgpuLightingLayer,
  anyPostFxEnabled,
  createConsole,
  createFlatMaterial,
  createLightingLayer,
  decodeLights,
  decodeMailbox,
  defaultPostFxSettings,
  extractScore,
  extractUnlocks,
  frameDurationMs,
  framebufferBytes,
  getModel,
  getWebgpuDevice,
  hashCart,
  hashEventId,
  hexToRgb01,
  injectSdk,
  loadEngineModule,
  mount,
  nearestDirection,
  normalVector,
  paramKey,
  parsePostFxSettings,
  parseReplay,
  randomSeed,
  readCartCode,
  resolveUnlockedAchievements,
  runReplayEvents,
  seedCartridge,
  serializeReplay,
  shade,
  uniformsFromSettings,
  verifyReplayScore
};
