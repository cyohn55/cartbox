/**
 * Bake the scene's walkable surface for navigation (ENGINE_ROADMAP.md, Phase 6;
 * see navmesh.ts in @cartbox/editor) from what stands still in it: every placed
 * object's triangles in world space, except prefab copies held in reserve,
 * skinned characters, and bodies physics moves (dynamic, kinematic, character) — the
 * things that walk the surface, not the ground they walk on. Triggers don't
 * block either.
 */

import { DEFAULT_NAV_AGENT, bakeNavMesh, serializeNavMesh, type NavAgent, type NavMesh, type SerializedNavMesh } from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";

import { encodeMeshSidecar, type MeshSidecar } from "./meshSidecar";

/** World-space triangles (9 floats each) of the scene's static objects. */
export function staticTriangles(sidecar: MeshSidecar): Float32Array {
  const encoded = encodeMeshSidecar(sidecar);
  const scene = encoded ? parseMeshScene(encoded) : null;
  if (!scene) return new Float32Array(0);
  const out: number[] = [];
  for (const inst of scene.instances) {
    if (inst.pooled || inst.mesh.skin) continue;
    const body = inst.physics?.body;
    if (body === "dynamic" || body === "kinematic" || body === "character" || inst.physics?.trigger) continue;
    const m = inst.model;
    for (const p of inst.mesh.primitives) {
      const pos = p.positions;
      for (let i = 0; i < p.indices.length; i += 1) {
        const v = p.indices[i]! * 3;
        const x = pos[v]!;
        const y = pos[v + 1]!;
        const z = pos[v + 2]!;
        out.push(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
      }
    }
  }
  return new Float32Array(out);
}

/** Bake the scene's surface for an agent (defaults fill anything left out). */
export function bakeSceneNavMesh(sidecar: MeshSidecar, agent: Partial<NavAgent> = {}, cell = 0.25): { mesh: NavMesh; stored: SerializedNavMesh } {
  const mesh = bakeNavMesh(staticTriangles(sidecar), { cell, agent: { ...DEFAULT_NAV_AGENT, ...agent } });
  return { mesh, stored: serializeNavMesh(mesh) };
}
