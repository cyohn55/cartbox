/**
 * Era rasterisation: the four RenderCaps that live in the per-pixel loop.
 *
 * A PS1-era console model is *defined* by having no depth buffer and affine
 * texture mapping — those artefacts are the era's look, not defects. These
 * prove each knob actually changes what is drawn (a style option that silently
 * does nothing is worse than no option), and that the default still renders
 * exactly what this rasteriser always did, since the editor's previews go
 * through the same code.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RASTER_STYLE,
  composeModelMatrix,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type DecodedTexture,
  type MeshAsset,
  type MeshSceneInstance,
  type RasterStyle,
} from "@cartbox/editor";

const W = 48;
const H = 36;

function style(overrides: Partial<RasterStyle>): RasterStyle {
  return { ...DEFAULT_RASTER_STYLE, ...overrides };
}

/** A 2x2 checker, so filtering and UV mapping are visible. */
function checker(): DecodedTexture {
  return {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      255, 255, 255, 255, 0, 0, 0, 255,
      0, 0, 0, 255, 255, 255, 255, 255,
    ]),
  };
}

/** A textured quad spanning [-1,1] in x,y at object z=0. */
function texturedQuad(): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
      },
    ],
  };
}

/** A flat single-colour quad, for depth-order tests. */
function colourQuad(colour: [number, number, number]): MeshAsset {
  return {
    name: "flat",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [...colour, 1], baseColorImage: null },
      },
    ],
  };
}

function render(
  instances: MeshSceneInstance[],
  rasterStyle?: RasterStyle,
  eye: [number, number, number] = [0, 0, 4],
): { rgba: Uint8ClampedArray; depth: Float32Array } {
  const rgba = new Uint8ClampedArray(W * H * 4);
  const depth = new Float32Array(W * H);
  renderMeshScene(instances, {
    width: W,
    height: H,
    out: rgba,
    depth,
    view: viewMatrix(eye, [0, 0, 0]),
    projection: projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100),
    background: [0, 0, 0, 255],
    style: rasterStyle,
  });
  return { rgba, depth };
}

/** A quad rotated about Y, so one edge is much nearer than the other. */
function angledQuad(texture: DecodedTexture): MeshSceneInstance {
  return {
    mesh: texturedQuad(),
    model: composeModelMatrix([0, 0, 0], [0, 70, 0], [2, 2, 2]),
    textures: [texture],
  };
}

describe("the default style", () => {
  it("renders identically to passing no style at all", () => {
    // The editor's previews call this without a style. If the default ever
    // drifted from the old behaviour, every preview would change silently.
    const scene = [angledQuad(checker())];
    expect(Array.from(render(scene).rgba)).toEqual(Array.from(render(scene, DEFAULT_RASTER_STYLE).rgba));
  });
});

