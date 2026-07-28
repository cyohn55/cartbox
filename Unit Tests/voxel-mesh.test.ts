/**
 * The surface handed to the GPU.
 *
 * The mesh replaces the per-frame work of two software renderers, so the bar is
 * that it describes the *same* surface they draw. Every assertion here is
 * therefore a comparison against something already trusted — the model's own
 * exposed-face mask, the cell geometry's face table, and the face-local
 * coordinates {@link renderMapFirstPerson} reports for a pick — rather than
 * against literal vertex data, which would only restate the implementation.
 *
 * The subtle one is the tangent frame. A cube's face edges are perpendicular and
 * anything works; a hexel's rhombic face edges are not, so the handedness the
 * mesh bakes in is the only thing that keeps a normal map from being mirrored on
 * eight of its twelve faces.
 */

import { describe, expect, it } from "vitest";

import {
  CUBE_GEOMETRY,
  HEXEL_GEOMETRY,
  MapVoxelSpace,
  VOXEL_MESH_STRIDE,
  buildFaceLayers,
  castMapRay,
  faceGroupOf,
  mapSpaceToModel,
  voxelModelToMesh,
  type MapCellKind,
  type TextureAtlas,
  type VoxelModel,
} from "@cartbox/editor";

const palette = (index: number): readonly [number, number, number] => [index * 20, 30, 60];
const solid = (colorIndex: number, material = -1) => ({ colorIndex, material, kind: "solid" as MapCellKind });

/** The attributes of one vertex, unpacked from the interleaved buffer. */
function vertexAt(mesh: { vertices: Float32Array }, index: number) {
  const at = index * VOXEL_MESH_STRIDE;
  const read = (offset: number, count: number) =>
    Array.from(mesh.vertices.slice(at + offset, at + offset + count));
  return {
    position: read(0, 3) as [number, number, number],
    layer: mesh.vertices[at + 3]!,
    normal: read(4, 3) as [number, number, number],
    emissive: mesh.vertices[at + 7]!,
    tangent: read(8, 3) as [number, number, number],
    handedness: mesh.vertices[at + 11]!,
    tint: read(12, 3) as [number, number, number],
    uv: read(16, 2) as [number, number],
  };
}

/** How many faces a model's own mask says are exposed. */
function exposedFaces(model: VoxelModel): number {
  let total = 0;
  for (let v = 0; v < model.count; v += 1) {
    const table = (model.plane?.[v] ?? -1) >= 0 ? CUBE_GEOMETRY.faces : (model.geometry ?? CUBE_GEOMETRY).faces;
    for (const face of table) if ((model.faces[v]! & face.bit) !== 0) total += 1;
  }
  return total;
}

/** A small solid patch of ground, as the map's own model builder produces it. */
function groundModel(shape: "cube" | "hexel" = "cube") {
  const space = new MapVoxelSpace(24, 24, shape);
  for (let x = 8; x <= 14; x += 1) {
    for (let z = 8; z <= 14; z += 1) {
      for (let y = 0; y <= 2; y += 1) {
        if (shape === "hexel" && (((x + y + z) % 2) + 2) % 2 !== 0) continue;
        space.set(x, y, z, solid(3, 0));
      }
    }
  }
  const focus = { x: 11, y: 1, z: 11 };
  return { space, focus, model: mapSpaceToModel(space, { palette, focus, radius: 10 }) };
}

