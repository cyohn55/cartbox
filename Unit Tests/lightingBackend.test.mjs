/**
 * Tests the backend selection in createLightingLayer (packages/player/src/
 * lighting/createLightingLayer.ts): it prefers WebGPU when a device is available,
 * falls back to WebGL otherwise, and returns null when neither works. The WebGPU
 * device/context are faked to a conformant shape, so this also smoke-tests that
 * WebgpuLightingLayer's pipeline/bind-group setup and a render() run to
 * completion without throwing. It does NOT validate GPU pixels — only a real
 * browser/GPU can — but it guards the selection and the setup call sequence.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/lightingBackend.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { createLightingLayer } = await import(
  pathToFileURL(path.resolve(here, "../packages/player/src/lighting/createLightingLayer.ts")).href
);

// WebgpuLightingLayer.create reads navigator.gpu.getPreferredCanvasFormat().
// navigator is a getter-only global in Node, so redefine it.
Object.defineProperty(globalThis, "navigator", {
  value: { gpu: { getPreferredCanvasFormat: () => "bgra8unorm" } },
  configurable: true,
  writable: true,
});

function fakeWebgpuDevice() {
  const view = () => ({});
  const texture = () => ({ createView: view, destroy() {} });
  const pass = { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
  return {
    createTexture: texture,
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: () => ({}),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
    queue: { writeBuffer() {}, writeTexture() {}, submit() {} },
  };
}

function fakeWebgpuContext() {
  return { configure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) };
}

function fakeGl() {
  const gl = {};
  const names = ["createShader", "shaderSource", "compileShader", "createProgram", "attachShader", "linkProgram",
    "useProgram", "createBuffer", "bindBuffer", "bufferData", "enableVertexAttribArray", "vertexAttribPointer",
    "createTexture", "bindTexture", "texParameteri", "activeTexture", "createFramebuffer", "bindFramebuffer",
    "framebufferTexture2D", "uniform1i", "uniform1f", "uniform2f", "uniform3f", "uniform1fv", "uniform3fv",
    "texImage2D", "viewport", "drawArrays",
    "deleteProgram", "deleteTexture", "deleteFramebuffer", "deleteBuffer"];
  for (const n of names) gl[n] = () => {};
  gl.getShaderParameter = () => true; gl.getProgramParameter = () => true;
  gl.getShaderInfoLog = () => ""; gl.getProgramInfoLog = () => "";
  gl.getAttribLocation = () => 0; gl.getUniformLocation = () => ({});
  gl.createShader = () => ({}); gl.createProgram = () => ({}); gl.createBuffer = () => ({});
  gl.createTexture = () => ({}); gl.createFramebuffer = () => ({});
  return gl;
}

function makeDoc({ webgpu = false, webgl = false } = {}) {
  return {
    createElement: () => ({
      style: {}, width: 0, height: 0, remove() {},
      getContext: (id) => {
        if (id === "webgpu") return webgpu ? fakeWebgpuContext() : null;
        if (id.includes("webgl")) return webgl ? fakeGl() : null;
        return null;
      },
    }),
  };
}

const albedo = new Uint8Array(4 * 2 * 4);
const scene = { lights: [{ x: 1, y: 1, z: 8, color: [1, 1, 1], radius: 20 }], ambient: 0.2, ambientColor: [0.5, 0.5, 0.8], bloom: true, shadows: false };

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("prefers WebGPU when a device is available", async () => {
  const built = await createLightingLayer(makeDoc({ webgpu: true }), 4, 2, async () => fakeWebgpuDevice());
  assert.ok(built, "a renderer should be built");
  assert.equal(built.renderer.backend, "webgpu");
  assert.doesNotThrow(() => built.renderer.render(albedo, null, scene), "a WebGPU frame should render without throwing");
  built.renderer.dispose();
});

test("falls back to WebGL when no WebGPU device is available", async () => {
  const built = await createLightingLayer(makeDoc({ webgl: true }), 4, 2, async () => null);
  assert.ok(built);
  assert.equal(built.renderer.backend, "webgl");
  built.renderer.dispose();
});

test("returns null when neither backend is available", async () => {
  const built = await createLightingLayer(makeDoc({}), 4, 2, async () => null);
  assert.equal(built, null);
});

test("falls back to WebGL if the WebGPU device is present but context setup fails", async () => {
  // Device resolves, but the canvas can't produce a webgpu context -> WebGPU
  // create() returns null -> WebGL is used (on a fresh canvas).
  const built = await createLightingLayer(makeDoc({ webgpu: false, webgl: true }), 4, 2, async () => fakeWebgpuDevice());
  assert.ok(built);
  assert.equal(built.renderer.backend, "webgl");
  built.renderer.dispose();
});

let passed = 0;
for (const [name, fn] of cases) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nlightingBackend: ${passed}/${cases.length} passed`);
