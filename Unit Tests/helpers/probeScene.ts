/**
 * Light-probe test rig (ENGINE_PARITY_ROADMAP.md EP9), shared by the WebGL2
 * and WebGPU parity tests: a floor and two blocks without light maps, lit by a
 * 3×2×3 probe grid whose every probe and face differs.
 */

import { composeModelMatrix, type EnvironmentLight, type LightProbeGrid, type MeshSceneInstance } from "@cartbox/editor";

import { blockMesh } from "./localShadowScene";

export function probeGrid(): LightProbeGrid {
  const counts = [3, 2, 3] as const;
  const values = new Float32Array(counts[0] * counts[1] * counts[2] * 18);
  for (let p = 0; p < counts[0] * counts[1] * counts[2]; p += 1) {
    for (let f = 0; f < 6; f += 1) {
      const o = (p * 6 + f) * 3;
      values[o] = 0.3 + ((p * 7 + f * 3) % 10) / 10;
      values[o + 1] = 0.3 + ((p * 3 + f * 5) % 10) / 12;
      values[o + 2] = 0.3 + ((p * 5 + f * 7) % 10) / 14;
    }
  }
  return { min: [-3, 0, -3], max: [3, 2.5, 3], counts, values };
}

export function probeRig(): { instances: MeshSceneInstance[]; environment: EnvironmentLight } {
  return {
    instances: [
      { mesh: blockMesh(4, 0.05, 4), model: composeModelMatrix([0, -0.05, 0], [0, 0, 0], [1, 1, 1]) },
      { mesh: blockMesh(0.6, 0.6, 0.6, [0.9, 0.9, 0.9]), model: composeModelMatrix([-1, 0.6, 0.2], [0, 30, 0], [1, 1, 1]) },
      { mesh: blockMesh(0.4, 0.9, 0.4, [0.8, 0.85, 0.9]), model: composeModelMatrix([1.3, 0.9, -0.4], [10, -20, 5], [1, 1, 1]) },
    ],
    environment: { sky: [0.8, 0.85, 1], horizon: [0.7, 0.7, 0.7], ground: [0.4, 0.35, 0.3], intensity: 0.8, lightProbes: probeGrid() },
  };
}