describe("what the mesh contains", () => {
  it("emits exactly the faces the model marks as exposed", () => {
    const { model } = groundModel();
    const mesh = voxelModelToMesh(model);
    const faces = exposedFaces(model);

    expect(faces).toBeGreaterThan(0);
    expect(mesh.vertexCount).toBe(faces * 4);
    expect(mesh.triangleCount).toBe(faces * 2);
    expect(mesh.indices).toHaveLength(faces * 6);
  });

  it("emits nothing for a model with nothing in it", () => {
    const space = new MapVoxelSpace(8, 8);
    const mesh = voxelModelToMesh(mapSpaceToModel(space, { palette, focus: { x: 4, y: 0, z: 4 }, radius: 4 }));

    expect(mesh.triangleCount).toBe(0);
    expect(mesh.vertices).toHaveLength(0);
  });

  it("indexes two triangles that share the quad's diagonal", () => {
    const { model } = groundModel();
    const mesh = voxelModelToMesh(model);

    for (let face = 0; face < mesh.triangleCount / 2; face += 1) {
      const base = face * 6;
      const first = mesh.indices[base]!;
      expect(Array.from(mesh.indices.slice(base, base + 6))).toEqual([
        first, first + 1, first + 2, first, first + 2, first + 3,
      ]);
    }
  });

  it("bounds the geometry it emitted", () => {
    const { model } = groundModel();
    const mesh = voxelModelToMesh(model);

    for (let v = 0; v < mesh.vertexCount; v += 1) {
      const { position } = vertexAt(mesh, v);
      for (let axis = 0; axis < 3; axis += 1) {
        expect(position[axis]).toBeGreaterThanOrEqual(mesh.min[axis]! - 1e-6);
        expect(position[axis]).toBeLessThanOrEqual(mesh.max[axis]! + 1e-6);
      }
    }
  });
});

describe("where the mesh puts a texel", () => {
  const atlas: TextureAtlas = {
    tiles: [
      { size: 4, data: new Uint8ClampedArray(4 * 4 * 4).fill(255) },
      { size: 4, data: new Uint8ClampedArray(4 * 4 * 4).fill(128) },
    ],
    materials: [{ top: 0, side: 1, bottom: 1 }],
  };

  it("gives every quad the corner order a pick reports", () => {
    // (0,0) → (1,0) → (1,1) → (0,1) is the winding the ray marcher's face
    // coordinates assume; any other order paints a mirrored or rotated texture.
    const { model } = groundModel();
    const mesh = voxelModelToMesh(model);

    for (let quad = 0; quad < mesh.vertexCount / 4; quad += 1) {
      const uvs = [0, 1, 2, 3].map((corner) => vertexAt(mesh, quad * 4 + corner).uv);
      expect(uvs).toEqual([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]);
    }
  });

  it("lands a vertex where the ray marcher says that face is", () => {
    // The strongest statement the two can make together: cast a ray at a face,
    // then find the mesh quad for that same cell and face and check its corners
    // enclose the point the ray struck.
    const { space, focus, model } = groundModel();
    const mesh = voxelModelToMesh(model);
    const hit = castMapRay(space, [11, 6, 11], [0, -1, 0]);
    expect(hit).not.toBeNull();

    const face = CUBE_GEOMETRY.faces[hit!.face]!;
    const centre: [number, number, number] = [
      hit!.x - focus.x + face.normal[0] * 0.5,
      hit!.y - focus.y + face.normal[1] * 0.5,
      hit!.z - focus.z + face.normal[2] * 0.5,
    ];
    const found = [...Array(mesh.vertexCount / 4).keys()].some((quad) => {
      const corners = [0, 1, 2, 3].map((corner) => vertexAt(mesh, quad * 4 + corner).position);
      const mid = [0, 1, 2].map(
        (axis) => corners.reduce((sum, corner) => sum + corner[axis]!, 0) / 4,
      );
      return [0, 1, 2].every((axis) => Math.abs(mid[axis]! - centre[axis]!) < 1e-6);
    });

    expect(found).toBe(true);
  });

  it("resolves a material to the layer the face group names", () => {
    const { model } = groundModel();
    const faceLayer = buildFaceLayers(atlas);
    const mesh = voxelModelToMesh(model, { faceLayer });

    for (let quad = 0; quad < mesh.vertexCount / 4; quad += 1) {
      const { layer, normal } = vertexAt(mesh, quad * 4);
      expect(layer).toBe(faceLayer[0 * 3 + faceGroupOf(normal[1])]);
    }
  });

  it("draws a face flat when nothing skins it", () => {
    const space = new MapVoxelSpace(12, 12);
    space.set(6, 0, 6, solid(4)); // no material
    const model = mapSpaceToModel(space, { palette, focus: { x: 6, y: 0, z: 6 }, radius: 4 });
    const mesh = voxelModelToMesh(model, { faceLayer: buildFaceLayers(atlas) });

    const { layer, tint } = vertexAt(mesh, 0);
    expect(layer).toBe(-1);
    // The flat colour is the palette's, normalised for the shader.
    expect(tint.map((channel) => Math.round(channel * 255))).toEqual([...palette(4)]);
  });
});

