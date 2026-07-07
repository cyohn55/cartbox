/**
 * Smoke tests for LightingLayer (packages/player/src/lighting/LightingLayer.ts).
 * A browser isn't available here, so the renderer is driven against a fake WebGL
 * context that records draws, texture uploads, and uniforms. This proves the
 * multi-pass pipeline runs, the flat-material fallback is well-formed, and
 * shadows stay disabled without a material — without asserting pixel colours,
 * which only a real GPU produces.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/lightingLayer.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const layerPath = path.resolve(here, "../packages/player/src/lighting/LightingLayer.ts");
const { LightingLayer } = await import(pathToFileURL(layerPath).href);

const cap = { draws: 0, uploads: [], uniforms: {} };

function makeFakeGl() {
  const gl = {
    // enums the layer touches
    FLOAT: 1, TEXTURE_2D: 2, ARRAY_BUFFER: 3, STATIC_DRAW: 4,
    TEXTURE_MIN_FILTER: 5, TEXTURE_MAG_FILTER: 6, TEXTURE_WRAP_S: 7, TEXTURE_WRAP_T: 8,
    NEAREST: 9, LINEAR: 10, CLAMP_TO_EDGE: 11, RGBA: 12, UNSIGNED_BYTE: 13,
    TRIANGLE_STRIP: 14, FRAMEBUFFER: 15, COLOR_ATTACHMENT0: 16,
    VERTEX_SHADER: 17, FRAGMENT_SHADER: 18, COMPILE_STATUS: 19, LINK_STATUS: 20,
    TEXTURE0: 33984, TEXTURE1: 33985,
    createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getShaderInfoLog: () => "",
    createProgram: () => ({}), attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => "", useProgram() {},
    createBuffer: () => ({}), bindBuffer() {}, bufferData() {},
    getAttribLocation: () => 0, enableVertexAttribArray() {}, vertexAttribPointer() {},
    createTexture: () => ({}), bindTexture() {}, texParameteri() {}, activeTexture() {},
    createFramebuffer: () => ({}), bindFramebuffer() {}, framebufferTexture2D() {},
    getUniformLocation: (_p, name) => ({ name }),
    uniform1i(loc, v) { cap.uniforms[loc.name] = v; },
    uniform1f(loc, v) { cap.uniforms[loc.name] = v; },
    uniform2f() {}, uniform3f() {}, uniform1fv() {}, uniform3fv() {},
    texImage2D(_t, _l, _if, _w, _h, _b, _f, _ty, pixels) { if (pixels) cap.uploads.push(pixels); },
    viewport() {}, drawArrays() { cap.draws += 1; },
    deleteProgram() {}, deleteTexture() {}, deleteFramebuffer() {}, deleteBuffer() {},
  };
  return gl;
}

function makeFakeCanvas() {
  const gl = makeFakeGl();
  return { width: 0, height: 0, getContext: (id) => (id.includes("webgl") ? gl : null) };
}

const W = 4, H = 2;
const albedo = new Uint8Array(W * H * 4);
const material = new Uint8Array(W * H * 4).fill(64);
const baseScene = { lights: [{ x: 1, y: 1, z: 10, color: [1, 1, 1], radius: 20 }], ambient: 0.2, ambientColor: [0.5, 0.5, 0.8] };

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("isSupported is true for a canvas that yields a GL context", () => {
  assert.equal(LightingLayer.isSupported(makeFakeCanvas()), true);
});

test("isSupported is false when no GL context is available", () => {
  assert.equal(LightingLayer.isSupported({ width: 0, height: 0, getContext: () => null }), false);
});

let layer;
test("constructs and sizes the canvas to the native resolution", () => {
  const canvas = makeFakeCanvas();
  layer = new LightingLayer(canvas, W, H);
  assert.equal(canvas.width, W);
  assert.equal(canvas.height, H);
});

test("a bloom-on frame runs all five passes", () => {
  cap.draws = 0;
  layer.render(albedo, material, { ...baseScene, bloom: true, shadows: false });
  // light + bright + blurH + blurV + composite
  assert.equal(cap.draws, 5);
});

test("a bloom-off frame runs only lighting + composite", () => {
  cap.draws = 0;
  layer.render(albedo, material, { ...baseScene, bloom: false, shadows: false });
  assert.equal(cap.draws, 2);
});

test("light count is uploaded and clamped to the shader maximum (6)", () => {
  const many = Array.from({ length: 9 }, () => ({ x: 0, y: 0, z: 5, color: [1, 1, 1], radius: 10 }));
  layer.render(albedo, material, { lights: many, ambient: 0.2, ambientColor: [0, 0, 0], bloom: false, shadows: false });
  assert.equal(cap.uniforms.uLightCount, 6);
});

test("a null material uploads a well-formed flat material (rough=255, normal=0)", () => {
  cap.uploads.length = 0;
  layer.render(albedo, null, { ...baseScene, bloom: false, shadows: false });
  const uploadedMaterial = cap.uploads.at(-1); // albedo then material each frame
  assert.equal(uploadedMaterial.length, W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    assert.equal(uploadedMaterial[i * 4], 0, "normal index should be 0 (flat)");
    assert.equal(uploadedMaterial[i * 4 + 3], 255, "roughness should be full");
  }
});

test("shadows stay disabled without a material even when requested", () => {
  layer.render(albedo, null, { ...baseScene, bloom: false, shadows: true });
  assert.equal(cap.uniforms.uEnableShadows, 0);
});

test("shadows enable when a material is supplied and requested", () => {
  layer.render(albedo, material, { ...baseScene, bloom: false, shadows: true });
  assert.equal(cap.uniforms.uEnableShadows, 1);
});

test("a lit frame marks uUnlit = 0", () => {
  layer.render(albedo, material, { ...baseScene, bloom: false, shadows: false });
  assert.equal(cap.uniforms.uUnlit, 0);
});

test("an unlit passthrough sets uUnlit = 1 and skips bloom (2 draws)", () => {
  cap.draws = 0;
  layer.render(albedo, material, { ...baseScene, bloom: true, shadows: false, unlit: true });
  assert.equal(cap.uniforms.uUnlit, 1);
  assert.equal(cap.draws, 2); // bloom is suppressed for a passthrough
});

test("dispose runs without throwing", () => {
  assert.doesNotThrow(() => layer.dispose());
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nlightingLayer: ${passed}/${cases.length} passed`);
