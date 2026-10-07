/**
 * Screen-space reflections (HALO_INFINITE_STYLE_ROADMAP.md I3) on a real GPU,
 * shared by the WebGPU suite (Dawn in Node) and the WebGL2 one (a browser
 * page): a polished metal floor under a gradient sky, a red panel standing on
 * its left and a blue one on its right. With reflections the panels show in
 * the floor, each on its own side, and nothing but the floor changes.
 */

import { composeModelMatrix, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";

import type { SceneDraw } from "../../packages/player/src/render/sceneRenderer";
import { shown, type GpuRenderer } from "./temporalScene";

function quad(material: Partial<MeshAsset["primitives"][number]["material"]>): MeshAsset {
  return {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, ...material },
      },
    ],
  };
}

const floor = (): MeshSceneInstance => ({ mesh: quad({ baseColorFactor: [0.9, 0.9, 0.9, 1], metallicFactor: 1, roughnessFactor: 0.1 }), model: composeModelMatrix([0, 0, 0], [-90, 0, 0], [3, 3, 1]) });

/** The floor and the two panels (matte, so they reflect nothing themselves). */
export function reflectionScene(): MeshSceneInstance[] {
  return [
    floor(),
    { mesh: quad({ baseColorFactor: [1, 0.1, 0.1, 1], metallicFactor: 0, roughnessFactor: 1 }), model: composeModelMatrix([-0.9, 0.6, -1], [0, 0, 0], [0.6, 0.6, 1]) },
    { mesh: quad({ baseColorFactor: [0.1, 0.2, 1, 1], metallicFactor: 0, roughnessFactor: 1 }), model: composeModelMatrix([0.9, 0.6, -1], [0, 0, 0], [0.6, 0.6, 1]) },
  ];
}

export function reflectionDraw(width: number, height: number): SceneDraw {
  return {
    width,
    height,
    out: new Uint8ClampedArray(width * height * 4),
    depth: new Float32Array(width * height),
    view: viewMatrix([0, 1.3, 4], [0, 0.3, 0]),
    projection: projectionMatrix((60 * Math.PI) / 180, width / height, 0.1, 100),
    background: [0, 0, 0, 255],
    lightDirection: [0.3, 1, 0.5],
    ambient: 0.3,
    environment: { sky: [0.45, 0.6, 0.85], horizon: [0.75, 0.8, 0.85], ground: [0.3, 0.3, 0.3], intensity: 1 },
  };
}

export interface ReflectionReport {
  /** Pixels reflections changed (by more than 2 in a channel). */
  changed: number;
  /** Changed pixels that aren't the floor. */
  offFloor: number;
  /** Floor pixels. */
  floor: number;
  /** Mean red-over-green and blue-over-green across the floor's left and right halves, without and with reflections. */
  leftRed: [number, number];
  rightBlue: [number, number];
  leftBlue: [number, number];
  rightRed: [number, number];
  /** Share of the floor's nearest rows (whose reflections climb off the screen) left as they were. */
  nearKept: number;
}

