/**
 * WebgpuSceneRenderer, driven through a recording fake device.
 *
 * There is no WebGPU adapter on a build machine, so this cannot prove the
 * shader compiles or that the picture matches. What it *can* prove is
 * everything the renderer asks of the API, which is where a GPU renderer's
 * hardware-only failures live: a bind group layout that refuses the dynamic
 * offsets the draws are addressed by, a vertex layout that disagrees with the
 * buffer being packed, a readback copied at an unaligned row stride, geometry
 * re-uploaded every frame. Each of those is silent or fatal only on a device.
 *
 * The fake implements the subset of WebGPU the renderer touches and records the
 * calls; the class under test is the real one.
 *
 * What this deliberately does NOT cover, and no test here can: WGSL
 * compilation, and whether the GPU output matches the software rasteriser
 * pixel for pixel. Both need real hardware.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import {
  UNIFORM_BYTES_USED,
  UNIFORM_STRIDE,
  WebgpuSceneRenderer,
  alignBytesPerRow,
  projectionMatrix,
  viewMatrix,
} from "./helpers/sceneRendererHarness";

const WIDTH = 3;
const HEIGHT = 2;


interface Recorded {
  pipelines: any[];
  bindGroupLayouts: any[];
  bindGroups: any[];
  buffers: any[];
  textures: any[];
  writeBuffer: any[][];
  copies: any[];
  passCalls: { op: string; args: any[] }[];
  textureWrites: any[][];
  submits: number;
}

/** A WebGPU device stub that records what it is asked for. */
function fakeDevice(fillReadback?: (bytes: Uint8Array) => void) {
  const log: Recorded = {
    pipelines: [],
    bindGroupLayouts: [],
    bindGroups: [],
    buffers: [],
    textures: [],
    writeBuffer: [],
    copies: [],
    passCalls: [],
    textureWrites: [],
    submits: 0,
  };

  const makeBuffer = (desc: any) => {
    const backing = new ArrayBuffer(desc.size);
    const buffer = {
      ...desc,
      destroyed: false,
      mapAsync: async () => undefined,
      getMappedRange: () => backing,
      unmap: () => undefined,
      destroy() {
        buffer.destroyed = true;
      },
      _backing: backing,
    };
    log.buffers.push(buffer);
    return buffer;
  };

  const device = {
    createShaderModule: (desc: any) => ({ code: desc.code }),
    createBindGroupLayout: (desc: any) => {
      log.bindGroupLayouts.push(desc);
      return { _desc: desc };
    },
    createPipelineLayout: (desc: any) => ({ _desc: desc }),
    createRenderPipeline: (desc: any) => {
      log.pipelines.push(desc);
      return { _desc: desc };
    },
    createTexture: (desc: any) => {
      const texture = { ...desc, destroyed: false, createView: () => ({ of: desc }), destroy() { texture.destroyed = true; } };
      log.textures.push(texture);
      return texture;
    },
    createSampler: (desc: any) => ({ _desc: desc }),
    createBuffer: makeBuffer,
    createBindGroup: (desc: any) => {
      log.bindGroups.push(desc);
      return { _desc: desc };
    },
    createCommandEncoder: () => ({
      beginRenderPass: (desc: any) => {
        log.passCalls.push({ op: "beginRenderPass", args: [desc] });
        return {
          setPipeline: (...args: any[]) => log.passCalls.push({ op: "setPipeline", args }),
          setBindGroup: (...args: any[]) => log.passCalls.push({ op: "setBindGroup", args }),
          setVertexBuffer: (...args: any[]) => log.passCalls.push({ op: "setVertexBuffer", args }),
          setIndexBuffer: (...args: any[]) => log.passCalls.push({ op: "setIndexBuffer", args }),
          drawIndexed: (...args: any[]) => log.passCalls.push({ op: "drawIndexed", args }),
          end: () => log.passCalls.push({ op: "end", args: [] }),
        };
      },
      copyTextureToBuffer: (source: any, destination: any, size: any) => {
        log.copies.push({ source, destination, size });
        if (fillReadback) fillReadback(new Uint8Array(destination.buffer._backing));
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (...args: any[]) => log.writeBuffer.push(args),
      writeTexture: (...args: any[]) => {
        log.textureWrites.push(args);
      },
      submit: () => {
        log.submits += 1;
      },
    },
  };

  return { device, log };
}

function quad(): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [1, 0, 0, 1], baseColorImage: null },
      },
    ],
  };
}

/**
 * Placed instances. Scaled up because the framebuffer here is deliberately tiny
 * (3x2, so the row-padding assertions are legible) and a unit quad at that size
 * falls between both pixel centres — the software warm-up would draw nothing
 * and the test would be asserting on an empty frame.
 */
function instances(mesh: MeshAsset, count = 1): MeshSceneInstance[] {
  return Array.from({ length: count }, (_, i) => ({
    mesh,
    model: composeModelMatrix([i, 0, 0], [0, 0, 0], [5, 5, 5]),
    textures: null,
  }));
}

