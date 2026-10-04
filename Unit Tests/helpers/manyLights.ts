/**
 * The many-lights test rig (ENGINE_PARITY_ROADMAP.md EP8), shared by the
 * WebGL2 and WebGPU parity tests and the cluster tests.
 */

import type { SceneLight } from "@cartbox/editor";

/** A sun, forty ranged point lights in a ring of colours, and four spots aimed down at the floor. */
export function manyLights(): SceneLight[] {
  const lights: SceneLight[] = [{ kind: "directional", direction: [0.3, 1, 0.2], color: [0.4, 0.4, 0.45], intensity: 0.5 }];
  for (let i = 0; i < 40; i += 1) {
    const a = (i / 40) * Math.PI * 2;
    const r = 1 + (i % 4) * 1.1;
    lights.push({ kind: "point", position: [Math.cos(a) * r, 0.4 + (i % 3) * 0.2, Math.sin(a) * r], color: [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.cos(a + 2.1), 0.5 + 0.5 * Math.cos(a + 4.2)], intensity: 1.5, range: 1.2 + (i % 5) * 0.3 });
  }
  for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]] as const) {
    lights.push({ kind: "spot", position: [x, 3, z], direction: [-x * 0.2, -1, -z * 0.2], color: [1, 0.95, 0.8], intensity: 3, range: 6, innerAngle: 12, outerAngle: 22 });
  }
  return lights;
}

