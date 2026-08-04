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
function interpolateNormal(corner00, corner10, corner01, corner11, fractionX, fractionY) {
  const lerp4 = (a, b, t) => a + (b - a) * t;
  const top = [
    lerp4(corner00[0], corner10[0], fractionX),
    lerp4(corner00[1], corner10[1], fractionX),
    lerp4(corner00[2], corner10[2], fractionX)
  ];
  const bottom = [
    lerp4(corner01[0], corner11[0], fractionX),
    lerp4(corner01[1], corner11[1], fractionX),
    lerp4(corner01[2], corner11[2], fractionX)
  ];
  return normalize([
    lerp4(top[0], bottom[0], fractionY),
    lerp4(top[1], bottom[1], fractionY),
    lerp4(top[2], bottom[2], fractionY)
  ]);
}
function sampleNormalBilinear(indexAt, sampleX, sampleY) {
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const fractionX = sampleX - x0;
  const fractionY = sampleY - y0;
  return interpolateNormal(
    normalVector(indexAt(x0, y0)),
    normalVector(indexAt(x0 + 1, y0)),
    normalVector(indexAt(x0, y0 + 1)),
    normalVector(indexAt(x0 + 1, y0 + 1)),
    fractionX,
    fractionY
  );
}
var LIGHT_KIND_CODE = { point: 0, directional: 1, spot: 2 };
var DEFAULT_LIGHT_DIRECTION = [0, 0, 1];
var DEFAULT_SPOT_CONE_COS = 0.9;
function shade(albedo, normal, toLight, ambient) {
  const n = normalize(normal);
  const l = normalize(toLight);
  const diffuse = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
  const intensity = ambient + (1 - ambient) * diffuse;
  const clamp4 = (value) => Math.max(0, Math.min(255, Math.round(value * intensity)));
  return [clamp4(albedo[0]), clamp4(albedo[1]), clamp4(albedo[2])];
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
uniform float uLightKind[${MAX_LIGHTS}];   // 0 point, 1 directional, 2 spot
uniform vec3 uLightDir[${MAX_LIGHTS}];     // directional: toward light; spot: beam axis
uniform float uLightCone[${MAX_LIGHTS}];   // spot inner-cone cosine
uniform int uLightCount;
uniform float uAmbient;
uniform vec3 uAmbientColor;
uniform vec2 uResolution;
uniform float uEnableShadows;
uniform float uSmoothNormals;
uniform int uUnlit;

const float HMAX = ${HEIGHT_MAX.toFixed(1)};
const vec3 VIEW = vec3(0.0, -0.34, 0.94);

vec3 normalFor(float idxF) {
  int idx = int(idxF + 0.5);
  vec3 n = vec3(0.0, 0.0, 1.0);
  for (int k = 0; k < 16; k++) { if (k == idx) n = uNormals[k]; }
  return n;
}

// The smoothed normal at a UV: bilinearly blend the decoded normals of the four
// surrounding material texels (interpolateNormal / sampleNormalBilinear in
// lightingModel.ts). Blends the vectors, never the indices \u2014 the palette is
// unordered \u2014 so the 16-facet banding melts to a continuous field. A uniform
// region returns that region's normal unchanged.
vec3 sampleNormalSmooth(vec2 uv) {
  vec2 texelSpace = uv * uResolution - 0.5;
  vec2 base = floor(texelSpace);
  vec2 f = texelSpace - base;
  vec2 inv = 1.0 / uResolution;
  vec3 n00 = normalFor(texture2D(uMat, (base + vec2(0.5, 0.5)) * inv).r * 255.0);
  vec3 n10 = normalFor(texture2D(uMat, (base + vec2(1.5, 0.5)) * inv).r * 255.0);
  vec3 n01 = normalFor(texture2D(uMat, (base + vec2(0.5, 1.5)) * inv).r * 255.0);
  vec3 n11 = normalFor(texture2D(uMat, (base + vec2(1.5, 1.5)) * inv).r * 255.0);
  return normalize(mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y));
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

// A directional light has no position, so its shadow marches a fixed number of
// pixel steps up the to-light direction, rising by the ray's slope each step.
float dirShadowFactor(vec2 px, float h0, vec3 toLight) {
  float len = length(toLight.xy);
  if (len < 0.05) return 1.0;              // key is overhead: no long shadow
  vec2 step = (toLight.xy / len) * 3.0;
  float slope = toLight.z / len;           // height gained per pixel toward the light
  for (int i = 1; i <= 16; i++) {
    float rayH = h0 + slope * float(i) * 3.0;
    if (heightAt(px + step * float(i)) > rayH + 0.45) return 0.25;
  }
  return 1.0;
}

void main() {
  vec4 alb = texture2D(uAlbedo, vUv);
  if (uUnlit == 1) { gl_FragColor = vec4(alb.rgb, 1.0); return; } // passthrough
  vec4 m = texture2D(uMat, vUv);
  vec3 n = uSmoothNormals > 0.5 ? sampleNormalSmooth(vUv) : normalFor(m.r * 255.0);
  float height = m.g * HMAX;
  float specStr = m.b;
  float rough = m.a;
  float emissive = alb.a;
  vec2 px = vUv * uResolution;

  float shininess = mix(6.0, 120.0, 1.0 - rough);
  vec3 lightSum = uAmbient * uAmbientColor;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    float kind = uLightKind[i];
    vec3 L;
    float atten;
    float shadow;
    if (kind > 0.5 && kind < 1.5) {
      // Directional: parallel rays toward uLightDir, no distance falloff.
      L = normalize(uLightDir[i]);
      atten = 1.0;
      shadow = uEnableShadows > 0.5 ? dirShadowFactor(px, height, L) : 1.0;
    } else {
      // Point and spot both radiate from a position.
      vec3 toLight = vec3(uLightPos[i].xy - px, uLightPos[i].z - height);
      float dist = length(toLight.xy);
      atten = clamp(1.0 - dist / uLightRadius[i], 0.0, 1.0);
      atten *= atten;
      L = normalize(toLight);
      shadow = uEnableShadows > 0.5 ? shadowFactor(px, height, uLightPos[i]) : 1.0;
      if (kind > 1.5) {
        // Spot: gate by how well the beam axis aligns with this pixel.
        vec3 axis = normalize(uLightDir[i]);
        vec3 beam = normalize(vec3(px - uLightPos[i].xy, height - uLightPos[i].z));
        float alignment = dot(beam, axis);
        float inner = uLightCone[i];
        float outer = inner - 0.15;        // matches SPOT_CONE_SOFTNESS
        atten *= clamp((alignment - outer) / max(1e-3, inner - outer), 0.0, 1.0);
      }
    }
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
    this.lightKind = new Float32Array(MAX_LIGHTS);
    this.lightDir = new Float32Array(MAX_LIGHTS * 3);
    this.lightCone = new Float32Array(MAX_LIGHTS);
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
      this.lightKind[i] = LIGHT_KIND_CODE[light.kind ?? "point"];
      const dir = light.direction ?? DEFAULT_LIGHT_DIRECTION;
      this.lightDir[i * 3] = dir[0];
      this.lightDir[i * 3 + 1] = dir[1];
      this.lightDir[i * 3 + 2] = dir[2];
      this.lightCone[i] = light.coneCos ?? DEFAULT_SPOT_CONE_COS;
    }
    gl.uniform3fv(this.uni(this.pLight, "uLightPos"), this.lightPos);
    gl.uniform3fv(this.uni(this.pLight, "uLightColor"), this.lightColor);
    gl.uniform1fv(this.uni(this.pLight, "uLightRadius"), this.lightRadius);
    gl.uniform1fv(this.uni(this.pLight, "uLightKind"), this.lightKind);
    gl.uniform3fv(this.uni(this.pLight, "uLightDir"), this.lightDir);
    gl.uniform1fv(this.uni(this.pLight, "uLightCone"), this.lightCone);
    gl.uniform1i(this.uni(this.pLight, "uLightCount"), count);
    gl.uniform1f(this.uni(this.pLight, "uAmbient"), scene.ambient);
    gl.uniform3f(this.uni(this.pLight, "uAmbientColor"), scene.ambientColor[0], scene.ambientColor[1], scene.ambientColor[2]);
    gl.uniform1f(this.uni(this.pLight, "uEnableShadows"), scene.shadows && material ? 1 : 0);
    gl.uniform1f(this.uni(this.pLight, "uSmoothNormals"), scene.smoothNormals ? 1 : 0);
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
  lightColor: array<vec4<f32>, ${MAX_LIGHTS2}>,    // xyz = colour, w = kind (0/1/2)
  lightDirCone: array<vec4<f32>, ${MAX_LIGHTS2}>,  // xyz = direction, w = spot cone cosine
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

fn dirShadowFactor(px: vec2<f32>, h0: f32, toLight: vec3<f32>) -> f32 {
  let len = length(toLight.xy);
  if (len < 0.05) { return 1.0; }            // key is overhead: no long shadow
  let step = (toLight.xy / len) * 3.0;
  let slope = toLight.z / len;
  for (var i = 1; i <= 16; i = i + 1) {
    let rayH = h0 + slope * f32(i) * 3.0;
    if (heightAt(px + step * f32(i)) > rayH + 0.45) { return 0.25; }
  }
  return 1.0;
}

// The decoded, normalised normal at a UV (nearest material texel).
fn normalIndexAt(uv: vec2<f32>) -> vec3<f32> {
  let idx = clamp(i32(textureSampleLevel(matTex, samp, uv, 0.0).r * 255.0 + 0.5), 0, 15);
  return normalize(u.normals[idx].xyz);
}

// Bilinearly blend the four surrounding texels' decoded normals \u2014 the WGSL twin
// of sampleNormalBilinear (lightingModel.ts). Blending vectors, not the unordered
// indices, melts the 16-facet banding to a smooth field (cinematic gap #2).
fn sampleNormalSmooth(uv: vec2<f32>) -> vec3<f32> {
  let res = u.dims.xy;
  let texelSpace = uv * res - vec2<f32>(0.5, 0.5);
  let base = floor(texelSpace);
  let f = texelSpace - base;
  let inv = vec2<f32>(1.0, 1.0) / res;
  let n00 = normalIndexAt((base + vec2<f32>(0.5, 0.5)) * inv);
  let n10 = normalIndexAt((base + vec2<f32>(1.5, 0.5)) * inv);
  let n01 = normalIndexAt((base + vec2<f32>(0.5, 1.5)) * inv);
  let n11 = normalIndexAt((base + vec2<f32>(1.5, 1.5)) * inv);
  return normalize(mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y));
}

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let alb = textureSampleLevel(albedoTex, samp, in.uv, 0.0);
  if (u.dims.w > 0.5) { return vec4<f32>(alb.rgb, 1.0); } // unlit passthrough
  let m = textureSampleLevel(matTex, samp, in.uv, 0.0);
  let idx = clamp(i32(m.r * 255.0 + 0.5), 0, 15);
  let n = select(normalize(u.normals[idx].xyz), sampleNormalSmooth(in.uv), u.flags.y > 0.5);
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
    let kind = u.lightColor[i].w;
    var L: vec3<f32>;
    var atten: f32;
    var shadow = 1.0;
    if (kind > 0.5 && kind < 1.5) {
      // Directional: parallel rays toward the stored direction, no falloff.
      L = normalize(u.lightDirCone[i].xyz);
      atten = 1.0;
      if (u.flags.x > 0.5) { shadow = dirShadowFactor(px, height, L); }
    } else {
      let toLight = vec3<f32>(lp.xy - px, lp.z - height);
      let dist = length(toLight.xy);
      atten = clamp(1.0 - dist / lp.w, 0.0, 1.0);
      atten = atten * atten;
      L = normalize(toLight);
      if (u.flags.x > 0.5) { shadow = shadowFactor(px, height, lp.xyz); }
      if (kind > 1.5) {
        // Spot: gate by the beam axis alignment with this pixel.
        let axis = normalize(u.lightDirCone[i].xyz);
        let beam = normalize(vec3<f32>(px - lp.xy, height - lp.z));
        let alignment = dot(beam, axis);
        let inner = u.lightDirCone[i].w;
        let outer = inner - 0.15;              // matches SPOT_CONE_SOFTNESS
        atten = atten * clamp((alignment - outer) / max(1e-3, inner - outer), 0.0, 1.0);
      }
    }
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
    this.lightData = new Float32Array(148);
    // matches LightU (592 bytes)
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
      const lightBuffer = uniform(592);
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
    u[9] = scene.smoothNormals ? 1 : 0;
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
      u[100 + i * 4 + 3] = LIGHT_KIND_CODE[light.kind ?? "point"];
      const dir = light.direction ?? DEFAULT_LIGHT_DIRECTION;
      u[124 + i * 4] = dir[0];
      u[124 + i * 4 + 1] = dir[1];
      u[124 + i * 4 + 2] = dir[2];
      u[124 + i * 4 + 3] = light.coneCos ?? DEFAULT_SPOT_CONE_COS;
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
    // The per-pixel material the engine emitted for this frame (same growable-buffer
    // caveat as the framebuffer, so it is copied into a stable buffer before upload).
    this.cartMaterial = null;
    this.cartMaterialCopy = null;
    // Per-pixel emissive (one byte each) the engine emitted this frame. Folded into
    // the albedo copy's alpha, which the shader reads as self-illumination.
    this.cartEmissive = null;
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
  /**
   * Sets the per-pixel material buffer the engine emitted for this frame's
   * sprites (RGBA: normal index, height, specular, roughness). Copied into a
   * stable buffer on {@link blit}; an empty buffer falls back to host material.
   */
  setCartMaterial(material) {
    this.cartMaterial = material.length ? material : null;
  }
  /**
   * Sets the per-pixel emissive plane (one byte each) the engine emitted this
   * frame. It is folded into the albedo copy's alpha channel on {@link blit},
   * which both lighting backends read as self-illumination. An empty buffer
   * leaves the framebuffer's own alpha untouched.
   */
  setCartEmissive(emissive) {
    this.cartEmissive = emissive.length ? emissive : null;
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
    if (this.cartEmissive && this.cartEmissive.length * 4 === this.albedoCopy.length) {
      for (let i = 0; i < this.cartEmissive.length; i += 1) {
        this.albedoCopy[i * 4 + 3] = this.cartEmissive[i] ?? 0;
      }
    }
    this.renderer.render(this.albedoCopy, material, {
      lights,
      ambient: this.options.ambient ?? DEFAULT_AMBIENT,
      ambientColor: this.options.ambientColor ?? DEFAULT_AMBIENT_COLOR,
      bloom: this.options.bloom ?? true,
      shadows: this.options.shadows ?? false,
      smoothNormals: this.options.smoothNormals ?? true,
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
    if (this.cartMaterial) {
      if (!this.cartMaterialCopy || this.cartMaterialCopy.length !== this.cartMaterial.length) {
        this.cartMaterialCopy = new Uint8Array(this.cartMaterial.length);
      }
      this.cartMaterialCopy.set(this.cartMaterial);
      return this.cartMaterialCopy;
    }
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

// src/fx/bloomModel.ts
var MIN_PYRAMID_DIMENSION = 4;
var MAX_PYRAMID_LEVELS = 6;
var BLOOM_KNEE = 0.5;
var EPSILON = 1e-4;
function pyramidLevelCount(width, height, maxLevels = MAX_PYRAMID_LEVELS) {
  let shorterSide = Math.min(width, height);
  let levels = 0;
  while (levels < maxLevels && Math.floor(shorterSide / 2) >= MIN_PYRAMID_DIMENSION) {
    shorterSide = Math.floor(shorterSide / 2);
    levels += 1;
  }
  return Math.max(1, levels);
}
function pyramidLevelSize(baseWidth, baseHeight, index) {
  const divisor = 2 ** (index + 1);
  return {
    width: Math.max(1, Math.floor(baseWidth / divisor)),
    height: Math.max(1, Math.floor(baseHeight / divisor))
  };
}
function softKneePrefilter(rgb, threshold, knee = BLOOM_KNEE) {
  const brightest = Math.max(rgb[0], rgb[1], rgb[2]);
  const kneeWidth = Math.max(knee, EPSILON);
  let soft = brightest - threshold + kneeWidth;
  soft = Math.min(Math.max(soft, 0), 2 * kneeWidth);
  soft = soft * soft / (4 * kneeWidth + EPSILON);
  const contribution = Math.max(soft, brightest - threshold) / Math.max(brightest, EPSILON);
  const clamped = Math.max(contribution, 0);
  return [rgb[0] * clamped, rgb[1] * clamped, rgb[2] * clamped];
}
function acesFilmicChannel(x) {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  const mapped = x * (a * x + b) / (x * (c * x + d) + e);
  return Math.min(Math.max(mapped, 0), 1);
}
function acesFilmic(rgb, exposure = 1) {
  return [
    acesFilmicChannel(rgb[0] * exposure),
    acesFilmicChannel(rgb[1] * exposure),
    acesFilmicChannel(rgb[2] * exposure)
  ];
}

// src/fx/BloomPyramid.ts
var VERTEX_SOURCE = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = (aPosition + 1.0) * 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;
var PREFILTER_SOURCE = `
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
var DOWNSAMPLE_SOURCE = `
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
var UPSAMPLE_SOURCE = `
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
var BloomPyramid = class _BloomPyramid {
  constructor(gl, quad, prefilter, downsample, upsample, textureType) {
    this.gl = gl;
    this.quad = quad;
    this.prefilter = prefilter;
    this.downsample = downsample;
    this.upsample = upsample;
    this.textureType = textureType;
    this.levels = [];
    this.baseWidth = 0;
    this.baseHeight = 0;
  }
  /** Whether the pyramid can hold light past 1.0 (true HDR) or clamps at it. */
  get isHdr() {
    return this.textureType !== this.gl.UNSIGNED_BYTE;
  }
  /**
   * Build the pyramid against an existing GL context, or return null if any
   * shader/buffer allocation fails. The context is shared with the owning pass;
   * this class only ever renders into its own framebuffers and leaves the
   * default framebuffer bound when it is done.
   */
  static create(gl) {
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
    return new _BloomPyramid(gl, quad, prefilter, downsample, upsample, detectTargetType(gl));
  }
  /**
   * Generate the bloom for one frame and return the finest pyramid level (a
   * half-resolution texture holding the accumulated glow), ready to be sampled
   * and added by the composite pass. Targets are reallocated only when the base
   * resolution changes, so steady-state playback allocates nothing.
   */
  generate(source, baseWidth, baseHeight, threshold, radius) {
    const gl = this.gl;
    if (baseWidth !== this.baseWidth || baseHeight !== this.baseHeight) {
      this.allocate(baseWidth, baseHeight);
    }
    if (this.levels.length === 0) return null;
    gl.disable(gl.BLEND);
    this.begin(this.prefilter, this.levels[0]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(this.prefilter.uniforms.get("uTex"), 0);
    gl.uniform2f(this.prefilter.uniforms.get("uSourceTexel"), 1 / baseWidth, 1 / baseHeight);
    gl.uniform1f(this.prefilter.uniforms.get("uThreshold"), threshold);
    gl.uniform1f(this.prefilter.uniforms.get("uKnee"), BLOOM_KNEE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    for (let index = 1; index < this.levels.length; index++) {
      const finer = this.levels[index - 1];
      this.begin(this.downsample, this.levels[index]);
      gl.bindTexture(gl.TEXTURE_2D, finer.texture);
      gl.uniform1i(this.downsample.uniforms.get("uTex"), 0);
      gl.uniform2f(this.downsample.uniforms.get("uTexel"), 1 / finer.width, 1 / finer.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let index = this.levels.length - 2; index >= 0; index--) {
      const coarser = this.levels[index + 1];
      this.begin(this.upsample, this.levels[index]);
      gl.bindTexture(gl.TEXTURE_2D, coarser.texture);
      gl.uniform1i(this.upsample.uniforms.get("uTex"), 0);
      gl.uniform2f(this.upsample.uniforms.get("uTexel"), 1 / coarser.width, 1 / coarser.height);
      gl.uniform1f(this.upsample.uniforms.get("uRadius"), radius);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.levels[0].texture;
  }
  dispose() {
    const gl = this.gl;
    this.freeLevels();
    gl.deleteBuffer(this.quad);
    gl.deleteProgram(this.prefilter.program);
    gl.deleteProgram(this.downsample.program);
    gl.deleteProgram(this.upsample.program);
  }
  /** Bind a program and its target framebuffer, and point the shared quad at the
   * program's attribute — GLSL ES 1.00 has no VAOs, so this repeats per draw. */
  begin(program, level) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, level.framebuffer);
    gl.viewport(0, 0, level.width, level.height);
    gl.useProgram(program.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(program.attribLocation);
    gl.vertexAttribPointer(program.attribLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
  }
  allocate(baseWidth, baseHeight) {
    this.freeLevels();
    this.baseWidth = baseWidth;
    this.baseHeight = baseHeight;
    const count = pyramidLevelCount(baseWidth, baseHeight);
    for (let index = 0; index < count; index++) {
      const { width, height } = pyramidLevelSize(baseWidth, baseHeight, index);
      const level = this.makeLevel(width, height);
      if (!level) break;
      this.levels.push(level);
    }
  }
  makeLevel(width, height) {
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
  freeLevels() {
    const gl = this.gl;
    for (const level of this.levels) {
      gl.deleteTexture(level.texture);
      gl.deleteFramebuffer(level.framebuffer);
    }
    this.levels = [];
  }
};
function buildProgram(gl, fragmentSource, uniformNames) {
  const compile = (type, source) => {
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
  const uniforms = /* @__PURE__ */ new Map();
  for (const name of uniformNames) uniforms.set(name, gl.getUniformLocation(program, name));
  return { program, attribLocation: gl.getAttribLocation(program, "aPosition"), uniforms };
}
function detectTargetType(gl) {
  const halfFloat = gl.getExtension("OES_texture_half_float");
  const halfFloatLinear = gl.getExtension("OES_texture_half_float_linear");
  const colorBufferHalfFloat = gl.getExtension("EXT_color_buffer_half_float");
  if (!halfFloat || !halfFloatLinear || !colorBufferHalfFloat) return gl.UNSIGNED_BYTE;
  const type = halfFloat.HALF_FLOAT_OES;
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

// src/fx/PostFxPass.ts
var VERTEX_SOURCE2 = `
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
// The multi-scale bloom the pyramid produces, and whether it is available: when
// it is not (no framebuffers/extensions) the shader falls back to an inline 3x3.
uniform sampler2D uBloomTex;
uniform float uHasBloomTex;
// HDR rolloff: uToneMap gates the ACES curve, uExposure scales into it.
uniform float uToneMap;
uniform float uExposure;
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
uniform float uReflectStrength;
uniform float uReflectHorizon;
uniform float uReflectFalloff;
uniform float uReflectWobble;
uniform float uTiltStrength;
uniform float uTiltFocus;
uniform float uTiltRange;
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
// Ring taps for the tilt-shift disk blur. Two rings + centre per iteration.
const int DOF_SAMPLES = 10;

float luma(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

vec3 brightPass(vec2 uv) {
  vec3 color = texture2D(uSource, uv).rgb;
  return color * smoothstep(uBloomThreshold, 1.0, luma(color));
}

/**
 * ACES filmic tonemap (Narkowicz's fit), the exact twin of acesFilmic() in
 * bloomModel.ts. Maps summed HDR light back into 0..1 with a highlight shoulder,
 * so a bloomed emissive rolls off keeping its colour rather than clipping white.
 */
vec3 acesFilmic(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
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

/** A deterministic 0..1 hash of a 2D point \u2014 the grain's noise source. */
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

  // Tilt-shift depth of field: keep a horizontal band sharp and blur outside it,
  // the row standing in for distance in a flat scene. The blur weight is the pure
  // tiltShiftBlur() of lensModel.ts \u2014 0 inside the band, ramping to 1 over a fixed
  // feather \u2014 scaled by strength into a disk radius. Offsets come from sin/cos of
  // the loop index rather than an indexed array (GLSL ES 1.00 forbids the latter).
  if (uTiltStrength > 0.0) {
    float outside = abs(uv.y - uTiltFocus) - max(uTiltRange, 0.0);
    float blurAmount = clamp(outside / 0.35, 0.0, 1.0) * uTiltStrength;
    if (blurAmount > 0.001) {
      float radius = blurAmount * 6.0;             // max ~6px kernel at full blur
      vec2 texel = 1.0 / uSourceSize;
      vec3 blurred = color;
      float total = 1.0;
      for (int i = 0; i < DOF_SAMPLES; i++) {
        float a = float(i) / float(DOF_SAMPLES) * TAU;
        vec2 dir = vec2(cos(a), sin(a));
        blurred += texture2D(uSource, uv + dir * radius * texel).rgb;
        blurred += texture2D(uSource, uv + dir * (radius * 0.5) * texel).rgb;
        total += 2.0;
      }
      color = mix(color, blurred / total, clamp(blurAmount, 0.0, 1.0));
    }
  }

  // Wet-floor reflection: below the horizon, mirror the frame above it downward and
  // fade with distance (reflectionSampleY / reflectionFade in lensModel.ts). A
  // clock-driven sideways ripple, growing with depth, makes the surface read as wet
  // rather than a mirror. Sampled from the raw source so the reflected scene is the
  // upright picture, not one already reflected.
  if (uReflectStrength > 0.0) {
    float below = uv.y - uReflectHorizon;
    if (below > 0.0) {
      float ripple = sin(uv.x * 40.0 + uTime * 2.2) * uReflectWobble * 0.02 * below / max(uReflectFalloff, 0.001);
      vec2 rUv = clamp(vec2(uv.x + ripple, uReflectHorizon - below), 0.0, 1.0);
      vec3 mirror = texture2D(uSource, rUv).rgb;
      float fade = uReflectStrength * clamp(1.0 - below / max(uReflectFalloff, 0.001), 0.0, 1.0);
      color = mix(color, mirror, fade);
    }
  }

  // Bloom: add the wide multi-scale glow the pyramid pre-computed. Where the
  // pyramid could not be built, fall back to the original 3x3 bright-pass blur so
  // bloom still does something on a context without render-to-texture.
  if (uBloomStrength > 0.0) {
    vec3 glow;
    if (uHasBloomTex > 0.5) {
      glow = texture2D(uBloomTex, uv).rgb;
    } else {
      vec2 texel = 1.0 / uSourceSize;
      glow = vec3(0.0);
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          float weight = (dx == 0 && dy == 0) ? 0.25 : (dx == 0 || dy == 0) ? 0.125 : 0.0625;
          glow += brightPass(uv + vec2(float(dx), float(dy)) * texel) * weight;
        }
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

  // HDR tonemap: with the additive light (bloom, god rays, streaks) now summed,
  // roll the highlights off the ACES curve so they compress into range with
  // their colour intact instead of clipping flat. Left of here everything is
  // HDR; right of here everything is displayable 0..1.
  if (uToneMap > 0.5) {
    color = acesFilmic(color * uExposure);
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
  // root is deliberate \u2014 ink coverage goes as the dot's *area*, so a linear
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
var PostFxPass = class _PostFxPass {
  constructor(gl, program, texture, quad, positionLocation, bloom) {
    this.gl = gl;
    this.program = program;
    this.texture = texture;
    this.quad = quad;
    this.positionLocation = positionLocation;
    this.bloom = bloom;
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
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SOURCE2);
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
    if (!texture || !buffer) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const bloom = BloomPyramid.create(gl);
    return new _PostFxPass(gl, program, texture, buffer, positionLocation, bloom);
  }
  location(name) {
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
  render(source, width, height, uniforms, time = 0) {
    const gl = this.gl;
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
    let bloomTexture = null;
    if (this.bloom && uniforms.bloomStrength > 0) {
      bloomTexture = this.bloom.generate(this.texture, width, height, uniforms.bloomThreshold, uniforms.bloomRadius);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomTexture ?? this.texture);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.location("uSource"), 0);
    gl.uniform1i(this.location("uBloomTex"), 1);
    gl.uniform1f(this.location("uHasBloomTex"), bloomTexture ? 1 : 0);
    gl.uniform2f(this.location("uSourceSize"), width, height);
    gl.uniform1f(this.location("uBrightness"), uniforms.brightness);
    gl.uniform1f(this.location("uContrast"), uniforms.contrast);
    gl.uniform1f(this.location("uSaturation"), uniforms.saturation);
    gl.uniform1f(this.location("uFogDensity"), uniforms.fogDensity);
    gl.uniform1f(this.location("uFogHorizon"), uniforms.fogHorizon);
    gl.uniform3f(this.location("uFogColor"), ...uniforms.fogColor);
    gl.uniform1f(this.location("uBloomStrength"), uniforms.bloomStrength);
    gl.uniform1f(this.location("uBloomThreshold"), uniforms.bloomThreshold);
    gl.uniform1f(this.location("uToneMap"), uniforms.toneMap);
    gl.uniform1f(this.location("uExposure"), uniforms.exposure);
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
    gl.uniform1f(this.location("uReflectStrength"), uniforms.reflectionStrength);
    gl.uniform1f(this.location("uReflectHorizon"), uniforms.reflectionHorizon);
    gl.uniform1f(this.location("uReflectFalloff"), uniforms.reflectionFalloff);
    gl.uniform1f(this.location("uReflectWobble"), uniforms.reflectionWobble);
    gl.uniform1f(this.location("uTiltStrength"), uniforms.tiltStrength);
    gl.uniform1f(this.location("uTiltFocus"), uniforms.tiltFocus);
    gl.uniform1f(this.location("uTiltRange"), uniforms.tiltRange);
    gl.uniform1f(this.location("uKaleidoSegments"), uniforms.kaleidoSegments);
    gl.uniform1f(this.location("uKaleidoAngle"), uniforms.kaleidoAngle);
    gl.uniform1f(this.location("uGrainAmount"), uniforms.grainAmount);
    gl.uniform1f(this.location("uGrainSize"), uniforms.grainSize);
    gl.uniform1f(this.location("uTime"), time);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  dispose() {
    this.bloom?.dispose();
    this.gl.deleteBuffer(this.quad);
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
    colors: [{ id: "tint", label: "Fog colour", defaultValue: "#9db4c8" }],
    params: [
      { id: "density", label: "Density", min: 0, max: 1, step: 0.01, defaultValue: 0.35 },
      { id: "horizon", label: "Horizon", min: 0, max: 1, step: 0.01, defaultValue: 0.4 }
    ]
  },
  {
    id: "bloom",
    label: "Bloom",
    description: "Bright pixels glow past their edges through a multi-scale blur pyramid.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1.5, step: 0.01, defaultValue: 0.6 },
      // The bright-pass gate. Max stays below 1 so a soft knee still has headroom
      // above it (the extract ramps from threshold - knee up to threshold + knee).
      { id: "threshold", label: "Threshold", min: 0, max: 0.95, step: 0.01, defaultValue: 0.6 },
      // How far up the pyramid the glow reaches: 0 keeps it tight around edges, 1
      // spreads the widest, softest halo by weighting the coarser blur levels more.
      { id: "radius", label: "Radius", min: 0, max: 1, step: 0.01, defaultValue: 0.6 }
    ]
  },
  {
    id: "tonemap",
    label: "HDR tonemap",
    description: "Rolls bright highlights off the ACES filmic curve so bloomed light keeps its colour instead of clipping to white.",
    params: [
      // Scales the scene into the curve before mapping: >1 lifts the whole image
      // toward the shoulder (more rolloff), <1 holds detail in the highlights.
      { id: "exposure", label: "Exposure", min: 0.2, max: 3, step: 0.01, defaultValue: 1 }
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
  },
  {
    id: "dither",
    label: "Ordered dither",
    description: "Bayer pattern that turns posterised bands into pixel-art stipple.",
    params: [
      { id: "amount", label: "Amount", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "scale", label: "Cell size", min: 1, max: 4, step: 1, defaultValue: 1 }
    ]
  },
  {
    id: "halftone",
    label: "Halftone",
    description: "Print-style dot screen sized by brightness.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
      { id: "scale", label: "Dot size", min: 2, max: 16, step: 1, defaultValue: 5 },
      { id: "angle", label: "Screen angle", min: 0, max: 90, step: 1, defaultValue: 45 }
    ]
  },
  {
    id: "godrays",
    label: "God rays",
    description: "Light shafts streaming out of a bright point in the frame.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 2, step: 0.05, defaultValue: 0.8 },
      { id: "density", label: "Length", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "decay", label: "Falloff", min: 0.8, max: 0.99, step: 5e-3, defaultValue: 0.95 },
      { id: "x", label: "Source X", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "y", label: "Source Y", min: 0, max: 1, step: 0.01, defaultValue: 0.2 }
    ]
  },
  {
    id: "streaks",
    label: "Light streaks",
    description: "Anamorphic horizontal flares off the brightest pixels.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 2, step: 0.05, defaultValue: 0.6 },
      { id: "length", label: "Length", min: 0, max: 1, step: 0.01, defaultValue: 0.4 }
    ]
  },
  {
    id: "splittone",
    label: "Split tone",
    description: "Tints shadows and highlights toward different colours.",
    colors: [
      { id: "shadows", label: "Shadows", defaultValue: "#3d4f7a" },
      { id: "highlights", label: "Highlights", defaultValue: "#ffd9a0" }
    ],
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "balance", label: "Balance", min: 0, max: 1, step: 0.01, defaultValue: 0.5 }
    ]
  },
  {
    id: "reflection",
    label: "Wet-floor reflection",
    description: "Mirrors the scene above a horizon line down into the floor below it, fading with distance \u2014 the screen-space reflection of a rain-slick street.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      // Where the reflective surface begins. Shape, not intensity: it chooses the
      // waterline whether or not the effect is dialled up, so it is read always.
      { id: "horizon", label: "Horizon", min: 0, max: 1, step: 0.01, defaultValue: 0.7 },
      { id: "falloff", label: "Falloff", min: 0.05, max: 1, step: 0.01, defaultValue: 0.4 },
      // Sideways ripple amplitude; animated by the clock so the surface shimmers.
      { id: "wobble", label: "Ripple", min: 0, max: 1, step: 0.01, defaultValue: 0.25 }
    ]
  },
  {
    id: "tiltshift",
    label: "Tilt-shift focus",
    description: "Keeps a horizontal band sharp and blurs above and below it, the miniature-diorama depth of field the cinematic look leans on.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
      // The in-focus band's centre row and half-height. Both are shape.
      { id: "focus", label: "Focus row", min: 0, max: 1, step: 0.01, defaultValue: 0.55 },
      { id: "range", label: "In-focus band", min: 0, max: 0.5, step: 0.01, defaultValue: 0.12 }
    ]
  },
  {
    id: "kaleidoscope",
    label: "Kaleidoscope",
    description: "Mirrors a wedge of the frame around the centre.",
    params: [
      // Below 2 there is nothing to mirror, so the shader treats it as off.
      { id: "segments", label: "Segments", min: 2, max: 12, step: 1, defaultValue: 6 },
      { id: "angle", label: "Rotation", min: 0, max: 360, step: 1, defaultValue: 0 }
    ]
  },
  {
    id: "grain",
    label: "Film grain",
    description: "Animated noise over the frame.",
    params: [
      { id: "amount", label: "Amount", min: 0, max: 0.5, step: 0.01, defaultValue: 0.08 },
      { id: "size", label: "Grain size", min: 1, max: 4, step: 1, defaultValue: 1 }
    ]
  }
];
function paramKey(effect, param) {
  return `${effect}.${param}`;
}
var LEGACY_FOG_COLOR_KEY = "fogColor";
var HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
function defaultPostFxSettings() {
  const enabled = {};
  const values = {};
  const colors = {};
  for (const effect of POST_FX_EFFECTS) {
    enabled[effect.id] = false;
    for (const param of effect.params) {
      values[paramKey(effect.id, param.id)] = param.defaultValue;
    }
    for (const color of effect.colors ?? []) {
      colors[paramKey(effect.id, color.id)] = color.defaultValue;
    }
  }
  return { enabled, values, colors };
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
  const rawColors = typeof record.colors === "object" && record.colors !== null ? record.colors : {};
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
    for (const color of effect.colors ?? []) {
      const key = paramKey(effect.id, color.id);
      const raw = rawColors[key];
      if (typeof raw === "string" && HEX_COLOR.test(raw)) settings.colors[key] = raw;
    }
  }
  const legacyFog = record[LEGACY_FOG_COLOR_KEY];
  if (typeof legacyFog === "string" && HEX_COLOR.test(legacyFog) && !(paramKey("fog", "tint") in rawColors)) {
    settings.colors[paramKey("fog", "tint")] = legacyFog;
  }
  return settings;
}
function hexToRgb01(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}
function colorDefault(effect, colorId) {
  const def = POST_FX_EFFECTS.find((entry) => entry.id === effect)?.colors?.find((color) => color.id === colorId);
  return def?.defaultValue ?? "#000000";
}
function uniformsFromSettings(settings) {
  const value = (effect, param, neutral) => settings.enabled[effect] ? settings.values[paramKey(effect, param)] ?? neutral : neutral;
  const shape = (effect, param, fallback) => settings.values[paramKey(effect, param)] ?? fallback;
  const color = (effect, colorId) => hexToRgb01(settings.colors[paramKey(effect, colorId)] ?? colorDefault(effect, colorId));
  return {
    brightness: value("grade", "brightness", 1),
    contrast: value("grade", "contrast", 1),
    saturation: value("grade", "saturation", 1),
    fogDensity: value("fog", "density", 0),
    fogHorizon: shape("fog", "horizon", 0.4),
    fogColor: color("fog", "tint"),
    bloomStrength: value("bloom", "strength", 0),
    bloomThreshold: shape("bloom", "threshold", 0.6),
    bloomRadius: shape("bloom", "radius", 0.6),
    toneMap: settings.enabled.tonemap ? 1 : 0,
    exposure: shape("tonemap", "exposure", 1),
    curvature: value("crt", "curvature", 0),
    scanlines: value("crt", "scanlines", 0),
    aberration: value("chroma", "amount", 0),
    vignette: value("vignette", "strength", 0),
    posterize: settings.enabled.posterize ? shape("posterize", "levels", 4) : 0,
    ditherAmount: value("dither", "amount", 0),
    ditherScale: shape("dither", "scale", 1),
    halftoneStrength: value("halftone", "strength", 0),
    halftoneScale: shape("halftone", "scale", 5),
    halftoneAngle: shape("halftone", "angle", 45) * Math.PI / 180,
    godrayStrength: value("godrays", "strength", 0),
    godrayDensity: shape("godrays", "density", 0.5),
    godrayDecay: shape("godrays", "decay", 0.95),
    godrayOrigin: [shape("godrays", "x", 0.5), shape("godrays", "y", 0.2)],
    streakStrength: value("streaks", "strength", 0),
    streakLength: shape("streaks", "length", 0.4),
    splitStrength: value("splittone", "strength", 0),
    splitBalance: shape("splittone", "balance", 0.5),
    splitShadows: color("splittone", "shadows"),
    splitHighlights: color("splittone", "highlights"),
    reflectionStrength: value("reflection", "strength", 0),
    reflectionHorizon: shape("reflection", "horizon", 0.7),
    reflectionFalloff: shape("reflection", "falloff", 0.4),
    reflectionWobble: shape("reflection", "wobble", 0.25),
    tiltStrength: value("tiltshift", "strength", 0),
    tiltFocus: shape("tiltshift", "focus", 0.55),
    tiltRange: shape("tiltshift", "range", 0.12),
    kaleidoSegments: settings.enabled.kaleidoscope ? shape("kaleidoscope", "segments", 6) : 0,
    kaleidoAngle: shape("kaleidoscope", "angle", 0) * Math.PI / 180,
    grainAmount: value("grain", "amount", 0),
    grainSize: shape("grain", "size", 1)
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
    /** When this surface started, so animated effects get a monotonic clock. */
    this.startedAt = performance.now();
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
    this.pass.render(
      this.innerCanvas,
      this.model.width,
      this.model.height,
      this.uniforms,
      (performance.now() - this.startedAt) / 1e3
    );
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
  portrait: {
    id: "portrait",
    label: "Portrait",
    kind: "raster2d",
    // 9:16 (360x640) — the Pro spec turned on its side, for carts played the way
    // a handheld is actually held. Deliberately Pro's exact pixel count
    // (360*640 == 640*360), so the core reuses Pro's framebuffer and memory map
    // unchanged; only the two dimensions and the overscan buffer differ.
    // Both divide the 8px tile grid (45x80 cells).
    width: 360,
    height: 640,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    paletteSize: 64,
    cartSizeBytes: 1024 * 1024,
    engineUrl: "/engine/portrait/engine.js",
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
    setMaterialCapture(enabled) {
      module._cbx_set_material_capture(handle, enabled ? 1 : 0);
    },
    readMaterial() {
      const ptr = module._cbx_material_ptr(handle);
      return module.HEAPU8.subarray(ptr, ptr + frameBytes);
    },
    readEmissive() {
      const ptr = module._cbx_emissive_ptr(handle);
      return module.HEAPU8.subarray(ptr, ptr + frameBytes / 4);
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
local _CB = _LB + 1 + _LCAP * 6
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
local function _norm(x, y, z)
  local m = math.sqrt(x * x + y * y + z * z)
  if m < 1e-6 then return 0, 0, 1 end
  return x / m, y / m, z / m
end
local function _byte(v)
  local b = math.floor((v or 0) * 127 + 0.5)
  if b < -127 then b = -127 elseif b > 127 then b = 127 end
  if b < 0 then b = b + 256 end
  return b
end
local function _light(kind, x, y, z, radius, r, g, b, intensity, dx, dy, cone)
  if _ln >= _LCAP then return end
  local base = _LB + 1 + _ln * 6
  pmem(base, x // 1)
  pmem(base + 1, y // 1)
  pmem(base + 2, z // 1)
  pmem(base + 3, radius // 1)
  local rgb = (math.floor(r or 255) & 0xff) << 16
  rgb = rgb | ((math.floor(g or 255) & 0xff) << 8)
  rgb = rgb | (math.floor(b or 255) & 0xff)
  pmem(base + 4, rgb | (kind << 24) | (cone << 26))
  local inten = math.floor((intensity or 1) * 256)
  if inten < 0 then inten = 0 elseif inten > 0xffff then inten = 0xffff end
  pmem(base + 5, inten | (dx << 16) | (dy << 24))
  _ln = _ln + 1
  pmem(_LB, _ln)
end
cartbox = {
  unlock = function(id) _emit(1, _hash(id), 0) end,
  score = function(v) _emit(2, 0, v // 1) end,
  progress = function(id, v) _emit(3, _hash(id), v // 1) end,
  clearlights = function() _ln = 0 pmem(_LB, 0) end,
  light = function(x, y, radius, r, g, b, z, intensity)
    _light(0, x, y, z or 12, radius, r, g, b, intensity, 0, 0, 0)
  end,
  sun = function(dx, dy, dz, r, g, b, intensity)
    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)
    _light(1, 0, 0, 0, 0, r, g, b, intensity, _byte(nx), _byte(ny), 0)
  end,
  spot = function(x, y, z, dx, dy, dz, radius, angle, r, g, b, intensity)
    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)
    local cone = math.floor(math.cos(math.rad(angle or 30)) * 63 + 0.5)
    if cone < 0 then cone = 0 elseif cone > 63 then cone = 63 end
    _light(2, x, y, z or 12, radius, r, g, b, intensity, _byte(nx), _byte(ny), cone)
  end,
  camera = function(x, y)
    pmem(_CB, math.floor((x or 0) * 16 + 0.5) & 0xffffffff)
    pmem(_CB + 1, math.floor((y or 0) * 16 + 0.5) & 0xffffffff)
  end,
  -- Collision defaults: overridden by the injected layer when the cart has one,
  -- so cartbox.solid/mapsize are always safe to call (a cart with no collision
  -- layer simply sees every cell as non-solid).
  solid = function() return false end,
  mapsize = function() return 0, 0 end,
}`;
function injectSdk(bytes) {
  return prependLuaCode(bytes, CARTBOX_SDK_LUA);
}

// src/collisionSdk.ts
function parseCollisionField(value) {
  if (typeof value !== "object" || value === null) return null;
  const data = value;
  if (typeof data.width !== "number" || typeof data.height !== "number") return null;
  if (typeof data.bits !== "string") return null;
  if (data.width <= 0 || data.height <= 0 || !Number.isFinite(data.width) || !Number.isFinite(data.height)) {
    return null;
  }
  return { width: Math.floor(data.width), height: Math.floor(data.height), bits: data.bits };
}
function collisionSdkLua(collision) {
  const field = parseCollisionField(collision);
  if (!field || field.bits.length === 0) return "";
  const width = field.width;
  const height = field.height;
  return `do
  local _cw, _ch = ${width}, ${height}
  local function _b64(s)
    local _T = {}
    local _A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    for i = 1, #_A do _T[string.byte(_A, i)] = i - 1 end
    local out, acc, bits = {}, 0, 0
    for i = 1, #s do
      local v = _T[string.byte(s, i)]
      if v then
        acc = (acc << 6) | v
        bits = bits + 6
        if bits >= 8 then
          bits = bits - 8
          out[#out + 1] = string.char((acc >> bits) & 0xff)
          acc = acc & ((1 << bits) - 1)
        end
      end
    end
    return table.concat(out)
  end
  local _cb = _b64("${field.bits}")
  cartbox = cartbox or {}
  cartbox.mapsize = function() return _cw, _ch end
  cartbox.solid = function(x, y)
    x = math.floor(x or 0)
    y = math.floor(y or 0)
    if x < 0 or x >= _cw or y < 0 or y >= _ch then return false end
    local cell = y * _cw + x
    local byte = string.byte(_cb, (cell >> 3) + 1) or 0
    return (byte & (1 << (cell & 7))) ~= 0
  end
end`;
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
var CAMERA_BASE = LIGHTS_BASE + 1 + LIGHTS_CAPACITY * LIGHT_STRIDE;
var CAMERA_SCALE = 16;
var LIGHT_KIND_POINT = 0;
var LIGHT_KIND_SPOT = 2;
var LIGHT_DIR_SCALE = 127;
var LIGHT_CONE_SCALE = 63;
var KIND_BY_CODE = ["point", "directional", "spot"];
function signedByte(byte) {
  return byte < 128 ? byte : byte - 256;
}
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
    const intensityWord = words[base + 5] ?? LIGHT_INTENSITY_SCALE;
    const intensity = (intensityWord & 65535) / LIGHT_INTENSITY_SCALE;
    const light = {
      x: words[base] ?? 0,
      y: words[base + 1] ?? 0,
      z: words[base + 2] ?? 0,
      radius: words[base + 3] ?? 0,
      color: [
        (packed >>> 16 & 255) / 255 * intensity,
        (packed >>> 8 & 255) / 255 * intensity,
        (packed & 255) / 255 * intensity
      ]
    };
    const kindCode = packed >>> 24 & 3;
    if (kindCode !== LIGHT_KIND_POINT) {
      light.kind = KIND_BY_CODE[kindCode] ?? "point";
      const dirX = signedByte(intensityWord >>> 16 & 255) / LIGHT_DIR_SCALE;
      const dirY = signedByte(intensityWord >>> 24 & 255) / LIGHT_DIR_SCALE;
      const dirZ = Math.sqrt(Math.max(0, 1 - dirX * dirX - dirY * dirY));
      light.direction = [dirX, dirY, dirZ];
      if (kindCode === LIGHT_KIND_SPOT) {
        light.coneCos = (packed >>> 26 & 63) / LIGHT_CONE_SCALE;
      }
    }
    lights.push(light);
  }
  return lights;
}
function decodeCamera(words) {
  if (words.length <= CAMERA_BASE + 1) {
    return { x: 0, y: 0 };
  }
  return {
    x: ((words[CAMERA_BASE] ?? 0) | 0) / CAMERA_SCALE,
    y: ((words[CAMERA_BASE + 1] ?? 0) | 0) / CAMERA_SCALE
  };
}
function hashEventId(id) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash ^ id.charCodeAt(i)) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

// src/scene/cartSpriteSource.ts
var TILE_SIZE = 8;
var PIXELS_PER_TILE = TILE_SIZE * TILE_SIZE;
var SHEET_COLS = 16;
function readPixel(heap, tileBase, pixelIndex, bits) {
  if (bits === 8) return heap[tileBase + pixelIndex] ?? 0;
  const byte = heap[tileBase + (pixelIndex >> 1)] ?? 0;
  return pixelIndex & 1 ? byte >> 4 & 15 : byte & 15;
}
function createCartSpriteSource(module, bytes, paletteSize) {
  if (typeof module._cbx_cart_create !== "function") return null;
  const cart = module._cbx_cart_create();
  if (!cart) return null;
  const ptr = module._malloc(bytes.byteLength);
  module.HEAPU8.set(bytes, ptr);
  module._cbx_cart_load(cart, ptr, bytes.byteLength);
  module._free(ptr);
  const bits = paletteSize <= 16 ? 4 : 8;
  const bytesPerTile = bits === 8 ? PIXELS_PER_TILE : PIXELS_PER_TILE / 2;
  const bank = 0;
  const tilesPtr = module._cbx_cart_tiles_ptr(cart, bank);
  const spritesPtr = module._cbx_cart_sprites_ptr(cart, bank);
  const palettePtr = module._cbx_cart_palette_ptr(cart, bank);
  const source = {
    readRegion(page, baseTile, tilesW, tilesH) {
      const width = tilesW * TILE_SIZE;
      const height = tilesH * TILE_SIZE;
      const pixels = new Uint8ClampedArray(width * height * 4);
      const heap = module.HEAPU8;
      const sheetBase = page === 0 ? tilesPtr : spritesPtr;
      for (let ty = 0; ty < tilesH; ty += 1) {
        for (let tx = 0; tx < tilesW; tx += 1) {
          const subTile = baseTile + ty * SHEET_COLS + tx;
          const tileBase = sheetBase + subTile * bytesPerTile;
          for (let y = 0; y < TILE_SIZE; y += 1) {
            for (let x = 0; x < TILE_SIZE; x += 1) {
              const idx = readPixel(heap, tileBase, y * TILE_SIZE + x, bits);
              if (idx === 0) continue;
              const o = ((ty * TILE_SIZE + y) * width + (tx * TILE_SIZE + x)) * 4;
              const p = palettePtr + idx * 3;
              pixels[o] = heap[p] ?? 0;
              pixels[o + 1] = heap[p + 1] ?? 0;
              pixels[o + 2] = heap[p + 2] ?? 0;
              pixels[o + 3] = 255;
            }
          }
        }
      }
      return { pixels, width, height };
    }
  };
  const paletteRgb = (index) => {
    const heap = module.HEAPU8;
    const p = palettePtr + index * 3;
    return [heap[p] ?? 0, heap[p + 1] ?? 0, heap[p + 2] ?? 0];
  };
  return { source, paletteRgb, dispose: () => module._cbx_cart_delete(cart) };
}

// src/scene/parallaxScene.ts
var clampUnit = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
var lerp = (a, b, t) => a + (b - a) * t;
function parallaxOf(layer) {
  return layer.parallax ?? clampUnit(1 - layer.depth);
}
function hazeColor(rgb, haze, atmosphere) {
  const t = clampUnit(haze);
  const desat = atmosphere.desaturate * t;
  const lift = atmosphere.lift * t;
  const blend = atmosphere.density * t;
  const out = [rgb[0], rgb[1], rgb[2]];
  const luma = out[0] * 0.299 + out[1] * 0.587 + out[2] * 0.114;
  for (let c = 0; c < 3; c += 1) {
    let v = out[c];
    v = lerp(v, luma, desat);
    v = lerp(v, lerp(v, atmosphere.fog[c], 0.5), lift);
    v = lerp(v, atmosphere.fog[c], blend);
    out[c] = v;
  }
  return [out[0], out[1], out[2]];
}
function prehazeLayers(layers, atmosphere) {
  return layers.map((layer) => {
    const haze = clampUnit(layer.depth);
    if (haze <= 0) {
      return { ...layer, hazed: true };
    }
    const src = layer.pixels;
    const pixels = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
      const [r, g, b] = hazeColor([src[i], src[i + 1], src[i + 2]], haze, atmosphere);
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = src[i + 3];
    }
    return { ...layer, pixels, hazed: true };
  });
}
function composeParallax(out, outW, outH, layers, camera, atmosphere) {
  const ordered = [...layers].sort((a, b) => b.depth - a.depth);
  for (const layer of ordered) {
    const factor = parallaxOf(layer);
    const shiftX = Math.round(-camera.x * factor + (layer.offsetX ?? 0));
    const shiftY = Math.round(-camera.y * factor + (layer.offsetY ?? 0));
    const wrapX = layer.wrapX ?? true;
    const haze = layer.hazed ? 0 : clampUnit(layer.depth);
    const opacity = layer.opacity ?? 1;
    const emissive = layer.emissive ?? 1;
    for (let y = 0; y < outH; y += 1) {
      let sy = y - shiftY;
      if (sy < 0 || sy >= layer.height) continue;
      for (let x = 0; x < outW; x += 1) {
        let sx = x - shiftX;
        if (wrapX) sx = (sx % layer.width + layer.width) % layer.width;
        else if (sx < 0 || sx >= layer.width) continue;
        const si = (sy * layer.width + sx) * 4;
        const alpha = layer.pixels[si + 3] / 255 * opacity;
        if (alpha <= 0) continue;
        const src = [layer.pixels[si], layer.pixels[si + 1], layer.pixels[si + 2]];
        const hazed = haze > 0 ? hazeColor(src, haze, atmosphere) : src;
        const di = (y * outW + x) * 4;
        out[di] = lerp(out[di], hazed[0] * emissive, alpha);
        out[di + 1] = lerp(out[di + 1], hazed[1] * emissive, alpha);
        out[di + 2] = lerp(out[di + 2], hazed[2] * emissive, alpha);
        out[di + 3] = 255;
      }
    }
  }
}

// src/scene/sceneRender.ts
function resolveSceneLayers(spec, source) {
  return spec.layers.map((layer) => {
    const image = source.readRegion(layer.source.page, layer.source.tile, layer.source.tilesW, layer.source.tilesH);
    const resolved = {
      pixels: image.pixels,
      width: image.width,
      height: image.height,
      depth: layer.depth,
      wrapX: layer.wrapX,
      offsetY: layer.offsetY
    };
    if (layer.parallax !== void 0) resolved.parallax = layer.parallax;
    return resolved;
  });
}
function cameraAt(spec, frame, base = { x: 0, y: 0 }) {
  return {
    x: base.x + (spec.camera.autoScrollX ?? 0) * frame,
    y: base.y + (spec.camera.autoScrollY ?? 0) * frame
  };
}
function fillSky(out, width, height, atmosphere, horizonY = height) {
  const zenith = [
    Math.round(atmosphere.fog[0] * 0.16),
    Math.round(atmosphere.fog[1] * 0.16),
    Math.round(atmosphere.fog[2] * 0.22)
  ];
  for (let y = 0; y < height; y += 1) {
    const t = Math.min(1, horizonY > 0 ? y / horizonY : 1);
    const r = Math.round(zenith[0] + (atmosphere.fog[0] - zenith[0]) * t);
    const g = Math.round(zenith[1] + (atmosphere.fog[1] - zenith[1]) * t);
    const b = Math.round(zenith[2] + (atmosphere.fog[2] - zenith[2]) * t);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
}
function renderSceneBackdrop(out, width, height, layers, spec, frame, base) {
  fillSky(out, width, height, spec.atmosphere);
  composeParallax(out, width, height, layers, cameraAt(spec, frame, base), spec.atmosphere);
}

// src/scene/sceneComposite.ts
function matchesKey(r, g, b, key, tolerance) {
  return Math.abs(r - key[0]) <= tolerance && Math.abs(g - key[1]) <= tolerance && Math.abs(b - key[2]) <= tolerance;
}
function compositeOverBackdrop(cartFrame, backdrop, width, height, keyRgb, tolerance = 0, out) {
  const target = out ?? new Uint8ClampedArray(width * height * 4);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const r = cartFrame[o], g = cartFrame[o + 1], b = cartFrame[o + 2];
    if (matchesKey(r, g, b, keyRgb, tolerance)) {
      target[o] = backdrop[o];
      target[o + 1] = backdrop[o + 1];
      target[o + 2] = backdrop[o + 2];
      target[o + 3] = 255;
    } else {
      target[o] = r;
      target[o + 1] = g;
      target[o + 2] = b;
      target[o + 3] = 255;
    }
  }
  return target;
}

// src/scene/SceneBackdropSurface.ts
var SceneBackdropSurface = class {
  constructor(inner, width, height, layers, spec, keyRgb) {
    this.inner = inner;
    this.width = width;
    this.height = height;
    this.spec = spec;
    this.keyRgb = keyRgb;
    this.frame = 0;
    /** The cart-published camera base, added to the scene's auto-scroll each frame. */
    this.cameraBase = { x: 0, y: 0 };
    /** Per-layer animation overrides for this frame, keyed by layer index (or null). */
    this.layerOverrides = null;
    const size = width * height * 4;
    this.hazedLayers = prehazeLayers(layers, spec.atmosphere);
    this.sky = new Uint8ClampedArray(size);
    fillSky(this.sky, width, height, spec.atmosphere);
    this.backdrop = new Uint8ClampedArray(size);
    this.composited = new Uint8ClampedArray(size);
    this.presented = new Uint8Array(this.composited.buffer);
  }
  /**
   * Set the backdrop camera the cart published this frame (via `cartbox.camera`).
   * Added to the scene's own auto-scroll, so an auto-scroll-only cart that never
   * sets it keeps panning as before with the default (0, 0).
   */
  setCameraBase(base) {
    this.cameraBase = base;
  }
  /**
   * Set this frame's per-layer animation overrides (or null for none). Applied on
   * top of the pre-hazed layers without touching their baked pixels, so the
   * frame-invariant haze cache is preserved.
   */
  setLayerOverrides(overrides) {
    this.layerOverrides = overrides;
  }
  /** The layers to composite this frame: the cached ones, plus any overrides. */
  frameLayers() {
    const overrides = this.layerOverrides;
    if (!overrides) return this.hazedLayers;
    return this.hazedLayers.map((layer, index) => {
      const override = overrides[index];
      if (!override) return layer;
      return {
        ...layer,
        offsetX: (layer.offsetX ?? 0) + (override.offsetX ?? 0),
        offsetY: (layer.offsetY ?? 0) + (override.offsetY ?? 0),
        opacity: override.opacity ?? layer.opacity,
        emissive: override.emissive ?? layer.emissive
      };
    });
  }
  blit(rgba) {
    const cartFrame = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    this.backdrop.set(this.sky);
    composeParallax(
      this.backdrop,
      this.width,
      this.height,
      this.frameLayers(),
      cameraAt(this.spec, this.frame, this.cameraBase),
      this.spec.atmosphere
    );
    compositeOverBackdrop(cartFrame, this.backdrop, this.width, this.height, this.keyRgb, 0, this.composited);
    this.inner.blit(this.presented);
    this.frame += 1;
  }
  destroy() {
    this.inner.destroy();
  }
};

// src/anim/AnimatedForegroundSurface.ts
var AnimatedForegroundSurface = class {
  constructor(inner, width, height, source) {
    this.inner = inner;
    this.width = width;
    this.height = height;
    this.source = source;
    this.placements = [];
    /** Static region pixels cached by region key (page:tile:tilesW:tilesH). */
    this.regionCache = /* @__PURE__ */ new Map();
    this.output = new Uint8ClampedArray(width * height * 4);
    this.presented = new Uint8Array(this.output.buffer);
  }
  /** Set the placements resolved for this frame (empty for none). */
  setPlacements(placements) {
    this.placements = placements;
  }
  region(placement) {
    const { page, tile, tilesW, tilesH } = placement.region;
    const key = `${page}:${tile}:${tilesW}:${tilesH}`;
    let image = this.regionCache.get(key);
    if (!image) {
      image = this.source.readRegion(page, tile, tilesW, tilesH);
      this.regionCache.set(key, image);
    }
    return image;
  }
  blit(rgba) {
    if (this.placements.length === 0) {
      this.inner.blit(rgba);
      return;
    }
    this.output.set(rgba);
    const ordered = [...this.placements].sort((a, b) => b.depth - a.depth);
    for (const placement of ordered) this.drawPlacement(placement);
    this.inner.blit(this.presented);
  }
  /** Nearest-neighbour scale + straight-alpha composite of one placement. */
  drawPlacement(placement) {
    const opacity = Math.max(0, Math.min(1, placement.opacity));
    if (opacity <= 0) return;
    const scale = placement.scale > 0 ? placement.scale : 1;
    const image = this.region(placement);
    const destWidth = Math.max(1, Math.round(image.width * scale));
    const destHeight = Math.max(1, Math.round(image.height * scale));
    const originX = Math.round(placement.x);
    const originY = Math.round(placement.y);
    for (let dy = 0; dy < destHeight; dy += 1) {
      const y = originY + dy;
      if (y < 0 || y >= this.height) continue;
      const sy = Math.min(image.height - 1, Math.floor(dy / scale));
      for (let dx = 0; dx < destWidth; dx += 1) {
        const x = originX + dx;
        if (x < 0 || x >= this.width) continue;
        const sx = Math.min(image.width - 1, Math.floor(dx / scale));
        const si = (sy * image.width + sx) * 4;
        const alpha = image.pixels[si + 3] / 255 * opacity;
        if (alpha <= 0) continue;
        const di = (y * this.width + x) * 4;
        this.output[di] = lerp2(this.output[di], image.pixels[si], alpha);
        this.output[di + 1] = lerp2(this.output[di + 1], image.pixels[si + 1], alpha);
        this.output[di + 2] = lerp2(this.output[di + 2], image.pixels[si + 2], alpha);
        this.output[di + 3] = 255;
      }
    }
  }
  destroy() {
    this.inner.destroy();
  }
};
var lerp2 = (a, b, t) => a + (b - a) * t;

// src/anim/animPlayer.ts
var mod = (a, m) => (a % m + m) % m;
function frameSequence(clip) {
  const count = clip.frames.length;
  if (count <= 1) return [0];
  const forward = [];
  for (let i = 0; i < count; i += 1) forward.push(i);
  if (clip.mode !== "pingpong") return forward;
  for (let i = count - 2; i >= 1; i -= 1) forward.push(i);
  return forward;
}
function sampleClipFrame(clip, frame) {
  const lastIndex = clip.frames.length - 1;
  const at = (index) => ({ region: clip.frames[index], frameIndex: index });
  const tick = Math.max(0, Math.floor(frame));
  if (clip.mode === "once") {
    let acc2 = 0;
    for (let i = 0; i < clip.frames.length; i += 1) {
      acc2 += clip.durations[i];
      if (tick < acc2) return at(i);
    }
    return at(lastIndex);
  }
  const sequence = frameSequence(clip);
  const sequenceDurations = sequence.map((index) => clip.durations[index]);
  const period = sequenceDurations.reduce((sum, d) => sum + d, 0);
  if (period <= 0) return at(0);
  const local = mod(tick, period);
  let acc = 0;
  for (let step = 0; step < sequence.length; step += 1) {
    acc += sequenceDurations[step];
    if (local < acc) return at(sequence[step]);
  }
  return at(sequence[sequence.length - 1]);
}
function valueAtLocalTime(keys, local) {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (local <= first.t) return first.value;
  if (local >= last.t) return last.value;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const start = keys[i];
    const end = keys[i + 1];
    if (local < start.t || local > end.t) continue;
    const dt = end.t - start.t;
    if (dt <= 0) return end.value;
    if (start.ease === "step") return start.value;
    let u = (local - start.t) / dt;
    if (start.ease === "smooth") u = u * u * (3 - 2 * u);
    return start.value + (end.value - start.value) * u;
  }
  return last.value;
}
function sampleTrack(track, frame) {
  const keys = track.keys;
  const firstT = keys[0].t;
  const lastT = keys[keys.length - 1].t;
  if (track.mode === "hold") {
    return valueAtLocalTime(keys, Math.min(Math.max(frame, firstT), lastT));
  }
  if (track.mode === "pingpong") {
    const span2 = lastT - firstT;
    if (span2 <= 0) return keys[0].value;
    const phase = mod(frame - firstT, span2 * 2);
    const local = phase <= span2 ? firstT + phase : firstT + (span2 * 2 - phase);
    return valueAtLocalTime(keys, local);
  }
  const span = track.loopLength && track.loopLength > 0 ? track.loopLength : lastT - firstT;
  if (span <= 0) return keys[0].value;
  return valueAtLocalTime(keys, firstT + mod(frame - firstT, span));
}
function evaluate(spec, frame) {
  var _a, _b;
  const clipByName = /* @__PURE__ */ new Map();
  for (const clip of spec.clips) clipByName.set(clip.name, clip);
  const layers = {};
  const postfx = {};
  const placementOverrides = {};
  for (const track of spec.tracks) {
    const value = sampleTrack(track, frame);
    const target = track.target;
    if (target.kind === "sceneLayer") {
      (layers[_a = target.index] ?? (layers[_a] = {}))[target.channel] = value;
    } else if (target.kind === "postfx") {
      postfx[target.key] = value;
    } else {
      (placementOverrides[_b = target.index] ?? (placementOverrides[_b] = {}))[target.channel] = value;
    }
  }
  const placements = [];
  spec.placements.forEach((placement, index) => {
    const clip = clipByName.get(placement.clip);
    if (!clip) return;
    const sample = sampleClipFrame(clip, frame);
    const override = placementOverrides[index] ?? {};
    placements.push({
      region: sample.region,
      frameIndex: sample.frameIndex,
      x: override.x ?? placement.x,
      y: override.y ?? placement.y,
      opacity: override.opacity ?? placement.opacity,
      scale: override.scale ?? placement.scale,
      depth: placement.depth
    });
  });
  return { layers, postfx, placements };
}

// src/particles/particleField.ts
var TAU = Math.PI * 2;
function hash01(seed, index, salt) {
  let h = Math.imul(seed, 374761393) + Math.imul(index, 668265263) + Math.imul(salt, 2246822519) >>> 0;
  h = Math.imul(h ^ h >>> 13, 1274126177) >>> 0;
  h = (h ^ h >>> 16) >>> 0;
  return h / 4294967296;
}
function wrap(value, span) {
  return (value % span + span) % span;
}
var clamp01 = (value) => value < 0 ? 0 : value > 1 ? 1 : value;
function simulateEmitter(emitter, frame, width, height) {
  const particles = [];
  const kind = emitter.kind;
  for (let index = 0; index < emitter.count; index += 1) {
    const spawnX = hash01(emitter.seed, index, 1);
    const spawnY = hash01(emitter.seed, index, 2);
    const phase = hash01(emitter.seed, index, 3) * TAU;
    const jitter = hash01(emitter.seed, index, 4);
    let x = spawnX * width + emitter.wind * frame;
    let y;
    let streak = 0;
    let alpha = emitter.opacity;
    let size = emitter.size;
    if (kind === "rain") {
      y = spawnY * height + emitter.speed * frame;
      streak = 2 + emitter.speed * 0.6;
    } else if (kind === "snow") {
      y = spawnY * height + emitter.speed * frame;
      x += Math.sin(frame * 0.05 + phase) * 6;
      size = emitter.size * (0.7 + 0.6 * jitter);
    } else if (kind === "embers") {
      y = spawnY * height - emitter.speed * frame;
      x += Math.sin(frame * 0.08 + phase) * 4;
      const climb = wrap(y, height) / height;
      const flicker2 = 0.55 + 0.45 * Math.sin(frame * 0.3 + phase * 5);
      alpha = emitter.opacity * flicker2 * (0.3 + 0.7 * climb);
    } else {
      y = spawnY * height + emitter.speed * frame * 0.3;
      size = emitter.size * (0.8 + 0.5 * jitter);
    }
    particles.push({
      x: wrap(x, width),
      y: wrap(y, height),
      size: Math.max(1, size),
      alpha: clamp01(alpha),
      color: emitter.color,
      streak
    });
  }
  return particles;
}

// src/particles/ParticleOverlaySurface.ts
var ParticleOverlaySurface = class {
  constructor(inner, width, height, spec) {
    this.inner = inner;
    this.width = width;
    this.height = height;
    this.spec = spec;
    this.frame = 0;
    this.output = new Uint8ClampedArray(width * height * 4);
    this.presented = new Uint8Array(this.output.buffer);
  }
  blit(rgba) {
    if (this.spec.emitters.length === 0) {
      this.inner.blit(rgba);
      return;
    }
    this.output.set(rgba);
    for (const emitter of this.spec.emitters) {
      for (const particle of simulateEmitter(emitter, this.frame, this.width, this.height)) {
        this.draw(particle);
      }
    }
    this.frame += 1;
    this.inner.blit(this.presented);
  }
  destroy() {
    this.inner.destroy();
  }
  /** Straight-alpha composite one particle: a vertical streak, or a square dot. */
  draw(particle) {
    if (particle.alpha <= 0) return;
    const half = Math.max(0, Math.floor(particle.size / 2));
    const originX = Math.round(particle.x);
    if (particle.streak > 0) {
      const top = Math.round(particle.y);
      const bottom = top + Math.round(particle.streak);
      for (let y = top; y <= bottom; y += 1) {
        for (let dx = -half; dx <= half; dx += 1) {
          this.blend(originX + dx, y, particle);
        }
      }
      return;
    }
    const originY = Math.round(particle.y);
    for (let dy = -half; dy <= half; dy += 1) {
      for (let dx = -half; dx <= half; dx += 1) {
        this.blend(originX + dx, originY + dy, particle);
      }
    }
  }
  /** Alpha-blend a particle's colour onto one framebuffer pixel (bounds-checked). */
  blend(x, y, particle) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const index = (y * this.width + x) * 4;
    const alpha = particle.alpha;
    this.output[index] = lerp3(this.output[index], particle.color[0], alpha);
    this.output[index + 1] = lerp3(this.output[index + 1], particle.color[1], alpha);
    this.output[index + 2] = lerp3(this.output[index + 2], particle.color[2], alpha);
    this.output[index + 3] = 255;
  }
};
var lerp3 = (a, b, t) => a + (b - a) * t;

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
    /** Presented-frame clock for animation, kept in lockstep with the scene backdrop. */
    this.presentFrame = 0;
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
      const seeded = seedCartridge(bytes, seed);
      const collisionLua = collisionSdkLua(this.options.collision);
      const withCollision = collisionLua ? prependLuaCode(seeded, collisionLua) : seeded;
      const preparedBytes = injectSdk(withCollision);
      this.console = createConsole(module, this.model, sampleRate);
      if (!this.console.loadCartridge(preparedBytes)) {
        throw new Error("Engine rejected the cartridge");
      }
      this.console.setMaterialCapture(Boolean(this.options.lighting));
      this.lastMailboxSeq = this.console.readMailbox()[0] ?? 0;
      const scale = this.options.scale ?? "fit";
      const scene = this.options.scene;
      this.anim = this.options.anim;
      const wantsForeground = Boolean(this.anim && this.anim.placements.length > 0);
      let backdrop = null;
      if (scene || wantsForeground) {
        this.cartSource = createCartSpriteSource(module, preparedBytes, this.model.paletteSize) ?? void 0;
      }
      if (scene && this.cartSource) {
        backdrop = {
          layers: resolveSceneLayers(scene, this.cartSource.source),
          keyRgb: this.cartSource.paletteRgb(scene.keyColor)
        };
      }
      const makeBaseSurface = async (target) => {
        let surface = this.options.lighting ? this.litSurface = await LitCanvasSurface.create(target, scale, this.model, this.options.lighting) : new CanvasSurface(target, scale, this.model);
        const particles = this.options.particles;
        if (particles && particles.emitters.length > 0) {
          surface = new ParticleOverlaySurface(surface, this.model.width, this.model.height, particles);
        }
        if (wantsForeground && this.cartSource) {
          surface = this.foregroundSurface = new AnimatedForegroundSurface(
            surface,
            this.model.width,
            this.model.height,
            this.cartSource.source
          );
        }
        if (scene && backdrop) {
          surface = this.sceneSurface = new SceneBackdropSurface(
            surface,
            this.model.width,
            this.model.height,
            backdrop.layers,
            scene,
            backdrop.keyRgb
          );
        }
        return surface;
      };
      const postFx = this.options.postFx;
      this.basePostFx = postFx;
      if (postFx && anyPostFxEnabled(postFx)) {
        const fx = await PostFxSurface.create(this.container, scale, this.model, postFx, makeBaseSurface);
        if (fx) this.postFxSurface = fx;
        this.surface = fx ?? await makeBaseSurface(this.container);
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
    if (this.destroyed || !this.console) return;
    if (!this.running) {
      this.running = true;
      this.lastFrameTime = this.view.performance.now();
      this.frameAccumulatorMs = 0;
      this.frameHandle = this.view.requestAnimationFrame(this.loop);
    }
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
        this.litSurface.setCartMaterial(this.console.readMaterial());
        this.litSurface.setCartEmissive(this.console.readEmissive());
      }
      if (this.sceneSurface && this.console) {
        this.sceneSurface.setCameraBase(decodeCamera(this.console.readMailbox()));
      }
      this.applyAnimation();
      this.surface?.blit(framebuffer);
      this.presentFrame += 1;
    }
  }
  /**
   * Sample the declared animation at the current presented frame and route it to
   * the surfaces that consume it. Feeds the scene backdrop's layer overrides, the
   * foreground placements, and (only when animated) the post-FX values. Runs before
   * blit so the composite reflects this frame; a no-op when no anim is declared.
   */
  applyAnimation() {
    if (!this.anim) return;
    const state = evaluate(this.anim, this.presentFrame);
    if (this.sceneSurface) {
      const hasLayerOverrides = Object.keys(state.layers).length > 0;
      this.sceneSurface.setLayerOverrides(hasLayerOverrides ? state.layers : null);
    }
    this.foregroundSurface?.setPlacements(state.placements);
    if (this.postFxSurface && this.basePostFx && Object.keys(state.postfx).length > 0) {
      this.postFxSurface.setSettings({
        ...this.basePostFx,
        values: { ...this.basePostFx.values, ...state.postfx }
      });
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
    this.cartSource?.dispose();
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

// src/fx/lensModel.ts
var TILT_SHIFT_FEATHER = 0.35;
var EPSILON2 = 1e-3;
function clamp012(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
function tiltShiftBlur(y, focus, range) {
  const outside = Math.abs(y - focus) - Math.max(0, range);
  if (outside <= 0) return 0;
  return clamp012(outside / TILT_SHIFT_FEATHER);
}
function reflectionSampleY(y, horizon) {
  return horizon - (y - horizon);
}
function reflectionFade(y, horizon, falloff) {
  const below = y - horizon;
  if (below <= 0) return 0;
  return clamp012(1 - below / Math.max(EPSILON2, falloff));
}

// src/scene/sceneModel.ts
var MAX_LAYERS = 8;
var MAX_TILE = 255;
var MAX_TILES_PER_SIDE = 32;
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
var clampInt = (v, lo, hi) => Math.round(clamp(v, lo, hi));
function parseRgb(raw, fallback) {
  if (!Array.isArray(raw) || raw.length < 3) return fallback;
  return [
    clampInt(num(raw[0], fallback[0]), 0, 255),
    clampInt(num(raw[1], fallback[1]), 0, 255),
    clampInt(num(raw[2], fallback[2]), 0, 255)
  ];
}
var DEFAULT_ATMOSPHERE = {
  fog: [96, 116, 168],
  density: 0.85,
  desaturate: 0.7,
  lift: 0.4
};
function parseRegion(raw) {
  if (!isObject(raw)) return null;
  const page = raw.page === 1 ? 1 : 0;
  const tile = clampInt(num(raw.tile, -1), 0, MAX_TILE);
  const tilesW = clampInt(num(raw.tilesW, 1), 1, MAX_TILES_PER_SIDE);
  const tilesH = clampInt(num(raw.tilesH, 1), 1, MAX_TILES_PER_SIDE);
  if (!Number.isInteger(tile) || num(raw.tile, -1) < 0) return null;
  return { page, tile, tilesW, tilesH };
}
function parseLayer(raw) {
  if (!isObject(raw)) return null;
  const source = parseRegion(raw.source);
  if (!source) return null;
  const layer = {
    source,
    depth: clamp(num(raw.depth, 0.5), 0, 1),
    wrapX: raw.wrapX === void 0 ? true : Boolean(raw.wrapX),
    offsetY: Math.round(num(raw.offsetY, 0))
  };
  if (typeof raw.parallax === "number" && Number.isFinite(raw.parallax)) {
    layer.parallax = clamp(raw.parallax, 0, 4);
  }
  return layer;
}
function parseScene(raw) {
  if (!isObject(raw)) return null;
  const layersRaw = Array.isArray(raw.layers) ? raw.layers : [];
  const layers = [];
  for (const entry of layersRaw) {
    if (layers.length >= MAX_LAYERS) break;
    const layer = parseLayer(entry);
    if (layer) layers.push(layer);
  }
  if (layers.length === 0) return null;
  const atmoRaw = isObject(raw.atmosphere) ? raw.atmosphere : {};
  const atmosphere = {
    fog: parseRgb(atmoRaw.fog, DEFAULT_ATMOSPHERE.fog),
    density: clamp(num(atmoRaw.density, DEFAULT_ATMOSPHERE.density), 0, 1),
    desaturate: clamp(num(atmoRaw.desaturate, DEFAULT_ATMOSPHERE.desaturate), 0, 1),
    lift: clamp(num(atmoRaw.lift, DEFAULT_ATMOSPHERE.lift), 0, 1)
  };
  const camRaw = isObject(raw.camera) ? raw.camera : {};
  const camera = {
    autoScrollX: num(camRaw.autoScrollX, 0),
    autoScrollY: num(camRaw.autoScrollY, 0)
  };
  const keyColor = clampInt(num(raw.keyColor, 0), 0, MAX_TILE);
  return { layers, atmosphere, camera, keyColor };
}

// src/anim/animModel.ts
var MAX_CLIPS = 32;
var MAX_TRACKS = 64;
var MAX_PLACEMENTS = 32;
var MAX_KEYS = 64;
var MAX_FRAMES = 64;
var MAX_TILE2 = 255;
var MAX_TILES_PER_SIDE2 = 32;
var MAX_LAYER_INDEX = 7;
var MAX_FRAME_TICKS = 600;
var isObject2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var num2 = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
var clamp2 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
var clampInt2 = (v, lo, hi) => Math.round(clamp2(v, lo, hi));
var ANIM_MODES = /* @__PURE__ */ new Set(["loop", "pingpong", "once"]);
var TRACK_MODES = /* @__PURE__ */ new Set(["loop", "pingpong", "hold"]);
var EASES = /* @__PURE__ */ new Set(["linear", "step", "smooth"]);
var LAYER_CHANNELS = /* @__PURE__ */ new Set(["opacity", "offsetX", "offsetY", "emissive"]);
var PLACEMENT_CHANNELS = /* @__PURE__ */ new Set(["x", "y", "opacity", "scale"]);
function parseRegion2(raw) {
  if (!isObject2(raw)) return null;
  if (typeof raw.tile !== "number" || !Number.isFinite(raw.tile) || raw.tile < 0) return null;
  return {
    page: raw.page === 1 ? 1 : 0,
    tile: clampInt2(raw.tile, 0, MAX_TILE2),
    tilesW: clampInt2(num2(raw.tilesW, 1), 1, MAX_TILES_PER_SIDE2),
    tilesH: clampInt2(num2(raw.tilesH, 1), 1, MAX_TILES_PER_SIDE2)
  };
}
function parseClip(raw) {
  if (!isObject2(raw)) return null;
  if (typeof raw.name !== "string" || raw.name.length === 0) return null;
  const framesRaw = Array.isArray(raw.frames) ? raw.frames : [];
  const frames = [];
  for (const entry of framesRaw) {
    if (frames.length >= MAX_FRAMES) break;
    const region = parseRegion2(entry);
    if (region) frames.push(region);
  }
  if (frames.length === 0) return null;
  const durationsRaw = Array.isArray(raw.durations) ? raw.durations : [];
  const durations = frames.map((_, i) => clampInt2(num2(durationsRaw[i], 1), 1, MAX_FRAME_TICKS));
  const mode = ANIM_MODES.has(raw.mode) ? raw.mode : "loop";
  return { name: raw.name, frames, durations, mode };
}
function parseKeyframe(raw) {
  if (!isObject2(raw)) return null;
  if (typeof raw.t !== "number" || !Number.isFinite(raw.t) || raw.t < 0) return null;
  if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) return null;
  return { t: raw.t, value: raw.value, ease: EASES.has(raw.ease) ? raw.ease : "linear" };
}
function parseTarget(raw, placementCount) {
  if (!isObject2(raw)) return null;
  if (raw.kind === "sceneLayer") {
    if (typeof raw.index !== "number" || !Number.isInteger(raw.index) || raw.index < 0 || raw.index > MAX_LAYER_INDEX) return null;
    if (!LAYER_CHANNELS.has(raw.channel)) return null;
    return { kind: "sceneLayer", index: raw.index, channel: raw.channel };
  }
  if (raw.kind === "postfx") {
    if (typeof raw.key !== "string" || raw.key.length === 0) return null;
    return { kind: "postfx", key: raw.key };
  }
  if (raw.kind === "placement") {
    if (typeof raw.index !== "number" || !Number.isInteger(raw.index) || raw.index < 0 || raw.index >= placementCount) return null;
    if (!PLACEMENT_CHANNELS.has(raw.channel)) return null;
    return { kind: "placement", index: raw.index, channel: raw.channel };
  }
  return null;
}
function parseTrack(raw, placementCount) {
  if (!isObject2(raw)) return null;
  const target = parseTarget(raw.target, placementCount);
  if (!target) return null;
  const keysRaw = Array.isArray(raw.keys) ? raw.keys : [];
  const keys = [];
  for (const entry of keysRaw) {
    if (keys.length >= MAX_KEYS) break;
    const key = parseKeyframe(entry);
    if (key) keys.push(key);
  }
  if (keys.length === 0) return null;
  keys.sort((a, b) => a.t - b.t);
  const track = {
    target,
    keys,
    mode: TRACK_MODES.has(raw.mode) ? raw.mode : "loop"
  };
  if (typeof raw.loopLength === "number" && Number.isFinite(raw.loopLength) && raw.loopLength > 0) {
    track.loopLength = raw.loopLength;
  }
  return track;
}
function parsePlacement(raw, clipNames) {
  if (!isObject2(raw)) return null;
  if (typeof raw.clip !== "string" || !clipNames.has(raw.clip)) return null;
  return {
    clip: raw.clip,
    x: num2(raw.x, 0),
    y: num2(raw.y, 0),
    depth: clamp2(num2(raw.depth, 0), 0, 1),
    opacity: clamp2(num2(raw.opacity, 1), 0, 1),
    scale: Math.max(0.01, num2(raw.scale, 1))
  };
}
function parseAnim(raw) {
  if (!isObject2(raw)) return null;
  const clips = [];
  const clipNames = /* @__PURE__ */ new Set();
  for (const entry of Array.isArray(raw.clips) ? raw.clips : []) {
    if (clips.length >= MAX_CLIPS) break;
    const clip = parseClip(entry);
    if (clip && !clipNames.has(clip.name)) {
      clipNames.add(clip.name);
      clips.push(clip);
    }
  }
  const placements = [];
  for (const entry of Array.isArray(raw.placements) ? raw.placements : []) {
    if (placements.length >= MAX_PLACEMENTS) break;
    const placement = parsePlacement(entry, clipNames);
    if (placement) placements.push(placement);
  }
  const tracks = [];
  for (const entry of Array.isArray(raw.tracks) ? raw.tracks : []) {
    if (tracks.length >= MAX_TRACKS) break;
    const track = parseTrack(entry, placements.length);
    if (track) tracks.push(track);
  }
  if (clips.length === 0 && tracks.length === 0 && placements.length === 0) return null;
  return { clips, tracks, placements };
}

// src/anim/generators.ts
function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state / 4294967296;
  };
}
function pulse(period, min, max) {
  const half = Math.max(1, Math.round(period / 2));
  return {
    keys: [
      { t: 0, value: min, ease: "smooth" },
      { t: half, value: max, ease: "smooth" }
    ],
    mode: "pingpong"
  };
}
function sway(period, amplitude, center = 0) {
  const half = Math.max(1, Math.round(period / 2));
  return {
    keys: [
      { t: 0, value: center - amplitude, ease: "smooth" },
      { t: half, value: center + amplitude, ease: "smooth" }
    ],
    mode: "pingpong"
  };
}
function drift(period, distance) {
  const length = Math.max(1, Math.round(period));
  return {
    keys: [
      { t: 0, value: 0, ease: "linear" },
      { t: length, value: distance, ease: "linear" }
    ],
    mode: "loop",
    loopLength: length
  };
}
function flicker(period, min, max, steps = 8, seed = 1) {
  const length = Math.max(2, Math.round(period));
  const count = Math.max(2, Math.min(64, Math.min(Math.round(steps), length)));
  const random = seededRandom(seed);
  const keys = [];
  let previousT = -1;
  for (let i = 0; i < count; i += 1) {
    let t = Math.floor(i / count * length);
    if (t <= previousT) t = previousT + 1;
    previousT = t;
    keys.push({ t, value: min + (max - min) * random(), ease: "step" });
  }
  return { keys, mode: "loop", loopLength: length };
}

// src/particles/particleModel.ts
var PARTICLE_KINDS = ["rain", "snow", "embers", "fog"];
var MAX_EMITTERS = 6;
var MAX_PARTICLES_PER_EMITTER = 600;
var PRESETS = {
  rain: { count: 220, color: [180, 205, 235], opacity: 0.35, size: 1, speed: 9, wind: -1.2 },
  snow: { count: 140, color: [235, 240, 255], opacity: 0.75, size: 2, speed: 1.4, wind: 0.3 },
  embers: { count: 60, color: [255, 150, 60], opacity: 0.9, size: 1, speed: 0.7, wind: 0.4 },
  fog: { count: 18, color: [150, 160, 180], opacity: 0.12, size: 7, speed: 0.25, wind: 0.5 }
};
function emitterPreset(kind, seed) {
  return { kind, seed, ...PRESETS[kind] };
}
function clamp3(value, min, max) {
  return value < min ? min : value > max ? max : value;
}
function readNumber(raw, min, max, fallback) {
  return typeof raw === "number" && Number.isFinite(raw) ? clamp3(raw, min, max) : fallback;
}
function readColor(raw, fallback) {
  if (!Array.isArray(raw) || raw.length !== 3) return [...fallback];
  const channels = raw.map((c) => typeof c === "number" && Number.isFinite(c) ? clamp3(Math.round(c), 0, 255) : null);
  if (channels.some((c) => c === null)) return [...fallback];
  return channels;
}
function parseEmitter(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw;
  const kind = record.kind;
  if (typeof kind !== "string" || !PARTICLE_KINDS.includes(kind)) return null;
  const preset = PRESETS[kind];
  return {
    kind,
    count: Math.round(readNumber(record.count, 1, MAX_PARTICLES_PER_EMITTER, preset.count)),
    color: readColor(record.color, preset.color),
    opacity: readNumber(record.opacity, 0, 1, preset.opacity),
    size: readNumber(record.size, 1, 8, preset.size),
    speed: readNumber(record.speed, 0, 12, preset.speed),
    wind: readNumber(record.wind, -6, 6, preset.wind),
    seed: Math.round(readNumber(record.seed, 0, 4294967295, 1))
  };
}
function parseParticles(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const rawEmitters = raw.emitters;
  if (!Array.isArray(rawEmitters)) return null;
  const emitters = [];
  for (const entry of rawEmitters) {
    if (emitters.length >= MAX_EMITTERS) break;
    const emitter = parseEmitter(entry);
    if (emitter) emitters.push(emitter);
  }
  return emitters.length > 0 ? { emitters } : null;
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
  AnimatedForegroundSurface,
  BLOOM_KNEE,
  BloomPyramid,
  CAMERA_BASE,
  CAMERA_SCALE,
  CARTBOX_SDK_LUA,
  CartridgeLoadError,
  ConsoleButton,
  DEFAULT_ATMOSPHERE,
  DEFAULT_KEY_BINDINGS,
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
  MAX_EMITTERS,
  MAX_PARTICLES_PER_EMITTER,
  MAX_PYRAMID_LEVELS,
  MIN_PYRAMID_DIMENSION,
  MODELS,
  NORMAL_DIRECTION_COUNT,
  NORMAL_VECTORS,
  PARTICLE_KINDS,
  POST_FX_EFFECTS,
  ParticleOverlaySurface,
  PostFxPass,
  PostFxSurface,
  REPLAY_VERSION,
  ReplayError,
  ReplayRecorder,
  ReplaySource,
  SceneBackdropSurface,
  TILT_SHIFT_FEATHER,
  WebgpuLightingLayer,
  acesFilmic,
  acesFilmicChannel,
  anyPostFxEnabled,
  cameraAt,
  collisionSdkLua,
  composeParallax,
  compositeOverBackdrop,
  createCartSpriteSource,
  createConsole,
  createFlatMaterial,
  createLightingLayer,
  decodeCamera,
  decodeLights,
  decodeMailbox,
  defaultPostFxSettings,
  drift,
  emitterPreset,
  evaluate,
  extractScore,
  extractUnlocks,
  fillSky,
  flicker,
  frameDurationMs,
  framebufferBytes,
  getModel,
  getWebgpuDevice,
  hashCart,
  hashEventId,
  hexToRgb01,
  injectSdk,
  interpolateNormal,
  loadEngineModule,
  mount,
  nearestDirection,
  normalVector,
  paramKey,
  parseAnim,
  parseCollisionField,
  parseParticles,
  parsePostFxSettings,
  parseReplay,
  parseScene,
  prehazeLayers,
  pulse,
  pyramidLevelCount,
  pyramidLevelSize,
  randomSeed,
  readCartCode,
  reflectionFade,
  reflectionSampleY,
  renderSceneBackdrop,
  resolveButton,
  resolveSceneLayers,
  resolveUnlockedAchievements,
  runReplayEvents,
  sampleClipFrame,
  sampleNormalBilinear,
  sampleTrack,
  seedCartridge,
  serializeReplay,
  shade,
  simulateEmitter,
  softKneePrefilter,
  sway,
  tiltShiftBlur,
  uniformsFromSettings,
  verifyReplayScore
};
