/**
 * The scene-renderer seam.
 *
 * Both 3D overlays used to call `renderMeshScene` directly, which is why the
 * player had no GPU triangle path: the rasteriser was a function they invoked,
 * not a dependency they could be handed. These tests cover the three things
 * that has to guarantee.
 *
 * 1. **The fallback is real.** A missing device, a failed device, or a renderer
 *    that cannot build must all end at the software rasteriser — never at null,
 *    never at a throw inside a frame.
 * 2. **Parity.** The software renderer must produce byte-identical output to
 *    calling `renderMeshScene` directly, including the options it forwards.
 *    Anything less means the picture changes with the viewer's browser.
 * 3. **The overlays actually use it,** and forward the per-frame light the world
 *    overlay drives — the field most easily dropped when threading a new
 *    parameter through.
 */

import { describe, expect, it, vi } from "vitest";

import {
  composeModelMatrix,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type Mat4,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";
import {
  SOFTWARE_RASTER_CAPS,
  SoftwareSceneRenderer,
  createSceneRenderer,
  type SceneDraw,
  type SceneRenderer,
} from "@cartbox/player";

const WIDTH = 32;
const HEIGHT = 24;

/** A camera-facing unit quad at object z=0, solid red. */
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

function scene(): MeshSceneInstance[] {
  return [{ mesh: quad(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures: null }];
}

function camera(): { view: Mat4; projection: Mat4 } {
  return {
    view: viewMatrix([0, 0, 5], [0, 0, 0]),
    projection: projectionMatrix((50 * Math.PI) / 180, WIDTH / HEIGHT, 0.1, 100),
  };
}

function draw(overrides: Partial<SceneDraw> = {}): SceneDraw {
  const { view, projection } = camera();
  return {
    width: WIDTH,
    height: HEIGHT,
    out: new Uint8ClampedArray(WIDTH * HEIGHT * 4),
    depth: new Float32Array(WIDTH * HEIGHT),
    view,
    projection,
    background: null,
    ...overrides,
  };
}

describe("createSceneRenderer", () => {
  it("falls back to software when no device is available", async () => {
    const renderer = await createSceneRenderer(WIDTH, HEIGHT, SOFTWARE_RASTER_CAPS, async () => null);
    expect(renderer.backend).toBe("software");
  });

  it("falls back to software when the device cannot build a renderer", async () => {
    // A device-shaped object whose first call throws stands in for a lost or
    // limited adapter. WebgpuSceneRenderer.create swallows it and returns null.
    const brokenDevice = {
      createShaderModule() {
        throw new Error("no shader compiler");
      },
    };
    const renderer = await createSceneRenderer(WIDTH, HEIGHT, SOFTWARE_RASTER_CAPS, async () => brokenDevice);
    expect(renderer.backend).toBe("software");
  });

  it("never resolves to null, so no caller needs a third branch", async () => {
    const renderer = await createSceneRenderer(WIDTH, HEIGHT, SOFTWARE_RASTER_CAPS, async () => null);
    expect(renderer).not.toBeNull();
    expect(typeof renderer.render).toBe("function");
    expect(() => renderer.dispose()).not.toThrow();
  });
});

describe("SoftwareSceneRenderer parity", () => {
  it("matches renderMeshScene byte for byte", () => {
    const instances = scene();
    const { view, projection } = camera();

    const direct = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    renderMeshScene(instances, {
      width: WIDTH,
      height: HEIGHT,
      out: direct,
      depth: new Float32Array(WIDTH * HEIGHT),
      view,
      projection,
      background: null,
    });

    const options = draw();
    new SoftwareSceneRenderer().render(instances, options);
    expect(Array.from(options.out)).toEqual(Array.from(direct));
    // And it actually drew something, so parity is not two blank frames.
    expect(options.out.some((byte) => byte !== 0)).toBe(true);
  });

  it("forwards the per-frame light and ambient", () => {
    // The world overlay varies both every frame (a cart-published sun, and a
    // different ambient depending on whether one is set). Dropping either while
    // threading the new parameter would silently reshade every world cart.
    const instances = scene();
    const { view, projection } = camera();

    const direct = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    renderMeshScene(instances, {
      width: WIDTH,
      height: HEIGHT,
      out: direct,
      depth: new Float32Array(WIDTH * HEIGHT),
      view,
      projection,
      background: null,
      lightDirection: [1, 0, 0],
      ambient: 0.62,
    });

    const options = draw({ lightDirection: [1, 0, 0], ambient: 0.62 });
    new SoftwareSceneRenderer().render(instances, options);
    expect(Array.from(options.out)).toEqual(Array.from(direct));

    // Prove the light is load-bearing: the default shading differs from this.
    const defaults = draw();
    new SoftwareSceneRenderer().render(instances, defaults);
    expect(Array.from(defaults.out)).not.toEqual(Array.from(direct));
  });

  it("clears to an opaque background when one is given", () => {
    const options = draw({ background: [7, 8, 9, 255] });
    new SoftwareSceneRenderer().render([], options);
    expect(Array.from(options.out.subarray(0, 4))).toEqual([7, 8, 9, 255]);
  });

  it("leaves the frame untouched where nothing is drawn, with a null background", () => {
    // This is what makes these surfaces overlays rather than replacements: the
    // cart's own pixels have to survive everywhere the meshes miss.
    const options = draw();
    options.out.fill(42);
    new SoftwareSceneRenderer().render([], options);
    expect(Array.from(options.out.subarray(0, 4))).toEqual([42, 42, 42, 42]);
  });
});

describe("overlay wiring", () => {
  /** Records what it was asked to draw, and draws nothing. */
  function spyRenderer(): SceneRenderer & { calls: SceneDraw[] } {
    const calls: SceneDraw[] = [];
    return {
      backend: "software",
      calls,
      render: (_instances, options) => void calls.push(options),
      dispose: vi.fn(),
    };
  }

  it("draws the mesh overlay through the injected renderer", async () => {
    const { MeshOverlaySurface } = await import("@cartbox/player");
    const inner = { blit: vi.fn(), destroy: vi.fn() };
    const renderer = spyRenderer();
    const surface = await MeshOverlaySurface.create(
      inner,
      WIDTH,
      HEIGHT,
      { instances: scene(), bounds: { min: [-1, -1, -1], max: [1, 1, 1], center: [0, 0, 0], radius: 1 } },
      renderer,
    );

    surface.blit(new Uint8Array(WIDTH * HEIGHT * 4));
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]!.width).toBe(WIDTH);
    // An overlay never clears: the cart's frame shows wherever meshes miss.
    expect(renderer.calls[0]!.background).toBeNull();
    expect(inner.blit).toHaveBeenCalledTimes(1);
  });

  it("forwards the world overlay's per-frame sun and ambient", async () => {
    // The one field most easily lost when threading a renderer through: the
    // world overlay is the only caller that varies the light, and dropping it
    // would reshade every world cart without failing anything else.
    const { WorldOverlaySurface, parseWorldScene } = await import("@cartbox/player");
    const world = parseWorldScene(
      JSON.stringify({ cols: 1, rows: 1, tilesPerSide: 4, cells: [{ h: 1, sprite: 0 }] }),
    )!;
    const inner = { blit: vi.fn(), destroy: vi.fn() };
    const renderer = spyRenderer();
    const surface = new WorldOverlaySurface(inner, WIDTH, HEIGHT, world, () => null, renderer);

    // No sun published yet: the rasteriser's unlit ambient.
    surface.blit(new Uint8Array(WIDTH * HEIGHT * 4));
    expect(renderer.calls[0]!.lightDirection).toBeUndefined();
    expect(renderer.calls[0]!.ambient).toBe(0.62);

    // A cart-published sun switches both the direction and the ambient level.
    surface.setSun([0, 1, 0]);
    surface.blit(new Uint8Array(WIDTH * HEIGHT * 4));
    expect(renderer.calls[1]!.lightDirection).toEqual([0, 1, 0]);
    expect(renderer.calls[1]!.ambient).toBe(0.45);
  });

  it("does not dispose a renderer it was handed", async () => {
    // The player shares one renderer between the mesh and world overlays, so a
    // surface disposing it on destroy would tear down the other one's GPU
    // resources mid-frame.
    const { MeshOverlaySurface } = await import("@cartbox/player");
    const inner = { blit: vi.fn(), destroy: vi.fn() };
    const renderer = spyRenderer();
    const surface = await MeshOverlaySurface.create(
      inner,
      WIDTH,
      HEIGHT,
      { instances: scene(), bounds: { min: [-1, -1, -1], max: [1, 1, 1], center: [0, 0, 0], radius: 1 } },
      renderer,
    );

    surface.destroy();
    expect(renderer.dispose).not.toHaveBeenCalled();
    expect(inner.destroy).toHaveBeenCalledTimes(1);
  });
});