/** Render the scene without and with reflections (plus `extra`) and compare. */
export async function reflectionReport(
  make: (width: number, height: number) => Promise<GpuRenderer>,
  tick: () => void,
  width: number,
  height: number,
  extra: Partial<SceneDraw> = {},
): Promise<ReflectionReport> {
  const instances = reflectionScene();
  const renderer = await make(width, height);
  const floorOnly = await shown(renderer, [floor()], { ...reflectionDraw(width, height), ...extra }, tick);
  const plain = await shown(renderer, instances, { ...reflectionDraw(width, height), ...extra }, tick);
  let mirrored = plain;
  // A few frames, so a temporal history (when extra asks for one) settles.
  for (let i = 0; i < (extra.temporal ? 12 : 1); i += 1) mirrored = await shown(renderer, instances, { ...reflectionDraw(width, height), ...extra, reflections: true }, tick);
  renderer.dispose();
  let plainFrame = plain;
  if (extra.temporal) {
    // The same frames in the same order (so the same jitter and history), without reflections.
    const again = await make(width, height);
    await shown(again, [floor()], { ...reflectionDraw(width, height), ...extra }, tick);
    await shown(again, instances, { ...reflectionDraw(width, height), ...extra }, tick);
    for (let i = 0; i < 12; i += 1) plainFrame = await shown(again, instances, { ...reflectionDraw(width, height), ...extra }, tick);
    again.dispose();
  }
  const isFloor = (i: number) => floorOnly[i * 4]! + floorOnly[i * 4 + 1]! + floorOnly[i * 4 + 2]! > 0;
  let changed = 0;
  let offFloor = 0;
  let floorCount = 0;
  const sums = { leftRed: [0, 0], rightBlue: [0, 0], leftBlue: [0, 0], rightRed: [0, 0] };
  const counts = { left: 0, right: 0 };
  let floorTop = height;
  for (let i = 0; i < width * height; i += 1) if (isFloor(i)) floorTop = Math.min(floorTop, Math.floor(i / width));
  const nearFrom = height - Math.floor((height - floorTop) * 0.2);
  let near = 0;
  let nearSame = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const a = plainFrame.subarray(i * 4, i * 4 + 3);
      const b = mirrored.subarray(i * 4, i * 4 + 3);
      const differs = [0, 1, 2].some((c) => Math.abs(a[c]! - b[c]!) > 2);
      if (differs) changed += 1;
      if (!isFloor(i)) {
        if (differs) offFloor += 1;
        continue;
      }
      floorCount += 1;
      if (y >= nearFrom) {
        near += 1;
        if (!differs) nearSame += 1;
      }
      const left = x < width / 2;
      if (left) counts.left += 1;
      else counts.right += 1;
      for (const [k, frame] of [[0, a], [1, b]] as const) {
        if (left) {
          sums.leftRed[k] += frame[0]! - frame[1]!;
          sums.leftBlue[k] += frame[2]! - frame[1]!;
        } else {
          sums.rightBlue[k] += frame[2]! - frame[1]!;
          sums.rightRed[k] += frame[0]! - frame[1]!;
        }
      }
    }
  }
  const mean = (pair: number[], n: number): [number, number] => [pair[0]! / Math.max(1, n), pair[1]! / Math.max(1, n)];
  return {
    changed,
    offFloor,
    floor: floorCount,
    leftRed: mean(sums.leftRed, counts.left),
    rightBlue: mean(sums.rightBlue, counts.right),
    leftBlue: mean(sums.leftBlue, counts.left),
    rightRed: mean(sums.rightRed, counts.right),
    nearKept: near > 0 ? nearSame / near : 1,
  };
}

/** What screen-space reflections must do to the scene (the same on both GPU paths). */
export function expectReflections(report: ReflectionReport): void {
  const fail = (what: string) => {
    throw new Error(`screen-space reflections: ${what} (${JSON.stringify(report)})`);
  };
  if (!(report.changed > 50)) fail("the floor reflects nothing new");
  if (report.offFloor !== 0) fail("something other than the polished floor changed");
  // Each panel shows in the floor on its own side...
  if (!(report.leftRed[1] > report.leftRed[0] + 10)) fail("the red panel doesn't show in the floor's left half");
  if (!(report.rightBlue[1] > report.rightBlue[0] + 8)) fail("the blue panel doesn't show in the floor's right half");
  // ...and not on the other.
  if (!(Math.abs(report.leftBlue[1] - report.leftBlue[0]) < 3)) fail("blue shows on the left");
  if (!(Math.abs(report.rightRed[1] - report.rightRed[0]) < 3)) fail("red shows on the right");
  // Where the reflected rays leave the screen the probe's reflection stays.
  if (!(report.nearKept > 0.95)) fail("the near floor lost its probe reflection");
}
