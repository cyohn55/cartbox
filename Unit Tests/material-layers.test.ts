/**
 * Material layers and relief (HALO_INFINITE_STYLE_ROADMAP.md I4): the clearcoat,
 * anisotropy, parallax occlusion and the material graph's wear masks — their
 * stored form, the shared maths, the GPU packing, and what each does to a
 * software-rendered frame. (The GPU shaders are checked against these frames
 * by webgpu-parity.test.ts and webgl-parity.test.ts.)
 */

import { describe, expect, it } from "vitest";
import {
  NO_LAYERS,
  PANEL_RELIEF_SIZE,
  PARALLAX_MAX_DEPTH,
  anisotropicD,
  builtinPanelRelief,
  compileGraph,
  composeModelMatrix,
  curvatureOf,
  deserializeMeshAsset,
  encodeGlb,
  evaluateGraph,
  graphRegisters,
  graphShaderCode,
  materialHasLayers,
  panelReliefRgba,
  parallaxRate,
  parallaxUv,
  parseGlb,
  projectionMatrix,
  readGlb,
  readMaterialGraph,
  readMaterialLayers,
  renderMeshScene,
  resolveLayers,
  serializeMeshAsset,
  uvGradients,
  viewMatrix,
  type GraphContext,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { UNIFORM_BYTES_USED, UNIFORM_FLOATS, UNIFORM_STRIDE, resolvePbr, writeInstanceUniform } from "@cartbox/player";
import { occlusionWithRelief } from "../packages/player/src/render/gpuFrame";

import { LAYER_ENVIRONMENT, LAYER_LIGHTS, WORN_PAINT, checkerTexture, layerInstances, reliefTexture } from "./helpers/layerScenes";

type Material = Partial<MeshAsset["primitives"][number]["material"]>;

function quad(material: Material = {}): MeshAsset {
  return {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.9, 0.4, 0.2, 1], baseColorImage: null, ...material },
      },
    ],
  };
}

const W = 96;
const H = 72;

function render(instances: MeshSceneInstance[], extra: Record<string, unknown> = {}): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  renderMeshScene(instances, {
    width: W,
    height: H,
    out,
    depth: new Float32Array(W * H),
    view: viewMatrix([0, 0, 3], [0, 0, 0]),
    projection: projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100),
    background: [0, 0, 0, 255],
    lightDirection: [0.3, 0.5, 1],
    environment: LAYER_ENVIRONMENT,
    ...extra,
  });
  return out;
}

const luma = (out: Uint8ClampedArray, p: number) => 0.3 * out[p * 4]! + 0.59 * out[p * 4 + 1]! + 0.11 * out[p * 4 + 2]!;

function changedPixels(a: Uint8ClampedArray, b: Uint8ClampedArray, threshold = 3): number {
  let n = 0;
  for (let p = 0; p < a.length / 4; p += 1) {
    if (Math.abs(a[p * 4]! - b[p * 4]!) + Math.abs(a[p * 4 + 1]! - b[p * 4 + 1]!) + Math.abs(a[p * 4 + 2]! - b[p * 4 + 2]!) > threshold) n += 1;
  }
  return n;
}