describe("the tangent frame", () => {
  /** Reconstruct the bitangent the shader computes and compare with the face. */
  function bitangentOf(normal: number[], tangent: number[], handedness: number): number[] {
    return [
      (normal[1]! * tangent[2]! - normal[2]! * tangent[1]!) * handedness,
      (normal[2]! * tangent[0]! - normal[0]! * tangent[2]!) * handedness,
      (normal[0]! * tangent[1]! - normal[1]! * tangent[0]!) * handedness,
    ];
  }

  it("runs the tangent along u and the bitangent along v, on cubes", () => {
    const { model } = groundModel();
    const mesh = voxelModelToMesh(model);

    for (let quad = 0; quad < mesh.vertexCount / 4; quad += 1) {
      const corner0 = vertexAt(mesh, quad * 4);
      const alongU = vertexAt(mesh, quad * 4 + 1).position;
      const alongV = vertexAt(mesh, quad * 4 + 3).position;
      const edgeU = alongU.map((value, axis) => value - corner0.position[axis]!);
      const edgeV = alongV.map((value, axis) => value - corner0.position[axis]!);

      // The tangent points along the u edge...
      const alignU = edgeU.reduce((sum, value, axis) => sum + value * corner0.tangent[axis]!, 0);
      expect(alignU).toBeGreaterThan(0);
      // ...and the bitangent the shader builds points along the v edge.
      const bitangent = bitangentOf(corner0.normal, corner0.tangent, corner0.handedness);
      const alignV = edgeV.reduce((sum, value, axis) => sum + value * bitangent[axis]!, 0);
      expect(alignV).toBeGreaterThan(0);
    }
  });

  it("gets v right on a hexel's rhombic faces too", () => {
    // A rhombus has non-perpendicular edges, so the handedness cannot be assumed
    // from the cross product's default sign — this is where guessing breaks.
    const { model } = groundModel("hexel");
    const mesh = voxelModelToMesh(model, { geometry: HEXEL_GEOMETRY });
    expect(mesh.triangleCount).toBeGreaterThan(0);

    for (let quad = 0; quad < mesh.vertexCount / 4; quad += 1) {
      const corner0 = vertexAt(mesh, quad * 4);
      const alongV = vertexAt(mesh, quad * 4 + 3).position;
      const edgeV = alongV.map((value, axis) => value - corner0.position[axis]!);
      const bitangent = bitangentOf(corner0.normal, corner0.tangent, corner0.handedness);
      const alignV = edgeV.reduce((sum, value, axis) => sum + value * bitangent[axis]!, 0);
      expect(alignV).toBeGreaterThan(0);
    }
  });
});

describe("plane cells", () => {
  it("collapses a plane onto the single quad standing in its cell", () => {
    const space = new MapVoxelSpace(12, 12);
    space.set(6, 1, 6, { colorIndex: 2, material: 0, kind: "planeZ" });
    const focus = { x: 6, y: 1, z: 6 };
    const mesh = voxelModelToMesh(mapSpaceToModel(space, { palette, focus, radius: 4 }));

    // Two quads — the plane is drawn from both sides — and every vertex sits
    // exactly on the cell's own z, with no thickness at all.
    expect(mesh.vertexCount).toBe(8);
    for (let v = 0; v < mesh.vertexCount; v += 1) {
      expect(vertexAt(mesh, v).position[2]).toBeCloseTo(0, 10);
    }
  });

  it("stands a cross on two axes at once", () => {
    const space = new MapVoxelSpace(12, 12);
    space.set(6, 1, 6, { colorIndex: 2, material: 0, kind: "cross" });
    const mesh = voxelModelToMesh(
      mapSpaceToModel(space, { palette, focus: { x: 6, y: 1, z: 6 }, radius: 4 }),
    );

    const flatAxes = new Set<number>();
    for (let quad = 0; quad < mesh.vertexCount / 4; quad += 1) {
      const positions = [0, 1, 2, 3].map((corner) => vertexAt(mesh, quad * 4 + corner).position);
      for (const axis of [0, 1, 2]) {
        if (positions.every((position) => Math.abs(position[axis]!) < 1e-9)) flatAxes.add(axis);
      }
    }
    expect([...flatAxes].sort()).toEqual([0, 2]);
  });
});
