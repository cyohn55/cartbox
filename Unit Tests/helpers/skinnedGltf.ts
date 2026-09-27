/**
 * A tiny skinned glTF built in code for the animation tests: a two-joint "arm"
 * (root at the origin, elbow 1 m up) under an Armature node scaled by `scale`,
 * skinning a thin strip from y = 0 to 2 (below the elbow bound to the root,
 * above it to the elbow), plus a rigid "sword" triangle parented to the elbow
 * 0.5 m further up. One clip, "bend", turns the elbow 90° about Z over a second;
 * a second, "wave", turns it back and forth. Positions in the file are relative
 * to the armature, so everything in the scene is `scale` times larger.
 */

const f32 = (values: number[]) => new Uint8Array(new Float32Array(values).buffer);
const u16 = (values: number[]) => new Uint8Array(new Uint16Array(values).buffer);

export function skinnedArmGltf(scale = 1): string {
  const chunks: Uint8Array[] = [];
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  const accessors: object[] = [];
  let offset = 0;
  const add = (bytes: Uint8Array, accessor: Record<string, unknown>) => {
    const pad = (4 - (bytes.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    chunks.push(bytes, new Uint8Array(pad));
    offset += bytes.length + pad;
    accessors.push({ bufferView: views.length - 1, ...accessor });
    return accessors.length - 1;
  };
  // The strip: pairs of vertices at x = ±0.1 for y = 0, 0.5, 1, 1.5, 2.
  const ys = [0, 0.5, 1, 1.5, 2];
  const positions = ys.flatMap((y) => [-0.1, y, 0, 0.1, y, 0]);
  const normals = ys.flatMap(() => [0, 0, 1, 0, 0, 1]);
  const indices: number[] = [];
  for (let r = 0; r < ys.length - 1; r += 1) indices.push(r * 2, r * 2 + 1, r * 2 + 3, r * 2, r * 2 + 3, r * 2 + 2);
  const joints = ys.flatMap((y) => (y <= 1 ? [0, 0, 0, 0, 0, 0, 0, 0] : [1, 0, 0, 0, 1, 0, 0, 0]));
  const weights = ys.flatMap(() => [1, 0, 0, 0, 1, 0, 0, 0]);
  const pos = add(f32(positions), { componentType: 5126, count: ys.length * 2, type: "VEC3" });
  const nrm = add(f32(normals), { componentType: 5126, count: ys.length * 2, type: "VEC3" });
  const idx = add(u16(indices), { componentType: 5123, count: indices.length, type: "SCALAR" });
  const jnt = add(u16(joints), { componentType: 5123, count: ys.length * 2, type: "VEC4" });
  const wgt = add(f32(weights), { componentType: 5126, count: ys.length * 2, type: "VEC4" });
  // Inverse binds relative to the armature: root at the origin, elbow at y = 1.
  const ibm = add(f32([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]), {
    componentType: 5126,
    count: 2,
    type: "MAT4",
  });
  const swordPos = add(f32([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]), { componentType: 5126, count: 3, type: "VEC3" });
  const s = Math.SQRT1_2;
  const bendTimes = add(f32([0, 1]), { componentType: 5126, count: 2, type: "SCALAR" });
  const bendValues = add(f32([0, 0, 0, 1, 0, 0, s, s]), { componentType: 5126, count: 2, type: "VEC4" });
  const waveTimes = add(f32([0, 0.5, 1]), { componentType: 5126, count: 3, type: "SCALAR" });
  const waveValues = add(f32([0, 0, 0, 1, 0, 0, -s, s, 0, 0, 0, 1]), { componentType: 5126, count: 3, type: "VEC4" });
  const armMove = add(f32([0, 0, 0, 5, 0, 0]), { componentType: 5126, count: 2, type: "VEC3" });
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.length;
  }
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Armature", scale: [scale, scale, scale], children: [1, 3] },
      { name: "root", children: [2] },
      { name: "elbow", translation: [0, 1, 0], children: [4] },
      { name: "body", mesh: 0, skin: 0 },
      { name: "sword", mesh: 1, translation: [0, 0.5, 0] },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: pos, NORMAL: nrm, JOINTS_0: jnt, WEIGHTS_0: wgt }, indices: idx }] },
      { primitives: [{ attributes: { POSITION: swordPos } }] },
    ],
    skins: [{ joints: [1, 2], inverseBindMatrices: ibm }],
    animations: [
      { name: "bend", channels: [{ sampler: 0, target: { node: 2, path: "rotation" } }], samplers: [{ input: bendTimes, output: bendValues }] },
      {
        name: "wave",
        channels: [
          { sampler: 0, target: { node: 2, path: "rotation" } },
          { sampler: 1, target: { node: 0, path: "translation" } }, // the armature isn't a joint: skipped
        ],
        samplers: [{ input: waveTimes, output: waveValues }, { input: bendTimes, output: armMove }],
      },
    ],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString("base64")}` }],
  };
  return JSON.stringify(json);
}