describe("stored layers", () => {
  it("clamps each field and drops neutral or malformed ones", () => {
    expect(readMaterialLayers({ clearcoat: 3, clearcoatRoughness: -1, anisotropy: -4, anisotropyRotation: 99, parallaxDepth: 9 })).toEqual({
      clearcoat: 1,
      clearcoatRoughness: 0,
      anisotropy: -1,
      anisotropyRotation: 2 * Math.PI,
      parallaxDepth: PARALLAX_MAX_DEPTH,
    });
    expect(readMaterialLayers({ clearcoat: 0, anisotropy: 0, parallaxDepth: -1, clearcoatRoughness: "x", anisotropyRotation: NaN })).toEqual({});
  });

  it("survives a save and load with the relief map", () => {
    const relief = builtinPanelRelief();
    const mesh = quad({ clearcoat: 0.8, clearcoatRoughness: 0.2, anisotropy: -0.5, anisotropyRotation: 1, parallaxDepth: 0.05, reliefImage: relief });
    const back = deserializeMeshAsset(serializeMeshAsset(mesh)).primitives[0]!.material;
    expect(back.clearcoat).toBe(0.8);
    expect(back.clearcoatRoughness).toBe(0.2);
    expect(back.anisotropy).toBe(-0.5);
    expect(back.anisotropyRotation).toBe(1);
    expect(back.parallaxDepth).toBe(0.05);
    expect(Array.from(back.reliefImage!.bytes)).toEqual(Array.from(relief.bytes));
  });

  it("puts a material with any layer on the PBR path, on the CPU and the GPU alike", () => {
    expect(materialHasLayers({})).toBe(false);
    expect(materialHasLayers({ clearcoat: 0.5 })).toBe(true);
    expect(materialHasLayers({ anisotropy: -0.2 })).toBe(true);
    expect(materialHasLayers({ parallaxDepth: 0.1 })).toBe(true);
    expect(resolvePbr({ clearcoat: 0.5 }, false, false, false).isPbr).toBe(true);
    expect(resolvePbr({}, false, false, false).isPbr).toBe(false);
  });

  it("resolves the parallax depth only when a relief map is bound", () => {
    const material = quad({ parallaxDepth: 0.1, anisotropyRotation: Math.PI / 2 }).primitives[0]!.material;
    expect(resolveLayers(material, false).parallaxDepth).toBe(0);
    const layers = resolveLayers(material, true);
    expect(layers.parallaxDepth).toBe(0.1);
    expect(layers.relief).toBe(true);
    expect(layers.anisotropyCos).toBeCloseTo(0, 9);
    expect(layers.anisotropySin).toBeCloseTo(1, 9);
  });
});

describe("glTF clearcoat and anisotropy", () => {
  it("writes the KHR extensions and reads them back", () => {
    const glb = encodeGlb(quad({ clearcoat: 0.7, clearcoatRoughness: 0.15, anisotropy: 0.6, anisotropyRotation: 0.3 }));
    const { json } = readGlb(glb);
    expect(json.extensionsUsed).toEqual(expect.arrayContaining(["KHR_materials_clearcoat", "KHR_materials_anisotropy"]));
    expect(json.extensionsRequired).toBeUndefined();
    const material = parseGlb(glb).primitives[0]!.material;
    expect(material.clearcoat).toBeCloseTo(0.7, 6);
    expect(material.clearcoatRoughness).toBeCloseTo(0.15, 6);
    expect(material.anisotropy).toBeCloseTo(0.6, 6);
    expect(material.anisotropyRotation).toBeCloseTo(0.3, 6);
  });

  it("leaves a plain material's file without extensions", () => {
    const { json } = readGlb(encodeGlb(quad()));
    expect(json.extensionsUsed).toBeUndefined();
  });
});

