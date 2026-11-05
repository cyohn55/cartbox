/**
 * The editor's vehicle preset (AAA_PRODUCTION_ROADMAP.md S5): wheel objects
 * for a chassis's ray-cast wheels, so a car looks like one without modelling.
 *
 * Each wheel the vehicle names (`visual`) and the chassis doesn't already have
 * under it becomes a cylinder child, its axle along the chassis's X, at the end
 * of its spring at rest. Its scale undoes the chassis's, so a stretched
 * chassis still gets round wheels. The physics session then places, steers
 * and spins them every frame.
 */

import { cylinderSolid, type MeshMaterial, type VehicleSpec } from "@cartbox/editor";

import { addMesh, setMeshParent, type MeshSidecar } from "./meshSidecar";

const TYRE: MeshMaterial = { name: "tyre", baseColorFactor: [0.08, 0.08, 0.09, 1], baseColorImage: null, roughnessFactor: 0.9 };
const WIDTH = 0.3;

/** Whether `id` sits under `root` in the Hierarchy. */
function under(sidecar: MeshSidecar, id: string, root: string): boolean {
  const byId = new Map(sidecar.meshes.map((m) => [m.id, m]));
  const seen = new Set<string>();
  for (let p = byId.get(id)?.parent; p && !seen.has(p); p = byId.get(p)?.parent) {
    if (p === root) return true;
    seen.add(p);
  }
  return false;
}

/** Add a wheel object under `chassisId` for each of `vehicle`'s named wheels it lacks. */
export function addVehicleWheels(sidecar: MeshSidecar, chassisId: string, vehicle: VehicleSpec): MeshSidecar {
  const chassis = sidecar.meshes.find((m) => m.id === chassisId);
  if (!chassis) return sidecar;
  const [sx, sy, sz] = chassis.transform.scale.map((v) => (Math.abs(v) > 1e-6 ? v : 1)) as [number, number, number];
  let next = sidecar;
  for (const wheel of vehicle.wheels) {
    if (!wheel.visual || next.meshes.some((m) => m.name === wheel.visual && under(next, m.id, chassisId))) continue;
    const mesh = cylinderSolid([wheel.radius * 2, WIDTH, wheel.radius * 2], 20, TYRE);
    const added = addMesh(next, { ...mesh, name: wheel.visual }, wheel.visual);
    next = setMeshParent(added.sidecar, added.id, chassisId, { keepWorld: false });
    // Turned onto its side (its Y, the axle, along the chassis's X); its own X and Y swap places under the
    // chassis's scale, so the scale that undoes it swaps them too.
    const transform = {
      position: [wheel.at[0], wheel.at[1] - vehicle.suspension / sy, wheel.at[2]] as [number, number, number],
      rotation: [0, 0, 90] as [number, number, number],
      scale: [1 / sy, 1 / sx, 1 / sz] as [number, number, number],
    };
    next = { ...next, meshes: next.meshes.map((m) => (m.id === added.id ? { ...m, transform } : m)) };
  }
  return next;
}
