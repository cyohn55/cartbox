/**
 * Reproduces the editor → playtest handoff: an imported mesh authored into the
 * editor's `MeshSidecar` must survive `encodeMeshSidecar` → `parseMeshScene`
 * into a runtime scene the player can draw. Guards the wiring the browser
 * walkthrough exercises (importing a cube then hitting Run).
 */

import { describe, expect, it } from "vitest";

import { parseObj } from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";
import { addMesh, emptyMeshSidecar, encodeMeshSidecar } from "@/lib/meshSidecar";

const CUBE_OBJ = `o cube
v -0.5 -0.5 -0.5
v 0.5 -0.5 -0.5
v 0.5 0.5 -0.5
v -0.5 0.5 -0.5
v -0.5 -0.5 0.5
v 0.5 -0.5 0.5
v 0.5 0.5 0.5
v -0.5 0.5 0.5
vn 0 0 -1
vn 0 0 1
f 1//1 3//1 2//1
f 1//1 4//1 3//1
f 5//2 6//2 7//2
f 5//2 7//2 8//2
`;

describe("editor mesh sidecar → runtime scene", () => {
  it("round-trips an imported mesh through the sidecar into a drawable scene", () => {
    const asset = parseObj(CUBE_OBJ);
    const { sidecar } = addMesh(emptyMeshSidecar(), asset, "cube");
    const encoded = encodeMeshSidecar(sidecar);
    expect(encoded).not.toBeNull();

    const scene = parseMeshScene(encoded);
    expect(scene).not.toBeNull();
    expect(scene!.instances).toHaveLength(1);
    expect(scene!.bounds.radius).toBeGreaterThan(0);
  });
});