describe("the shared maths", () => {
  it("anisotropic GGX is the isotropic distribution at zero anisotropy", () => {
    for (const rough of [0.1, 0.4, 0.9]) {
      for (const ndh of [0.2, 0.7, 0.99]) {
        const a2 = rough ** 4;
        const dd = ndh * ndh * (a2 - 1) + 1;
        const iso = a2 / (Math.PI * dd * dd);
        const s = Math.sqrt(1 - ndh * ndh);
        expect(anisotropicD(rough, 0, s * 0.6, s * 0.8, ndh) / iso).toBeCloseTo(1, 5);
      }
    }
  });

  it("anisotropy widens the lobe along the tangent and narrows it across", () => {
    const ndh = 0.95;
    const s = Math.sqrt(1 - ndh * ndh);
    // The same off-peak half vector, leaning along the tangent then along the bitangent.
    expect(anisotropicD(0.4, 0.8, s, 0, ndh)).toBeGreaterThan(anisotropicD(0.4, 0, s, 0, ndh));
    expect(anisotropicD(0.4, 0.8, 0, s, ndh)).toBeLessThan(anisotropicD(0.4, 0, 0, s, ndh));
  });

  it("finds a triangle's UV gradients exactly", () => {
    const e1: [number, number, number] = [2, 0, 0.5];
    const e2: [number, number, number] = [0.3, 1.5, 0];
    const g = uvGradients(e1, e2, 0.4, 0.1, -0.2, 0.6)!;
    const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    expect(dot(g.gu, e1)).toBeCloseTo(0.4, 9);
    expect(dot(g.gu, e2)).toBeCloseTo(-0.2, 9);
    expect(dot(g.gv, e1)).toBeCloseTo(0.1, 9);
    expect(dot(g.gv, e2)).toBeCloseTo(0.6, 9);
    expect(uvGradients(e1, e2, 1, 1, 1, 1)).toBeNull(); // degenerate UVs
  });

  it("parallax leaves a flat top where it is and shifts toward the viewer over a pit", () => {
    expect(parallaxUv(0.3, 0.4, 0.5, -0.2, 0.1, () => 1)).toEqual([0.3, 0.4]);
    // A pit everywhere at depth fraction 0.5: the ray reaches it half way down.
    const [u, v] = parallaxUv(0.3, 0.4, 1, -0.5, 0.1, () => 0.5);
    expect(u).toBeCloseTo(0.3 + 0.05, 6);
    expect(v).toBeCloseTo(0.4 - 0.025, 6);
  });

  it("moves UVs away from where the viewer leans, and holds at grazing angles", () => {
    // Looking down a surface tilted toward +u: the ray going in travels toward +u.
    const n: [number, number, number] = [0, 0, 1];
    const [du] = parallaxRate([1, 0, 0], [0, 1, 0], n, [-0.6, 0, 0.8]);
    expect(du).toBeCloseTo(0.75, 9);
    const [grazing] = parallaxRate([1, 0, 0], [0, 1, 0], n, [-1, 0, 0]);
    expect(Number.isFinite(grazing)).toBe(true);
  });
});

describe("the built-in panel relief", () => {
  it("is one shared image of seams, bevelled faces and rivets", () => {
    expect(builtinPanelRelief()).toBe(builtinPanelRelief());
    const rgba = panelReliefRgba();
    const at = (x: number, y: number) => (y * PANEL_RELIEF_SIZE + x) * 4;
    expect(rgba[at(0, 16)]).toBe(0); // the seam on the tile's edge
    expect(rgba[at(32, 16)]).toBe(0); // and down its middle
    expect(rgba[at(16, 16)]).toBe(204); // a panel's face
    expect(rgba[at(6, 6)]).toBeGreaterThan(240); // a rivet's top, above the face
    // Curvature: the seam floor is a cavity, the bevel's rim an edge, the open face flat.
    expect(curvatureOf(rgba[at(0, 16) + 1]!)).toBeLessThan(-0.3);
    expect(curvatureOf(rgba[at(4, 16) + 1]!)).toBeGreaterThan(0.3);
    expect(Math.abs(curvatureOf(rgba[at(16, 16) + 1]!))).toBeLessThan(0.01);
  });
});