function drawOptions() {
  return {
    width: WIDTH,
    height: HEIGHT,
    out: new Uint8ClampedArray(WIDTH * HEIGHT * 4),
    depth: new Float32Array(WIDTH * HEIGHT),
    view: viewMatrix([0, 0, 5], [0, 0, 0]),
    projection: projectionMatrix((50 * Math.PI) / 180, WIDTH / HEIGHT, 0.1, 100),
    background: null,
  };
}

/** Let the queued readback promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("WebgpuSceneRenderer pipeline setup", () => {
  it("declares a dynamic-offset uniform binding", async () => {
    // The hardware-only failure this guards: a layout inferred with "auto"
    // declares hasDynamicOffset false, and every setBindGroup call in the frame
    // is then rejected by the device.
    const { device, log } = fakeDevice();
    await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT);

    const uniform = log.bindGroupLayouts[0].entries.find((e: any) => e.binding === 0);
    expect(uniform.buffer.hasDynamicOffset).toBe(true);
    expect(uniform.buffer.minBindingSize).toBe(UNIFORM_BYTES_USED);
  });

  it("declares a vertex layout matching the packed stride", async () => {
    const { device, log } = fakeDevice();
    await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT);

    const layout = log.pipelines[0].vertex.buffers[0];
    expect(layout.arrayStride).toBe(32); // VERTEX_FLOATS * 4
    expect(layout.attributes.map((a: any) => [a.shaderLocation, a.offset, a.format])).toEqual([
      [0, 0, "float32x3"],
      [1, 12, "float32x3"],
      [2, 24, "float32x2"],
    ]);
  });

  it("renders to a linear target, never an sRGB one", async () => {
    // These bytes land in the same 8-bit framebuffer the CPU path writes to, so
    // an sRGB target would show up as the GPU path looking washed out.
    const { device, log } = fakeDevice();
    await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT);
    expect(log.pipelines[0].fragment.targets[0].format).toBe("rgba8unorm");
    expect(log.pipelines[0].primitive.cullMode).toBe("none"); // two-sided, like the CPU path
  });

  it("returns null when the device rejects anything, so the factory falls back", async () => {
    const broken = { createShaderModule: () => { throw new Error("nope"); } };
    expect(await WebgpuSceneRenderer.create(broken, WIDTH, HEIGHT)).toBeNull();
  });
});

describe("WebgpuSceneRenderer frames", () => {
  it("rasterises on the CPU until the first readback lands", async () => {
    const { device } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;
    const draw = drawOptions();

    renderer.render(instances(quad()), draw);
    // Something was drawn even though no GPU frame exists yet — no blank
    // opening frames while the pipeline fills.
    expect(draw.out.some((byte) => byte !== 0)).toBe(true);
  });

  it("composites the readback once it arrives, unpadding the rows", async () => {
    const bytesPerRow = alignBytesPerRow(WIDTH);
    // A recognisable "rendered" frame: opaque magenta in row 0, nothing in row 1.
    const { device } = fakeDevice((bytes) => {
      bytes.fill(0);
      for (let x = 0; x < WIDTH; x += 1) {
        bytes.set([255, 0, 255, 255], x * 4);
      }
    });
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;

    renderer.render(instances(quad()), drawOptions());
    await settle();

    const second = drawOptions();
    second.out.fill(9); // the cart's own frame
    renderer.render(instances(quad()), second);

    // Row 0 came from the GPU; row 1 was transparent there, so the cart shows.
    expect(Array.from(second.out.subarray(0, 4))).toEqual([255, 0, 255, 255]);
    expect(Array.from(second.out.subarray(WIDTH * 4, WIDTH * 4 + 4))).toEqual([9, 9, 9, 9]);
    expect(bytesPerRow).toBe(256);
  });

  it("copies back at WebGPU's aligned row stride", async () => {
    const { device, log } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;
    renderer.render(instances(quad()), drawOptions());

    expect(log.copies).toHaveLength(1);
    expect(log.copies[0].destination.bytesPerRow).toBe(alignBytesPerRow(WIDTH));
    expect(log.copies[0].destination.bytesPerRow % 256).toBe(0);
    expect(log.copies[0].size).toEqual({ width: WIDTH, height: HEIGHT });
  });

  it("addresses each draw by its own dynamic offset", async () => {
    const { device, log } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;
    renderer.render(instances(quad(), 3), drawOptions());

    const offsets = log.passCalls.filter((c) => c.op === "setBindGroup").map((c) => c.args[2]);
    expect(offsets).toEqual([[0], [UNIFORM_STRIDE], [UNIFORM_STRIDE * 2]]);
    expect(log.passCalls.filter((c) => c.op === "drawIndexed")).toHaveLength(3);
  });

  it("uploads a mesh's geometry once, not once per frame", async () => {
    const { device, log } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;
    const mesh = quad();

    renderer.render(instances(mesh), drawOptions());
    const afterFirst = log.buffers.length;
    renderer.render(instances(mesh), drawOptions());
    renderer.render(instances(mesh), drawOptions());

    // Only uniform-buffer growth may allocate again; no new vertex/index pair.
    expect(log.buffers.length).toBe(afterFirst);
  });

  it("clears the colour target to transparent so the cart shows through", async () => {
    const { device, log } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;
    renderer.render(instances(quad()), drawOptions());

    const pass = log.passCalls.find((c) => c.op === "beginRenderPass")!.args[0];
    expect(pass.colorAttachments[0].clearValue).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(pass.depthStencilAttachment.depthClearValue).toBe(1);
  });

  it("submits nothing for an empty scene", async () => {
    const { device, log } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;
    renderer.render([], drawOptions());
    expect(log.submits).toBe(0);
  });

  it("survives a device that starts throwing mid-frame", async () => {
    // A lost device must not take the cart down with it.
    const { device } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;
    device.createCommandEncoder = () => {
      throw new Error("device lost");
    };
    expect(() => renderer.render(instances(quad()), drawOptions())).not.toThrow();
  });
});

describe("WebgpuSceneRenderer on heavy scenes", () => {
  /** A mesh of `count` triangles (one quad repeated). */
  function heavy(count: number): MeshAsset {
    const base = quad();
    const primitive = base.primitives[0]!;
    const indices = new Uint32Array(count * 3);
    for (let i = 0; i < count; i += 1) indices.set(primitive.indices.subarray((i % 2) * 3, (i % 2) * 3 + 3), i * 3);
    return { ...base, primitives: [{ ...primitive, indices }] };
  }

  it("skips the CPU warm-up for a scene too big to rasterise in a frame", async () => {
    const { device } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;
    const draw = { ...drawOptions(), background: [1, 2, 3, 255] as [number, number, number, number] };
    renderer.render(instances(heavy(30000)), draw);
    // Just the background: a 30k-triangle warm-up would freeze a tablet for seconds.
    expect(Array.from(draw.out.subarray(0, 4))).toEqual([1, 2, 3, 255]);
    expect(new Set(draw.out).size).toBeLessThanOrEqual(4);
  });

  it("skips the CPU warm-up for a frame too large to fill in software", async () => {
    const { device } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, 1280, 720))!;
    const out = new Uint8ClampedArray(1280 * 720 * 4).fill(7);
    renderer.render(instances(quad()), { ...drawOptions(), width: 1280, height: 720, out, depth: new Float32Array(1280 * 720) });
    expect(out.every((byte) => byte === 7)).toBe(true); // the cart's frame, untouched
  });

  it("uploads only the changed region of a shadow map it has already uploaded", async () => {
    const { device, log } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;
    const depth = new Float32Array(64 * 64).fill(1);
    const shadow = { lightViewProj: viewMatrix([0, 5, 0], [0, 0, 0]), depth, size: 64 };
    renderer.render(instances(quad()), { ...drawOptions(), shadow });
    renderer.render(instances(quad()), { ...drawOptions(), shadow: { ...shadow, dirty: { x: 8, y: 4, width: 5, height: 3 } } });
    renderer.render(instances(quad()), { ...drawOptions(), shadow: { ...shadow, dirty: { x: 0, y: 0, width: 0, height: 0 } } });
    const writes = log.textureWrites.filter((args) => args[3]?.width === 64 || args[3]?.width === 5);
    expect(writes).toHaveLength(2); // one full upload, one 5x3 region, nothing when nothing changed
    expect(writes[0]![3]).toEqual({ width: 64, height: 64 });
    expect(writes[1]![0].origin).toEqual({ x: 8, y: 4 });
    expect(writes[1]![2]).toEqual({ offset: (4 * 64 + 8) * 4, bytesPerRow: 64 * 4, rowsPerImage: 3 });
    expect(writes[1]![3]).toEqual({ width: 5, height: 3 });

    // A different array (or no previous upload) always goes up whole.
    renderer.render(instances(quad()), { ...drawOptions(), shadow: { ...shadow, depth: new Float32Array(64 * 64), dirty: { x: 1, y: 1, width: 1, height: 1 } } });
    expect(log.textureWrites.at(-1)![3]).toEqual({ width: 64, height: 64 });
  });
});

describe("WebgpuSceneRenderer teardown", () => {
  it("destroys the textures and buffers it allocated", async () => {
    const { device, log } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;
    renderer.render(instances(quad()), drawOptions());
    renderer.dispose();

    // Colour, depth and the 1x1 blank all released.
    expect(log.textures.every((t: any) => t.destroyed)).toBe(true);
    // Every readback staging buffer released.
    const staging = log.buffers.filter((b: any) => b.size === alignBytesPerRow(WIDTH) * HEIGHT);
    expect(staging.length).toBe(3);
    expect(staging.every((b: any) => b.destroyed)).toBe(true);
  });

  it("is idempotent and stops rendering afterwards", async () => {
    const { device, log } = fakeDevice();
    const renderer = (await WebgpuSceneRenderer.create(device, WIDTH, HEIGHT))!;
    renderer.dispose();
    renderer.dispose();
    const before = log.submits;
    renderer.render(instances(quad()), drawOptions());
    expect(log.submits).toBe(before);
  });
});
