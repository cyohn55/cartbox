/**
 * Tests for LitCanvasSurface (packages/player/src/lighting/LitCanvasSurface.ts),
 * the glue that relights each presented frame. Uses a fake DOM + fake WebGL to
 * prove: the lit path pulls the frame's lights from the host each blit with an
 * advancing frame counter, cart lights merge with host lights, a material
 * provider is consulted per frame, autoDetect passes through unlit frames, and
 * the surface falls back to plain 2D (never throwing) when no GPU is available.
 *
 * In Node there is no navigator.gpu, so the factory selects the WebGL backend —
 * exactly the fallback path this exercises.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/litCanvasSurface.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const surfacePath = path.resolve(here, "../packages/player/src/lighting/LitCanvasSurface.ts");
const { LitCanvasSurface } = await import(pathToFileURL(surfacePath).href);

globalThis.ResizeObserver = class { observe() {} disconnect() {} };

const MODEL = { id: "classic", width: 4, height: 2, pixelBytes: 4 };
const albedo = new Uint8Array(MODEL.width * MODEL.height * MODEL.pixelBytes);

function fakeGl() {
  const gl = {
    FLOAT: 1, TEXTURE_2D: 2, ARRAY_BUFFER: 3, STATIC_DRAW: 4, TEXTURE_MIN_FILTER: 5,
    TEXTURE_MAG_FILTER: 6, TEXTURE_WRAP_S: 7, TEXTURE_WRAP_T: 8, NEAREST: 9, LINEAR: 10,
    CLAMP_TO_EDGE: 11, RGBA: 12, UNSIGNED_BYTE: 13, TRIANGLE_STRIP: 14, FRAMEBUFFER: 15,
    COLOR_ATTACHMENT0: 16, VERTEX_SHADER: 17, FRAGMENT_SHADER: 18, COMPILE_STATUS: 19,
    LINK_STATUS: 20, TEXTURE0: 33984, TEXTURE1: 33985,
    createShader: () => ({}), shaderSource() {}, compileShader() {}, getShaderParameter: () => true,
    getShaderInfoLog: () => "", createProgram: () => ({}), attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => "", useProgram() {},
    createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, getAttribLocation: () => 0,
    enableVertexAttribArray() {}, vertexAttribPointer() {}, createTexture: () => ({}), bindTexture() {},
    texParameteri() {}, activeTexture() {}, createFramebuffer: () => ({}), bindFramebuffer() {},
    framebufferTexture2D() {}, getUniformLocation: (_p, name) => ({ name }),
    uniform1i(loc, v) { if (loc.name === "uLightCount") gl.lightCount = v; if (loc.name === "uUnlit") gl.unlit = v; },
    uniform1f() {}, uniform2f() {}, uniform3f() {}, uniform1fv() {}, uniform3fv() {},
    activeTexture(unit) { gl.activeTex = unit; },
    // Record real pixel uploads (skip null FBO-storage allocations) tagged with
    // the bound texture unit, so tests can inspect what reached uMat (TEXTURE1).
    texImage2D(_t, _l, _if, _w, _h, _b, _f, _ty, pixels) {
      if (pixels) gl.uploads.push({ unit: gl.activeTex, data: pixels });
    },
    viewport() {}, drawArrays() { gl.draws += 1; }, deleteProgram() {}, deleteTexture() {},
    deleteFramebuffer() {}, deleteBuffer() {}, draws: 0, lightCount: -1, unlit: -1,
    activeTex: -1, uploads: [], TEXTURE1: 33985,
  };
  return gl;
}

// The material buffer is uploaded to the sampler bound to texture unit TEXTURE1;
// the albedo to TEXTURE0.
function lastMaterialUpload(gl) {
  const mat = gl.uploads.filter((u) => u.unit === gl.TEXTURE1);
  return mat.length ? mat[mat.length - 1].data : null;
}
function lastAlbedoUpload(gl) {
  const alb = gl.uploads.filter((u) => u.unit === gl.TEXTURE0);
  return alb.length ? alb[alb.length - 1].data : null;
}

function fake2d() {
  return { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} };
}

function makeContainer(webglSupported) {
  const gl = webglSupported ? fakeGl() : null;
  const makeCanvas = () => ({
    style: {}, width: 0, height: 0, remove() {},
    getContext: (id) => (id.includes("webgl") ? gl : id === "2d" ? fake2d() : null),
  });
  const view = { performance: { now: () => 1000 } };
  const container = {
    clientWidth: 800, clientHeight: 400,
    appendChild() {}, removeChild() {},
    ownerDocument: { defaultView: view, createElement: () => makeCanvas() },
  };
  return { container, gl };
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("selects the WebGL backend when WebGPU is unavailable", async () => {
  const { container } = makeContainer(true);
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, { lights: () => [] });
  assert.equal(surface.isLit, true);
  assert.equal(surface.backend, "webgl");
  surface.destroy();
});

test("calls the light provider each frame with an advancing frame counter", async () => {
  const { container, gl } = makeContainer(true);
  const seen = [];
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, {
    lights: (context) => { seen.push(context); return [{ x: 1, y: 1, z: 8, color: [1, 1, 1], radius: 10 }]; },
    bloom: false,
  });
  surface.blit(albedo);
  surface.blit(albedo);
  surface.blit(albedo);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((c) => c.frame), [0, 1, 2]);
  assert.equal(seen[0].width, MODEL.width);
  assert.ok(gl.draws > 0, "the lighting layer should have drawn");
  surface.destroy();
});

test("consults a material provider once per frame", async () => {
  const { container } = makeContainer(true);
  let materialCalls = 0;
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, {
    lights: () => [], material: () => { materialCalls += 1; return null; }, bloom: false,
  });
  surface.blit(albedo);
  surface.blit(albedo);
  assert.equal(materialCalls, 2);
  surface.destroy();
});

test("engine-emitted material takes precedence over the host material provider", async () => {
  const { container, gl } = makeContainer(true);
  let providerCalls = 0;
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, {
    lights: () => [{ x: 1, y: 1, z: 8, color: [1, 1, 1], radius: 10 }],
    material: () => { providerCalls += 1; return null; },
    bloom: false,
  });
  // A distinctive material the engine produced this frame (normal idx in R).
  const engineMaterial = new Uint8Array(MODEL.width * MODEL.height * 4);
  engineMaterial[0] = 7; // sprite pixel 0 -> normal direction index 7
  surface.setCartMaterial(engineMaterial);
  surface.blit(albedo);

  assert.equal(providerCalls, 0, "the host provider must be skipped when the engine supplies material");
  const uploaded = lastMaterialUpload(gl);
  assert.ok(uploaded, "a material texture should have been uploaded");
  assert.equal(uploaded[0], 7, "the cart's authored normal index should reach the shader");
  surface.destroy();
});

test("falls back to the host material provider when the engine material is empty", async () => {
  const { container } = makeContainer(true);
  let providerCalls = 0;
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, {
    lights: () => [{ x: 1, y: 1, z: 8, color: [1, 1, 1], radius: 10 }],
    material: () => { providerCalls += 1; return null; },
    bloom: false,
  });
  surface.setCartMaterial(new Uint8Array(0)); // capture disabled / no material this frame
  surface.blit(albedo);
  assert.equal(providerCalls, 1, "an empty engine buffer must defer to the host provider");
  surface.destroy();
});

test("engine material is copied off the growable WASM buffer, not aliased", async () => {
  const { container, gl } = makeContainer(true);
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, {
    lights: () => [{ x: 1, y: 1, z: 8, color: [1, 1, 1], radius: 10 }],
    bloom: false,
  });
  // Simulate the engine's view over WASM memory being overwritten on the next
  // tick after the surface has consumed it.
  const engineView = new Uint8Array(MODEL.width * MODEL.height * 4);
  engineView[0] = 3;
  surface.setCartMaterial(engineView);
  surface.blit(albedo);
  const uploaded = lastMaterialUpload(gl);
  engineView[0] = 99; // the next tick clobbers the shared buffer

  assert.notEqual(uploaded, engineView, "the uploaded material must be a distinct buffer");
  assert.equal(uploaded[0], 3, "the copy taken at blit time must be unaffected by later mutation");
  surface.destroy();
});

test("folds engine emissive into the albedo alpha the shader reads", async () => {
  const { container, gl } = makeContainer(true);
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, {
    lights: () => [{ x: 1, y: 1, z: 8, color: [1, 1, 1], radius: 10 }],
    bloom: false,
  });
  const emissive = new Uint8Array(MODEL.width * MODEL.height);
  emissive[0] = 200; // pixel 0 strongly self-lit
  emissive[3] = 0; // pixel 3 lit normally
  surface.setCartEmissive(emissive);
  surface.blit(albedo);

  const uploaded = lastAlbedoUpload(gl);
  assert.ok(uploaded, "an albedo texture should have been uploaded");
  assert.equal(uploaded[0 * 4 + 3], 200, "pixel 0's emissive should land in the albedo alpha");
  assert.equal(uploaded[3 * 4 + 3], 0, "pixel 3 stays lit-normally (alpha 0)");
  surface.destroy();
});

test("an empty emissive buffer leaves the albedo alpha untouched", async () => {
  const { container, gl } = makeContainer(true);
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, {
    lights: () => [{ x: 1, y: 1, z: 8, color: [1, 1, 1], radius: 10 }],
    bloom: false,
  });
  // A framebuffer whose alpha is already opaque, as the engine delivers it.
  const opaque = new Uint8Array(MODEL.width * MODEL.height * 4);
  for (let i = 0; i < MODEL.width * MODEL.height; i += 1) opaque[i * 4 + 3] = 255;
  surface.setCartEmissive(new Uint8Array(0));
  surface.blit(opaque);

  const uploaded = lastAlbedoUpload(gl);
  assert.equal(uploaded[3], 255, "without engine emissive the framebuffer alpha is preserved");
  surface.destroy();
});

test("merges cart-emitted lights with host lights", async () => {
  const { container, gl } = makeContainer(true);
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, {
    lights: () => [{ x: 0, y: 0, z: 8, color: [1, 1, 1], radius: 10 }], bloom: false,
  });
  surface.setCartLights([
    { x: 1, y: 1, z: 8, color: [1, 0, 0], radius: 20 },
    { x: 2, y: 2, z: 8, color: [0, 1, 0], radius: 20 },
  ]);
  surface.blit(albedo);
  assert.equal(gl.lightCount, 3, "2 cart lights + 1 host light should reach the shader");
  surface.destroy();
});

test("a cart can drive lighting with no host light provider", async () => {
  const { container, gl } = makeContainer(true);
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, { bloom: false });
  surface.setCartLights([{ x: 1, y: 1, z: 8, color: [1, 1, 1], radius: 20 }]);
  surface.blit(albedo);
  assert.equal(gl.lightCount, 1);
  surface.destroy();
});

test("autoDetect renders an unlit passthrough when there are no lights", async () => {
  const { container, gl } = makeContainer(true);
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, { autoDetect: true });
  surface.blit(albedo);
  assert.equal(gl.unlit, 1, "no lights + autoDetect should pass through unlit");
  surface.destroy();
});

test("autoDetect lights normally once a light is present", async () => {
  const { container, gl } = makeContainer(true);
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, { autoDetect: true });
  surface.setCartLights([{ x: 1, y: 1, z: 8, color: [1, 1, 1], radius: 20 }]);
  surface.blit(albedo);
  assert.equal(gl.unlit, 0);
  surface.destroy();
});

test("without autoDetect, no lights still lights (ambient floor, not passthrough)", async () => {
  const { container, gl } = makeContainer(true);
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, { lights: () => [] });
  surface.blit(albedo);
  assert.equal(gl.unlit, 0);
  surface.destroy();
});

test("falls back to plain 2D when no GPU backend is available, without throwing", async () => {
  const { container } = makeContainer(false);
  let lightCalls = 0;
  const surface = await LitCanvasSurface.create(container, "fit", MODEL, { lights: () => { lightCalls += 1; return []; } });
  assert.equal(surface.isLit, false);
  assert.equal(surface.backend, "2d");
  assert.doesNotThrow(() => surface.blit(albedo));
  assert.equal(lightCalls, 0, "the fallback should not run the lighting provider");
  surface.destroy();
});

let passed = 0;
for (const [name, fn] of cases) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nlitCanvasSurface: ${passed}/${cases.length} passed`);