describe("wear masks in the material graph", () => {
  const ctx = (curv: number): GraphContext => ({ u: 0, v: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 1, vx: 0, vy: 0, vz: 1, time: 0, curv, br: 1, bg: 1, bb: 1, ba: 1, sample: () => [1, 1, 1, 1] });
  const run = (graph: Parameters<typeof compileGraph>[0], curv: number) => {
    const compiled = compileGraph(graph)!;
    const regs = graphRegisters(compiled);
    evaluateGraph(compiled, ctx(curv), regs);
    return regs[compiled.outputs.baseColor! * 3]!;
  };

  it("picks out edges or cavities by the relief's curvature", () => {
    const edges = { nodes: [{ id: "w", op: "wear" as const, params: { side: "edge", amount: 0.5, sharpness: 4 } }], outputs: { baseColor: "w" } };
    expect(run(edges, 0)).toBe(0);
    expect(run(edges, 0.6)).toBeCloseTo(0.4, 9);
    expect(run(edges, 1)).toBe(1);
    expect(run(edges, -1)).toBe(0);
    const cavities = { nodes: [{ id: "w", op: "wear" as const, params: { side: "cavity", amount: 0.5, sharpness: 4 } }], outputs: { baseColor: "w" } };
    expect(run(cavities, -1)).toBe(1);
    expect(run(cavities, 1)).toBe(0);
  });

  it("is broken up by what is wired in, and reads curvature when unwired", () => {
    const graph = readMaterialGraph({
      nodes: [
        { id: "half", op: "constant", params: { value: 0.5 } },
        { id: "w", op: "wear", inputs: { breakup: "half" }, params: { side: "edge", amount: 0.5, sharpness: 10 } },
      ],
      outputs: { baseColor: "w" },
    })!;
    expect(run(graph, 1)).toBe(0); // halved, an edge at 1 reads 0.5: not past the threshold
    const compiled = compileGraph(graph)!;
    expect(compiled.steps.some((s) => s.op === "curvature")).toBe(true);
  });

  it("keeps its params in range when stored", () => {
    const graph = readMaterialGraph({ nodes: [{ id: "w", op: "wear", params: { side: "nope", amount: 7, sharpness: 0 } }], outputs: { baseColor: "w" } })!;
    expect(graph.nodes[0]!.params).toEqual({ side: "edge", amount: 1, sharpness: 1 });
  });

  it("writes the same maths as shader code", () => {
    const compiled = compileGraph(WORN_PAINT)!;
    const wgsl = graphShaderCode(compiled, "wgsl", { uv: "uv", position: "p", normal: "n", view: "v", time: "t", curvature: "gCurv", baseColor: "c", baseAlpha: "a", sample: (p) => `s(${p})` });
    expect(wgsl).toContain("vec3<f32>(gCurv)");
    expect(wgsl).toMatch(/clamp\(\(-g\d+ \* g\d+ - vec3<f32>\(0\.3\d*\)\) \* 4\.0, vec3<f32>\(0\.0\), vec3<f32>\(1\.0\)\)/);
  });
});

