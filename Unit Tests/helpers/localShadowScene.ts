/**
 * Spot and point light shadows test rig (ENGINE_PARITY_ROADMAP.md EP8c),
 * shared by the WebGL2 and WebGPU parity tests and the unit tests: a floor,
 * a block and a post, a casting spot light over the block and a casting
 * point light beside the post, with their shadow tiles rendered.
 */

import {
  LOCAL_SHADOW_BIAS,
  LOCAL_SHADOW_SLOPE_BIAS,
  assignLocalShadowTiles,
  composeModelMatrix,
  renderLocalShadow,
  type LocalShadows,
  type MeshAsset,
  type MeshSceneInstance,
  type SceneLight,
} from "@cartbox/editor";

/** An axis-aligned box mesh (outward faces), PBR so the light loop shades it. */
export function blockMesh(hx: number, hy: number, hz: number, color: [number, number, number] = [0.8, 0.8, 0.8]): MeshAsset {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const h = [hx, hy, hz];
  for (const [nn, u, v] of faces) {
    const base = p.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k += 1) p.push((nn[k]! + a! * u[k]! + b! * v[k]!) * h[k]!);
      n.push(...nn);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { name: "block", primitives: [{ positions: Float32Array.from(p), normals: Float32Array.from(n), uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [...color, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 } }] };
}

export function localShadowRig(): { instances: MeshSceneInstance[]; lights: SceneLight[]; localShadows: LocalShadows } {
  const instances: MeshSceneInstance[] = [
    { mesh: blockMesh(5, 0.05, 5), model: composeModelMatrix([0, -0.05, 0], [0, 0, 0], [1, 1, 1]) },
    { mesh: blockMesh(0.5, 0.5, 0.5, [0.9, 0.6, 0.4]), model: composeModelMatrix([-1.2, 0.5, 0], [0, 20, 0], [1, 1, 1]) },
    { mesh: blockMesh(0.15, 1, 0.15, [0.5, 0.7, 0.9]), model: composeModelMatrix([1.62, 1, 0.43], [0, 0, 0], [1, 1, 1]) },
  ];
  const authored: SceneLight[] = [
    { kind: "directional", direction: [0.2, 1, 0.3], color: [0.3, 0.3, 0.35], intensity: 0.3 },
    { kind: "spot", position: [-1.2, 3.2, 0.6], direction: [0, -1, -0.15], color: [1, 0.9, 0.7], intensity: 4, range: 8, innerAngle: 25, outerAngle: 38, castShadows: true },
    { kind: "point", position: [2.4, 1.2, 1.1], color: [0.5, 0.8, 1], intensity: 3, range: 5, castShadows: true },
  ];
  const { lights } = assignLocalShadowTiles(authored);
  const tiles = lights.flatMap((l) => (l.shadowTile !== undefined ? renderLocalShadow(l, instances) : []));
  return { instances, lights: [...lights], localShadows: { tiles, bias: LOCAL_SHADOW_BIAS, slopeBias: LOCAL_SHADOW_SLOPE_BIAS } };
}
