/**
 * Unit tests for the editable backdrop prop set (apps/web/src/lib/backdropProps.ts):
 * pixel encode/decode round-trips, the untrusted-input gate, and the built-in
 * defaults. Assertions come from the module's own inputs/outputs, not baked
 * constants. Dep-free, loads under the TS hook.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/backdropProps.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.resolve(here, "../apps/web/src/lib/backdropProps.ts")).href
);
const {
  DEFAULT_BACKDROP_PROP_SET,
  encodePropArt,
  decodePropArt,
  serializePropSet,
  deserializePropSet,
  normalizePropSet,
  createVoxelBackdropProp,
} = mod;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

// 1. The defaults are non-empty and versioned.
check(
  "default set has props and a version",
  DEFAULT_BACKDROP_PROP_SET.props.length > 0 && Number.isFinite(DEFAULT_BACKDROP_PROP_SET.version),
);

// 2. Pixel round-trip: encode then decode returns identical bytes and dims.
{
  const w = 3;
  const h = 2;
  const albedo = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < albedo.length; i += 1) albedo[i] = (i * 7) % 256;
  const emissive = new Uint8Array(w * h);
  for (let i = 0; i < emissive.length; i += 1) emissive[i] = (i * 40) % 256;

  const art = encodePropArt(albedo, emissive, w, h);
  const back = decodePropArt(art);
  check(
    "encode→decode preserves pixels and dims",
    back.width === w &&
      back.height === h &&
      Buffer.compare(Buffer.from(back.albedo), Buffer.from(albedo)) === 0 &&
      Buffer.compare(Buffer.from(back.emissive), Buffer.from(emissive)) === 0,
  );
}

// 3. Every default prop's art decodes to the size its dims imply.
{
  let consistent = true;
  for (const prop of DEFAULT_BACKDROP_PROP_SET.props) {
    const d = decodePropArt(prop.art);
    if (d.albedo.length !== d.width * d.height * 4 || d.emissive.length !== d.width * d.height) consistent = false;
  }
  check("default prop art is internally consistent", consistent);
}

// 4. Serialise → deserialise preserves the set (count + first prop's pixels).
{
  const json = serializePropSet(DEFAULT_BACKDROP_PROP_SET);
  const back = deserializePropSet(json);
  check(
    "serialise/deserialise round-trips the set",
    back !== null &&
      back.props.length === DEFAULT_BACKDROP_PROP_SET.props.length &&
      back.props[0].art.albedo === DEFAULT_BACKDROP_PROP_SET.props[0].art.albedo,
  );
}

// 5. The gate drops a malformed prop but keeps valid ones.
{
  const good = DEFAULT_BACKDROP_PROP_SET.props[0];
  const dirty = {
    version: 1,
    props: [good, { id: "broken", art: { width: 4, height: 4, albedo: "AAAA", emissive: "AA" }, depth: 3, fx: 0, fy: 0, cell: 2, motion: good.motion }],
  };
  const cleaned = normalizePropSet(dirty);
  check("gate drops the malformed prop, keeps the valid one", cleaned !== null && cleaned.props.length === 1);
}

// 6. The gate clamps out-of-range motion and placement rather than trusting them.
{
  const good = DEFAULT_BACKDROP_PROP_SET.props[0];
  const wild = {
    version: 1,
    props: [{ ...good, fx: 9, cell: 999, motion: { ...good.motion, bobPhase: 5, spinDuration: 9999, spinCycle: 4 } }],
  };
  const cleaned = normalizePropSet(wild);
  const p = cleaned.props[0];
  check(
    "gate clamps wild placement + motion into bounds",
    p.fx <= 1.2 && p.cell <= 8 && p.motion.bobPhase <= 1 && p.motion.spinDuration <= p.motion.spinCycle,
  );
}

// 7. Non-set / invalid JSON is rejected.
{
  check("invalid JSON deserialises to null", deserializePropSet("{not json") === null);
  check("a non-set value normalises to null", normalizePropSet(42) === null);
}

// 8. A voxel prop (a serialized grid, no sprite art) survives the gate and
//    round-trips, and a prop with neither art nor voxel is dropped.
{
  const voxelProp = createVoxelBackdropProp("voxel-1", "My model", '{"version":1,"sizeX":4,"sizeY":4,"sizeZ":4,"colors":"x","emissive":"y"}');
  check("factory prop carries the voxel string and no art", voxelProp.voxel.length > 0 && voxelProp.art === undefined);

  const set = { version: 1, props: [voxelProp] };
  const back = deserializePropSet(serializePropSet(set));
  check("voxel prop round-trips through the gate", back !== null && back.props.length === 1 && back.props[0].voxel === voxelProp.voxel);

  const geometryless = normalizePropSet({ version: 1, props: [{ id: "empty", depth: 3, fx: 0, fy: 0, cell: 2, motion: DEFAULT_BACKDROP_PROP_SET.props[0].motion }] });
  check("a prop with neither art nor voxel is dropped", geometryless !== null && geometryless.props.length === 0);
}

console.log(`backdropProps: ${passed}/${passed} checks passed`);