describe("GPU packing", () => {
  it("grows the uniform stride to 1024 for the layer (and refraction) fields", () => {
    expect(UNIFORM_STRIDE).toBe(1024);
    expect(UNIFORM_BYTES_USED).toBe(848);
    expect(UNIFORM_STRIDE % 256).toBe(0);
  });

  it("writes the layers at bytes 768 and 784", () => {
    const target = new Float32Array(UNIFORM_FLOATS * 2).fill(-7);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const uniform = {
      mvp: identity,
      normalBasis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      baseColor: [1, 1, 1, 1] as const,
      hasTexture: false,
      light: { direction: [0, 1, 0] as const, ambient: 0.3 },
      viewDir: [0, 0, 1] as const,
      pbr: { isPbr: true, metallic: 0, roughness: 1, emissive: [0, 0, 0] as const },
      hasMrMap: false,
      hasOcclusionMap: false,
      hasEmissiveMap: false,
      environment: null,
      lightMvp: null,
      shadow: null,
      tonemap: null,
      hasSsao: false,
      model: null,
      lightCount: 0,
    };
    writeInstanceUniform(target, 1, { ...uniform, layers: { clearcoat: 0.5, clearcoatRoughness: 0.2, anisotropy: -0.3, anisotropyCos: 0.6, anisotropySin: 0.8, parallaxDepth: 0.07, relief: true } } as never);
    const base = UNIFORM_FLOATS;
    expect(Array.from(target.subarray(base + 192, base + 200)).map((v) => Math.round(v * 100) / 100)).toEqual([0.5, 0.2, -0.3, 0.07, 0.6, 0.8, 1, 0]);
    writeInstanceUniform(target, 0, uniform as never);
    expect(Array.from(target.subarray(192, 200))).toEqual([0, NO_LAYERS.clearcoatRoughness, 0, 0, 1, 0, 0, 0].map(Math.fround));
  });

  it("packs a relief into the occlusion map's G and B, once per pair", () => {
    const relief = reliefTexture();
    expect(occlusionWithRelief(null, null)).toBeNull();
    const occ = { width: 2, height: 2, data: Uint8ClampedArray.from([10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255]) };
    expect(occlusionWithRelief(occ, null)).toBe(occ);
    const packed = occlusionWithRelief(occ, relief)!;
    expect(occlusionWithRelief(occ, relief)).toBe(packed);
    expect([packed.width, packed.height]).toEqual([PANEL_RELIEF_SIZE, PANEL_RELIEF_SIZE]);
    const o = (16 * PANEL_RELIEF_SIZE + 4) * 4;
    expect(packed.data[o]).toBe(10); // the top-left occlusion texel, stretched
    expect(packed.data[o + 1]).toBe(relief.data[o]); // height
    expect(packed.data[o + 2]).toBe(relief.data[o + 1]); // curvature
    const alone = occlusionWithRelief(null, relief)!;
    expect(alone.data[o]).toBe(255); // no occlusion: unoccluded
  });
});

