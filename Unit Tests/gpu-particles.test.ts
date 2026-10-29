/**
 * GPU particles (AAA_FIDELITY_ROADMAP.md F8a): emitters compiled from their
 * module stacks, the reference simulation (spawning in a ring, forces, curl
 * noise, distance shapes), and on a real device (Dawn) the compute passes
 * against the reference, the bitonic sort, depth-buffer collisions and the
 * particles drawn in a frame.
 */

import { describe, expect, it } from "vitest";

import {
  CpuEmitter,
  PARTICLE_FLOATS,
  compileEmitter,
  composeModelMatrix,
  curlNoise,
  emitterFromEffect,
  flipbookFrame,
  parseEmitters,
  particlePreset,
  particleRandom,
  pcg,
  projectionMatrix,
  ringSize,
  sdfShape,
  viewMatrix,
  type EmitterSpec,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { GpuParticles, bitonicStages } from "../packages/player/src/render/gpuParticles";
import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";

const fountain: EmitterSpec = {
  name: "fountain",
  capacity: 200,
  modules: [
    { type: "spawnBurst", count: 64 },
    { type: "shape", kind: "cone", angle: 0.4 },
    { type: "velocity", speed: 4, jitter: 0.2 },
    { type: "lifetime", seconds: 3 },
    { type: "gravity", acceleration: [0, -9.81, 0] },
    { type: "drag", amount: 0.3 },
    { type: "curlNoise", strength: 2, scale: 1.5, speed: 1 },
    { type: "collideShapes", shapes: [{ kind: "plane", normal: [0, 1, 0], offset: 0 }], restitution: 0.5 },
    { type: "render", mode: "sprite", blend: "additive" },
  ],
};

describe("emitters", () => {
  it("compiles a module stack, rounding its ring to a power of two", () => {
    const p = compileEmitter(fountain);
    expect(p.capacity).toBe(256);
    expect(ringSize(1000)).toBe(1024);
    expect(p.burst).toBe(64);
    expect(p.shape).toBe(2);
    expect(p.gravity).toEqual([0, -9.81, 0]);
    expect(p.shapes).toHaveLength(1);
    expect(p.additive).toBe(true);
    // Later modules win, and values are clamped.
    expect(compileEmitter({ name: "x", capacity: 4, modules: [{ type: "drag", amount: 1 }, { type: "drag", amount: 500 }] }).drag).toBe(100);
  });

  it("turns a billboard effect into an emitter, and reads stored ones defensively", () => {
    const e = compileEmitter(emitterFromEffect(particlePreset("smoke")));
    expect(e.additive).toBe(false);
    expect(e.gravity[1]).toBeCloseTo(0.6);
    expect(parseEmitters([{ name: "a", capacity: 64, modules: [{ type: "bogus" }, { type: "drag", amount: 1 }] }, { nope: 1 }])).toEqual([{ name: "a", capacity: 64, modules: [{ type: "drag", amount: 1 }] }]);
  });

  it("hashes alike every time, into [0, 1)", () => {
    expect(pcg(1)).toBe(pcg(1));
    expect(pcg(1)).not.toBe(pcg(2));
    const xs = Array.from({ length: 1000 }, (_, i) => particleRandom(i, 3));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((a, b) => a + b, 0) / xs.length).toBeCloseTo(0.5, 1);
  });

  it("swirls without gathering: curl noise has no divergence", () => {
    const h = 1e-4;
    for (const [x, y, z] of [[0.3, 0.7, -1.2], [2, -1, 0.5]] as const) {
      const div =
        (curlNoise(x + h, y, z, 1.3, 0.4)[0] - curlNoise(x - h, y, z, 1.3, 0.4)[0] + curlNoise(x, y + h, z, 1.3, 0.4)[1] - curlNoise(x, y - h, z, 1.3, 0.4)[1] + curlNoise(x, y, z + h, 1.3, 0.4)[2] - curlNoise(x, y, z - h, 1.3, 0.4)[2]) /
        (2 * h);
      expect(Math.abs(div)).toBeLessThan(1e-5);
    }
  });

  it("measures distance shapes", () => {
    expect(sdfShape({ kind: "sphere", center: [0, 0, 0], radius: 1 }, [2, 0, 0]).d).toBeCloseTo(1);
    expect(sdfShape({ kind: "box", center: [0, 0, 0], half: [1, 1, 1] }, [0, 0.5, 0]).d).toBeCloseTo(-0.5);
    const plane = sdfShape({ kind: "plane", normal: [0, 2, 0], offset: 1 }, [5, 0, 0]);
    expect(plane.d).toBeCloseTo(-1);
    expect(plane.n).toEqual([0, 1, 0]);
  });

  it("spawns into a ring, falls, and bounces off a plane", () => {
    const e = new CpuEmitter(compileEmitter({ ...fountain, modules: fountain.modules.filter((m) => m.type !== "curlNoise") }));
    e.spawn(64, [0, 1, 0], [0, 1, 0]);
    expect(e.alive).toBe(64);
    for (let i = 0; i < 120; i += 1) e.step(1 / 60);
    // Two seconds on, every one is above the floor (bounced), none below.
    expect(Math.min(...e.particles.flatMap((q) => (q ? [q.p[1]] : [])))).toBeGreaterThanOrEqual(-1e-9);
    // A full ring recycles: 256 slots, 300 born.
    e.spawn(236, [0, 1, 0]);
    expect(e.head).toBe(300 % 256);
    expect(e.born).toBe(300);
  });

  it("carries the rate's fractions across steps, and picks flipbook frames", () => {
    const e = new CpuEmitter(compileEmitter({ name: "r", capacity: 64, modules: [{ type: "spawnRate", rate: 25 }] }));
    let total = 0;
    for (let i = 0; i < 60; i += 1) total += e.rateSpawns(1 / 60);
    expect(total).toBe(25);
    expect(flipbookFrame(0.5, 8)).toEqual({ frame: 4, next: 5, blend: 0 });
    expect(flipbookFrame(1, 8).frame).toBe(7);
    expect(bitonicStages(8)).toEqual([[2, 1], [4, 2], [4, 1], [8, 4], [8, 2], [8, 1]]);
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}
const device = await realDevice();

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 4000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

async function readBuffer(buffer: any, bytes: number): Promise<ArrayBuffer> {
  const staging = device.createBuffer({ size: bytes, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await settled(staging.mapAsync(1));
  const out = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return out;
}

const W = 32;
const H = 32;

describe.skipIf(!device)("particles on a real device", { timeout: 300_000 }, () => {
  /** A depth buffer at the far plane and an empty G-buffer, for simulating without a scene. */
  function emptyFrame() {
    const depth = device.createTexture({ size: { width: W, height: H }, format: "depth24plus", usage: 0x10 | 0x04 });
    const gbuffer = device.createTexture({ size: { width: W, height: H }, format: "rgba16float", usage: 0x10 | 0x04 });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: gbuffer.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }], depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    pass.end();
    device.queue.submit([encoder.finish()]);
    return { depth, gbuffer };
  }
  const frame = { dt: 1 / 60, time: 0, viewProj: Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0)), width: W, height: H, depthTerms: [0, 1] as [number, number], eye: [0, 0, 5], right: [1, 0, 0], up: [0, 1, 0], light: { direction: [0, 1, 0], color: [1, 1, 1], ambient: 0.2, lights: 0 } };

  it("simulates as the reference does: spawns, forces, curl noise and the plane", async () => {
    const { depth, gbuffer } = emptyFrame();
    const gpu = new GpuParticles(device, "rgba16float", [fountain]);
    const cpu = new CpuEmitter(compileEmitter(fountain));
    gpu.burst(0, [0, 1, 0], [0, 1, 0]);
    cpu.spawn(64, [0, 1, 0], [0, 1, 0]);
    device.pushErrorScope("validation");
    for (let i = 0; i < 60; i += 1) {
      const encoder = device.createCommandEncoder();
      // The step's time is the time after it, as the reference keeps it.
      gpu.simulate(encoder, { ...frame, time: (i + 1) / 60 }, depth, gbuffer);
      device.queue.submit([encoder.finish()]);
      cpu.step(1 / 60);
    }
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const ring = gpu.ring(0)!;
    const data = new Float32Array(await readBuffer(ring.buffer, ring.capacity * PARTICLE_FLOATS * 4));
    let worst = 0;
    for (let s = 0; s < 64; s += 1) {
      const q = cpu.particles[s]!;
      for (let k = 0; k < 3; k += 1) worst = Math.max(worst, Math.abs(data[s * PARTICLE_FLOATS + k]! - q.p[k]!));
      expect(data[s * PARTICLE_FLOATS + 3]).toBeCloseTo(q.age, 4);
    }
    // A second of gravity, drag, curl and bounces: within a few millimetres (f32 against f64).
    expect(worst).toBeLessThan(5e-3);
    // Dead slots stay dead.
    expect(data[100 * PARTICLE_FLOATS + 3]).toBeGreaterThanOrEqual(data[100 * PARTICLE_FLOATS + 7]!);
    gpu.dispose();
  });

  it("sorts a blended emitter back to front", async () => {
    const { depth, gbuffer } = emptyFrame();
    const smoke: EmitterSpec = { name: "smoke", capacity: 512, modules: [{ type: "spawnBurst", count: 300 }, { type: "shape", kind: "sphere", radius: 3 }, { type: "velocity", speed: 0 }, { type: "lifetime", seconds: 5 }, { type: "render", mode: "sprite", blend: "alpha" }] };
    const gpu = new GpuParticles(device, "rgba16float", [smoke]);
    gpu.burst(0, [0, 0, 0]);
    // A view looking down −z from z = 10: clip w is the distance along −z.
    const view = viewMatrix([0, 0, 10], [0, 0, 0]);
    const proj = projectionMatrix(Math.PI / 3, 1, 0.1, 100);
    const viewProj = Array.from({ length: 16 }, (_, i) => {
      const c = Math.floor(i / 4);
      const r = i % 4;
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += proj[k * 4 + r]! * view[c * 4 + k]!;
      return s;
    });
    const encoder = device.createCommandEncoder();
    gpu.simulate(encoder, { ...frame, viewProj }, depth, gbuffer);
    device.queue.submit([encoder.finish()]);
    const pairs = new Uint32Array(await readBuffer((gpu as any).emitters[0].pairs, 512 * 8));
    const particles = new Float32Array(await readBuffer(gpu.ring(0)!.buffer, 512 * PARTICLE_FLOATS * 4));
    // The 300 alive first, farthest (smallest z) first; the dead after.
    const zs = Array.from({ length: 300 }, (_, i) => particles[pairs[i * 2 + 1]! * PARTICLE_FLOATS + 2]!);
    for (let i = 1; i < zs.length; i += 1) expect(zs[i]!).toBeGreaterThanOrEqual(zs[i - 1]! - 1e-4);
    expect(pairs[300 * 2]).toBe(0xffffffff);
    gpu.dispose();
  });

  function floor(): MeshAsset {
    return {
      name: "floor",
      primitives: [
        {
          positions: Float32Array.from([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5]),
          normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
          uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
          indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
          material: { name: "floor", baseColorFactor: [0.2, 0.2, 0.2, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
        },
      ],
    } as unknown as MeshAsset;
  }

  it("draws glowing particles into the frame, and bounces them off the depth buffer", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const sparks: EmitterSpec = {
      name: "sparks",
      capacity: 256,
      modules: [
        { type: "spawnBurst", count: 128 },
        { type: "shape", kind: "sphere", radius: 0.3 },
        { type: "velocity", speed: 0.5 },
        { type: "lifetime", seconds: 4 },
        { type: "size", start: 0.3 },
        { type: "color", start: [1, 0.6, 0.2, 1], glow: 4 },
        { type: "gravity", acceleration: [0, -9.81, 0] },
        { type: "collideDepth", restitution: 0.3 },
        { type: "render", mode: "sprite", blend: "additive" },
      ],
    };
    renderer.setParticles([sparks]);
    const instances = [{ mesh: floor(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[];
    const draw = { width: W, height: H, view: viewMatrix([0, 2, 4], [0, 0.5, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), environment: null, lights: [], ambient: 0.3, lightDirection: [0.3, 1, 0.2], prepass: true } as any;
    const plain = (await readLinearTexture(device, renderer.renderToTexture(instances, draw), W, H, settled)).data;
    renderer.particleBurst(0, [0, 1, 0]);
    device.pushErrorScope("validation");
    let shot: any = null;
    for (let i = 0; i < 90; i += 1) shot = renderer.renderToTexture(instances, draw);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const lit = (await readLinearTexture(device, shot, W, H, settled)).data;
    let added = 0;
    for (let i = 0; i < W * H; i += 1) added += Math.max(0, lit[i * 4]! - plain[i * 4]!);
    expect(added).toBeGreaterThan(1);
    // A second and a half of falling onto the floor at y = 0: they rest on it, not through it.
    const ring = renderer.particleRing(0)!;
    const data = new Float32Array(await readBuffer(ring.buffer, ring.capacity * PARTICLE_FLOATS * 4));
    let lowest = Infinity;
    for (let s = 0; s < 128; s += 1) lowest = Math.min(lowest, data[s * PARTICLE_FLOATS + 1]!);
    expect(lowest).toBeGreaterThan(-0.3);
    renderer.dispose();
  });

  it("draws mesh particles and ribbons, lit by the key light", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    // A tetrahedron for the mesh particles.
    const mesh = {
      positions: Float32Array.from([0, 1, 0, -1, -1, 1, 1, -1, 1, 0, -1, -1]),
      normals: Float32Array.from([0, 1, 0, -0.6, -0.4, 0.6, 0.6, -0.4, 0.6, 0, -0.4, -1]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]),
    };
    const rocks: EmitterSpec = { name: "rocks", capacity: 64, modules: [{ type: "spawnBurst", count: 32 }, { type: "shape", kind: "sphere", radius: 0.8 }, { type: "velocity", speed: 0 }, { type: "lifetime", seconds: 10 }, { type: "size", start: 0.15 }, { type: "color", start: [0.8, 0.7, 0.6, 1] }, { type: "render", mode: "mesh", blend: "alpha" }] };
    const ribbon: EmitterSpec = { name: "ribbon", capacity: 64, modules: [{ type: "spawnRate", rate: 60 }, { type: "velocity", speed: 0 }, { type: "lifetime", seconds: 10 }, { type: "size", start: 0.2 }, { type: "color", start: [0.2, 0.8, 1, 1], glow: 3 }, { type: "vortex", axis: [0, 0, 1], strength: 4 }, { type: "attractor", position: [0.5, 0.5, 0], strength: 0 }, { type: "render", mode: "ribbon", blend: "additive" }] };
    (renderer as any).setParticles([rocks, ribbon], [{ mesh }, undefined]);
    renderer.particleBurst(0, [0, 0.5, 0]);
    const instances = [] as unknown as MeshSceneInstance[];
    const draw = { width: W, height: H, view: viewMatrix([0, 0.5, 4], [0, 0.5, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), environment: null, lights: [], ambient: 0.2, lightDirection: [0, 1, 0.5], prepass: true } as any;
    device.pushErrorScope("validation");
    let shot: any = null;
    // Something to draw against: the prepass needs a scene, so a far backdrop.
    const back = { mesh: { name: "back", primitives: [{ positions: Float32Array.from([-20, -20, -10, 20, -20, -10, 20, 20, -10, -20, 20, -10]), normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: new Float32Array(8), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]), material: { name: "b", baseColorFactor: [0, 0, 0, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 } }] }, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) };
    for (let i = 0; i < 40; i += 1) shot = renderer.renderToTexture([...instances, back] as unknown as MeshSceneInstance[], draw);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const data = (await readLinearTexture(device, shot, W, H, settled)).data;
    let warm = 0;
    let cool = 0;
    for (let i = 0; i < W * H; i += 1) {
      if (data[i * 4]! > data[i * 4 + 2]! + 0.05) warm += 1; // the lit rocks
      if (data[i * 4 + 2]! > data[i * 4]! + 0.3) cool += 1; // the glowing ribbon
    }
    expect(warm).toBeGreaterThan(5);
    expect(cool).toBeGreaterThan(5);
    renderer.dispose();
  });
});
