/**
 * Tests for PostFxSurface (packages/player/src/fx/PostFxSurface.ts), the glue
 * that draws every presented frame through the post-process chain. Uses a fake
 * DOM + fake WebGL to prove: frames flow inner-blit → GPU sample of the inner
 * canvas → draw with the settings' uniforms; setSettings retunes the next
 * frame; and creation fails soft (null, inner factory untouched or cleaned up)
 * when WebGL or the inner canvas is missing.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/postFxSurface.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const surfacePath = path.resolve(here, "../packages/player/src/fx/PostFxSurface.ts");
const settingsPath = path.resolve(here, "../packages/player/src/fx/postfx.ts");
const { PostFxSurface } = await import(pathToFileURL(surfacePath).href);
const { defaultPostFxSettings, paramKey } = await import(pathToFileURL(settingsPath).href);

globalThis.ResizeObserver = class { observe() {} disconnect() {} };

const MODEL = { id: "classic", width: 4, height: 2, pixelBytes: 4 };
const frame = new Uint8Array(MODEL.width * MODEL.height * MODEL.pixelBytes);

function fakeGl() {
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5,
    STATIC_DRAW: 6, FLOAT: 7, TEXTURE_2D: 8, TEXTURE_MIN_FILTER: 9, TEXTURE_MAG_FILTER: 10,
    TEXTURE_WRAP_S: 11, TEXTURE_WRAP_T: 12, NEAREST: 13, CLAMP_TO_EDGE: 14, RGBA: 15,
    UNSIGNED_BYTE: 16, TRIANGLE_STRIP: 17, TEXTURE0: 33984,
    drawingBufferWidth: 12, drawingBufferHeight: 6,
    createShader: () => ({}), shaderSource() {}, compileShader() {}, getShaderParameter: () => true,
    getShaderInfoLog: () => "", createProgram: () => ({}), attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => "", useProgram() {},
    createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, getAttribLocation: () => 0,
    enableVertexAttribArray() {}, vertexAttribPointer() {}, createTexture: () => ({}),
    bindTexture() {}, texParameteri() {}, activeTexture() {},
    getUniformLocation: (_program, name) => ({ name }),
    uniform1i() {}, uniform2f() {}, uniform3f() {},
    uniform1f(location, value) { gl.uniforms[location.name] = value; },
    texImage2D(...args) { gl.lastTextureSource = args[args.length - 1]; },
    viewport() {}, drawArrays() { gl.draws += 1; }, deleteTexture() {}, deleteProgram() {},
    draws: 0, uniforms: {}, lastTextureSource: null,
  };
  return gl;
}

function makeDom(webglSupported) {
  const gl = webglSupported ? fakeGl() : null;
  const document = {
    createElement(tag) {
      if (tag === "canvas") {
        return {
          isCanvas: true, style: {}, width: 0, height: 0, removed: false,
          remove() { this.removed = true; },
          getContext: (id) => (id.includes("webgl") ? gl : null),
        };
      }
      return {
        children: [],
        appendChild(child) { this.children.push(child); },
        querySelector() { return this.children.find((child) => child.isCanvas) ?? null; },
      };
    },
  };
  const container = {
    clientWidth: 800, clientHeight: 400, appended: [],
    appendChild(child) { this.appended.push(child); },
    ownerDocument: document,
  };
  return { container, gl, document };
}

/** An inner-surface factory that appends a canvas and records its calls. */
function makeInnerFactory(document, { appendCanvas = true } = {}) {
  const record = { created: 0, blits: 0, destroyed: 0, canvas: null };
  const factory = (target) => {
    record.created += 1;
    if (appendCanvas) {
      record.canvas = document.createElement("canvas");
      target.appendChild(record.canvas);
    }
    return { blit: () => { record.blits += 1; }, destroy: () => { record.destroyed += 1; } };
  };
  return { factory, record };
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("blit drives the inner surface, samples its canvas, and draws", async () => {
  const { container, gl, document } = makeDom(true);
  const { factory, record } = makeInnerFactory(document);
  const settings = defaultPostFxSettings();
  settings.enabled.fog = true;
  settings.values[paramKey("fog", "density")] = 0.7;

  const surface = await PostFxSurface.create(container, "fit", MODEL, settings, factory);
  assert.ok(surface, "surface should build with WebGL available");
  surface.blit(frame);
  surface.blit(frame);

  assert.equal(record.blits, 2, "each blit must reach the inner surface");
  assert.equal(gl.draws, 2, "each blit must draw through the FX pass");
  assert.equal(gl.lastTextureSource, record.canvas, "the FX pass must sample the inner canvas");
  assert.equal(gl.uniforms.uFogDensity, 0.7, "settings must reach the shader as uniforms");
  assert.equal(container.appended.length, 1, "only the FX canvas is mounted in the container");
  surface.destroy();
});

test("setSettings retunes the uniforms for the next frame", async () => {
  const { container, gl, document } = makeDom(true);
  const { factory } = makeInnerFactory(document);
  const surface = await PostFxSurface.create(container, "fit", MODEL, defaultPostFxSettings(), factory);
  surface.blit(frame);
  assert.equal(gl.uniforms.uVignette, 0, "disabled vignette folds to neutral");

  const retuned = defaultPostFxSettings();
  retuned.enabled.vignette = true;
  retuned.values[paramKey("vignette", "strength")] = 0.5;
  surface.setSettings(retuned);
  surface.blit(frame);
  assert.equal(gl.uniforms.uVignette, 0.5);
  surface.destroy();
});

test("returns null without touching the inner factory when WebGL is missing", async () => {
  const { container, document } = makeDom(false);
  const { factory, record } = makeInnerFactory(document);
  const surface = await PostFxSurface.create(container, "fit", MODEL, defaultPostFxSettings(), factory);
  assert.equal(surface, null);
  assert.equal(record.created, 0, "the inner surface must not be built when FX can't run");
});

test("returns null and cleans up when the inner surface exposes no canvas", async () => {
  const { container, document } = makeDom(true);
  const { factory, record } = makeInnerFactory(document, { appendCanvas: false });
  const surface = await PostFxSurface.create(container, "fit", MODEL, defaultPostFxSettings(), factory);
  assert.equal(surface, null);
  assert.equal(record.created, 1);
  assert.equal(record.destroyed, 1, "a canvas-less inner surface must be destroyed");
});

test("destroy tears down the inner surface and removes the FX canvas", async () => {
  const { container, document } = makeDom(true);
  const { factory, record } = makeInnerFactory(document);
  const surface = await PostFxSurface.create(container, "fit", MODEL, defaultPostFxSettings(), factory);
  surface.destroy();
  assert.equal(record.destroyed, 1);
  assert.equal(container.appended[0].removed, true);
});

let passed = 0;
for (const [name, fn] of cases) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\npostFxSurface: ${passed}/${cases.length} passed`);