describe("software rendering", () => {
  it("the clearcoat adds a sharp reflection over a rough base", () => {
    const base = { baseColorFactor: [0.6, 0.1, 0.1, 1] as [number, number, number, number], metallicFactor: 0, roughnessFactor: 0.8 };
    const place = composeModelMatrix([0, 0, 0], [0, 20, 0], [1, 1, 1]);
    // The key light mirrored about the quad's normal into the camera: the coat's narrow lobe catches it.
    const n = [Math.sin(Math.PI / 9), 0, Math.cos(Math.PI / 9)];
    const mirror = { lightDirection: [2 * n[2]! * n[0]!, 0, 2 * n[2]! * n[2]! - 1] };
    const plain = render([{ mesh: quad(base), model: place }], mirror);
    const coated = render([{ mesh: quad({ ...base, clearcoat: 1, clearcoatRoughness: 0.05 }), model: place }], mirror);
    expect(changedPixels(plain, coated)).toBeGreaterThan(500);
    // A coat only adds light to a dark base; the key light's highlight is the brightest pixel by far.
    let brightest = 0;
    let plainBrightest = 0;
    for (let p = 0; p < W * H; p += 1) {
      brightest = Math.max(brightest, luma(coated, p));
      plainBrightest = Math.max(plainBrightest, luma(plain, p));
    }
    expect(brightest).toBeGreaterThan(plainBrightest + 20);
  });

  it("a zero clearcoat, anisotropy and parallax change nothing", () => {
    const place = composeModelMatrix([0, 0, 0], [0, 20, 0], [1, 1, 1]);
    const base = { metallicFactor: 0.5, roughnessFactor: 0.5 };
    const plain = render([{ mesh: quad(base), model: place }]);
    const zeroed = render([{ mesh: quad({ ...base, clearcoat: 0, anisotropy: 0 }), model: place }]);
    expect(changedPixels(plain, zeroed, 0)).toBe(0);
    // A parallax depth with no relief bound draws flat.
    const noRelief = render([{ mesh: quad({ ...base, parallaxDepth: 0.2 }), model: place }]);
    expect(changedPixels(plain, noRelief, 0)).toBe(0);
  });

  it("anisotropy stretches the highlight across the grain", () => {
    // A point light just off a metal plate: the highlight's spread along each
    // screen axis, with the grain along U and then along V.
    const floorMesh = (material: Material): MeshAsset => quad({ baseColorFactor: [0.9, 0.9, 0.9, 1], metallicFactor: 1, roughnessFactor: 0.35, ...material });
    const spread = (out: Uint8ClampedArray) => {
      let peak = 0;
      for (let p = 0; p < W * H; p += 1) peak = Math.max(peak, luma(out, p));
      let xs = 0;
      let ys = 0;
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (luma(out, y * W + x) > peak * 0.6) { xs = Math.max(xs, x); ys = Math.max(ys, y); }
      let x0 = W;
      let y0 = H;
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (luma(out, y * W + x) > peak * 0.6) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); }
      return { x: xs - x0, y: ys - y0 };
    };
    const place = composeModelMatrix([0, 0, 0], [0, 0, 0], [1.6, 1.6, 1.6]);
    const draw = { lights: [{ kind: "point", position: [0, 0, 0.7], color: [1, 1, 1], intensity: 1.5 }], environment: null };
    const alongU = spread(render([{ mesh: floorMesh({ anisotropy: 0.9 }), model: place }], draw));
    const alongV = spread(render([{ mesh: floorMesh({ anisotropy: 0.9, anisotropyRotation: Math.PI / 2 }), model: place }], draw));
    // Positive anisotropy widens the lobe along the tangent: U (screen x), then V (screen y).
    expect(alongU.x).toBeGreaterThan(alongU.y);
    expect(alongV.y).toBeGreaterThan(alongV.x);
  });

  it("parallax shifts the panels' checker where the relief is deep, and only there", () => {
    const place = composeModelMatrix([0, 0, 0], [-50, 0, 0], [1.2, 1.2, 1.2]);
    const material = { baseColorFactor: [1, 1, 1, 1] as [number, number, number, number], metallicFactor: 0, roughnessFactor: 0.7 };
    const flat = render([{ mesh: quad(material), model: place, textures: [checkerTexture()], reliefTextures: [reliefTexture()] }]);
    const deep = render([{ mesh: quad({ ...material, parallaxDepth: 0.2 }), model: place, textures: [checkerTexture()], reliefTextures: [reliefTexture()] }]);
    expect(changedPixels(flat, deep, 30)).toBeGreaterThan(40);
  });

  it("wear masks bare the panels' edges and darken their seams", () => {
    const place = composeModelMatrix([0, 0, 0], [0, 0, 0], [1.4, 1.4, 1.4]);
    const out = render([{ mesh: quad({ baseColorFactor: [1, 1, 1, 1], graph: WORN_PAINT }), model: place, reliefTextures: [reliefTexture()] }], { environment: null, lightDirection: [0, 0, 1] });
    // The paint is green; bared metal is grey — so worn pixels have red close to green.
    let worn = 0;
    let painted = 0;
    for (let p = 0; p < W * H; p += 1) {
      const [r, g] = [out[p * 4]!, out[p * 4 + 1]!];
      if (g < 20) continue;
      if (r / g > 0.85) worn += 1;
      else painted += 1;
    }
    expect(painted).toBeGreaterThan(worn);
    expect(worn).toBeGreaterThan(30);
  });

  it("draws the shared layer scene with a key light and with a list of lights", () => {
    const instances = layerInstances(quad);
    const keyLit = render(instances, { lightDirection: [0.4, 0.8, 0.6] });
    const multiLit = render(instances, { lights: LAYER_LIGHTS });
    let drawn = 0;
    for (let p = 0; p < W * H; p += 1) if (keyLit[p * 4 + 3] === 255 && luma(keyLit, p) > 0) drawn += 1;
    expect(drawn).toBeGreaterThan(W * H * 0.2);
    expect(changedPixels(keyLit, multiLit)).toBeGreaterThan(200);
  });
});