describe("perspectiveCorrect", () => {
  it("changes how a texture maps across a foreshortened surface", () => {
    // Affine interpolation is linear in screen space, so a texture swims across
    // a surface angled away from the camera. On a face-on quad it agrees with
    // the perspective-correct path, which is why this uses an angled one.
    const scene = [angledQuad(checker())];
    const correct = render(scene, style({ perspectiveCorrect: true })).rgba;
    const affine = render(scene, style({ perspectiveCorrect: false })).rgba;
    expect(Array.from(affine)).not.toEqual(Array.from(correct));
  });

  it("agrees with the correct path when nothing is foreshortened", () => {
    // A quad square-on to the camera has constant w, so the two weightings are
    // the same maths. A difference here would mean the affine path is wrong,
    // not merely different.
    const scene: MeshSceneInstance[] = [
      { mesh: texturedQuad(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures: [checker()] },
    ];
    const correct = render(scene, style({ perspectiveCorrect: true })).rgba;
    const affine = render(scene, style({ perspectiveCorrect: false })).rgba;
    expect(Array.from(affine)).toEqual(Array.from(correct));
  });
});

describe("vertexPrecision", () => {
  it("collapses smooth camera motion into fewer discrete frames", () => {
    // The signature of a transform unit with no subpixel precision: a vertex
    // sits still while the camera creeps, then jumps a whole pixel at once. So
    // a sweep of camera positions yields strictly fewer distinct frames than
    // the float path over the same sweep. (Asserting that any *single* nudge
    // changes nothing would be flaky: this rasteriser has no antialiasing, so
    // even the float path only changes when an edge crosses a pixel centre.)
    const scene = [angledQuad(checker())];

    const distinctFrames = (rasterStyle: RasterStyle): number => {
      const seen = new Set<string>();
      for (let step = 0; step < 16; step += 1) {
        seen.add(render(scene, rasterStyle, [step * 0.02, 0, 4]).rgba.join(","));
      }
      return seen.size;
    };

    const snapped = distinctFrames(style({ vertexPrecision: "integer" }));
    const smooth = distinctFrames(style({ vertexPrecision: "float" }));
    expect(snapped).toBeLessThan(smooth);
    expect(snapped).toBeGreaterThan(0);
  });
});

describe("textureFiltering", () => {
  it("blends between texels instead of stepping between them", () => {
    const scene: MeshSceneInstance[] = [
      { mesh: texturedQuad(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures: [checker()] },
    ];
    const nearest = render(scene, style({ textureFiltering: "none" })).rgba;
    const bilinear = render(scene, style({ textureFiltering: "bilinear" })).rgba;
    expect(Array.from(bilinear)).not.toEqual(Array.from(nearest));

    // Nearest can only ever produce the two source texel values (shaded);
    // bilinear must produce values strictly between them somewhere.
    const shades = new Set<number>();
    for (let i = 0; i < bilinear.length; i += 4) {
      if (bilinear[i + 3] === 255) shades.add(bilinear[i]!);
    }
    const nearestShades = new Set<number>();
    for (let i = 0; i < nearest.length; i += 4) {
      if (nearest[i + 3] === 255) nearestShades.add(nearest[i]!);
    }
    expect(shades.size).toBeGreaterThan(nearestShades.size);
  });
});

describe("zBuffer", () => {
  it("leaves the depth buffer untouched when disabled", () => {
    const scene = [angledQuad(checker())];
    const { depth } = render(scene, style({ zBuffer: false }));
    expect(depth.every((value) => value === Infinity)).toBe(true);

    // ...and does write it when enabled, so the assertion above means something.
    expect(render(scene).depth.some((value) => value !== Infinity)).toBe(true);
  });

  it("resolves interpenetrating surfaces by whole triangle, not by pixel", () => {
    // Painter's ordering is *correct* for surfaces that do not intersect, so
    // two separated quads look the same either way. Interpenetration is where
    // the two genuinely differ: a depth buffer decides per pixel, so each
    // surface shows wherever it is actually nearer, while an ordering table
    // must pick one whole triangle to draw first and gets the crossing wrong.
    const scene: MeshSceneInstance[] = [
      { mesh: colourQuad([1, 0, 0]), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1.5, 1.5, 1.5]), textures: null },
      { mesh: colourQuad([0, 0, 1]), model: composeModelMatrix([0, 0, 0], [0, 60, 0], [1.5, 1.5, 1.5]), textures: null },
    ];

    const count = (rgba: Uint8ClampedArray): { red: number; blue: number } => {
      let red = 0;
      let blue = 0;
      for (let i = 0; i < W * H; i += 1) {
        if (rgba[i * 4]! > rgba[i * 4 + 2]!) red += 1;
        else if (rgba[i * 4 + 2]! > rgba[i * 4]!) blue += 1;
      }
      return { red, blue };
    };

    const buffered = count(render(scene).rgba);
    const unbuffered = count(render(scene, style({ zBuffer: false })).rgba);
    expect(unbuffered).not.toEqual(buffered);
    // Both surfaces are still visible either way — this is a wrong crossing,
    // not one quad vanishing.
    expect(unbuffered.red).toBeGreaterThan(0);
    expect(unbuffered.blue).toBeGreaterThan(0);
  });

  it("sorts the whole scene back-to-front, not just each instance", () => {
    // Painter's ordering has to be global: submitting far-then-near and
    // near-then-far must give the same picture, or the "ordering table" is
    // really just submission order.
    const near = composeModelMatrix([0, 0, 1], [0, 0, 0], [1, 1, 1]);
    const far = composeModelMatrix([0, 0, -1], [0, 0, 0], [1, 1, 1]);
    const a: MeshSceneInstance[] = [
      { mesh: colourQuad([1, 0, 0]), model: near, textures: null },
      { mesh: colourQuad([0, 0, 1]), model: far, textures: null },
    ];
    const b: MeshSceneInstance[] = [a[1]!, a[0]!];

    const unbuffered = style({ zBuffer: false });
    expect(Array.from(render(b, unbuffered).rgba)).toEqual(Array.from(render(a, unbuffered).rgba));

    // And the near one is what shows, so the sort is farthest-first.
    const centre = ((H / 2) * W + W / 2) * 4;
    const pixels = render(a, unbuffered).rgba;
    expect(pixels[centre]).toBeGreaterThan(pixels[centre + 2]!);
  });
});
