/**
 * Joints and vehicles (AAA_PRODUCTION_ROADMAP.md S5): a slider joint beside
 * the hinge, and a ray-cast vehicle on Rapier's controller, its wheels drawn by
 * objects the session places, steers and spins. Real Rapier throughout.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_VEHICLE, readPhysicsSpec, readVehicleSpec, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import { PhysicsSession, parseMeshScene, physicsSdkLua, sceneObjectsSdkLua } from "@cartbox/player";
import { PHYS_OP_DRIVE, PHYS_OP_MOTOR, PHYS_Q_VEHICLE } from "../packages/player/src/physics/protocol";
import { createRapierBackend } from "../apps/web/src/lib/physicsRapier";
import { addVehicleWheels } from "../apps/web/src/lib/vehicleKit";
import { decodeMeshSidecar, encodeMeshSidecar, meshWorldMatrices } from "../apps/web/src/lib/meshSidecar";

beforeAll(async () => {
  await RAPIER.init();
});

function cube(): string {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const mesh: MeshAsset = { name: "cube", primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
  return serializeMeshAsset(mesh);
}
const T = (position: number[], scale = [1, 1, 1], rotation = [0, 0, 0]) => ({ position, rotation, scale });
const floor = (mesh: string) => ({ id: "floor", name: "floor", mesh, transform: T([0, -0.5, 0], [400, 1, 400]), physics: { body: "static", shape: "box" } });
const step = (session: PhysicsSession, ticks: number, commands: { op: number; a: number; v: number[] }[] = []) => {
  for (let i = 0; i < ticks; i += 1) session.run(i === 0 ? commands : []);
};
const position = (session: PhysicsSession, object: number) => {
  const m = session.overrides().get(object)!;
  return [m[12]!, m[13]!, m[14]!];
};

describe("the slider joint (S5)", () => {
  it("is read with its axis and limits in metres", () => {
    expect(readPhysicsSpec({ body: "dynamic", joint: { kind: "slider", axis: "x", limits: [3, -1] } })?.joint).toEqual({ kind: "slider", anchor: [0, 0, 0], axis: "x", limits: [-1, 3] });
  });

  it("slides a platform along its axis under a motor, stopping at its limit, and never turns", () => {
    const mesh = cube();
    const sc = parseMeshScene(
      JSON.stringify({
        version: 2,
        meshes: [
          floor(mesh),
          // A lift: slides up its own Y from where it starts, at most 3 m.
          { id: "lift", name: "lift", mesh, transform: T([0, 2, 0], [2, 0.2, 2]), physics: { body: "dynamic", shape: "box", joint: { kind: "slider", anchor: [0, 0, 0], axis: "y", limits: [0, 3] } } },
        ],
      }),
    )!;
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    step(session, 60);
    expect(position(session, 1)[1]).toBeCloseTo(2, 1); // held where it was placed, against gravity
    step(session, 240, [{ op: PHYS_OP_MOTOR, a: 1, v: [1, 1000, 0, 0, 0, 0] }]);
    const [x, y, z] = position(session, 1);
    expect(y).toBeCloseTo(5, 1); // driven up 1 m/s to its 3 m stop
    expect(Math.hypot(x, z)).toBeLessThan(0.01);
    const m = session.overrides().get(1)!;
    expect(m[0]! / 2).toBeCloseTo(1, 3); // still square to the world: it slides, it doesn't turn
    session.destroy();
  });
});

describe("the ray-cast vehicle (S5)", () => {
  const scene = (rotation = [0, 0, 0]) => {
    const mesh = cube();
    const wheels = DEFAULT_VEHICLE.wheels.map((w) => ({ id: w.visual!, name: w.visual!, mesh, parent: "car", transform: T([w.at[0], w.at[1] - 0.5, w.at[2]], [0.3, 0.8, 0.8]) }));
    return parseMeshScene(
      JSON.stringify({
        version: 2,
        meshes: [
          floor(mesh),
          { id: "car", name: "car", mesh, transform: T([0, 1.2, 0], [1.8, 0.6, 4], rotation), physics: { body: "dynamic", shape: "box", mass: 800, vehicle: { ...DEFAULT_VEHICLE, wheels: DEFAULT_VEHICLE.wheels.map((w) => ({ ...w, at: [w.at[0] / 1.8, w.at[1] / 0.6, w.at[2] / 4] })) } } },
          ...wheels,
        ],
      }),
    )!;
  };

  it("is read with its wheels and settings, and only on a dynamic body", () => {
    expect(readVehicleSpec({ wheels: [{ at: [1, 2, 3], radius: 0.5, steered: true }], engine: 1e9 })).toMatchObject({ wheels: [{ at: [1, 2, 3], radius: 0.5, steered: true }], engine: 100000 });
    expect(readVehicleSpec({ wheels: [] })).toBeNull();
    expect(readPhysicsSpec({ body: "static", vehicle: DEFAULT_VEHICLE })?.vehicle).toBeUndefined();
    expect(readPhysicsSpec({ body: "dynamic", vehicle: DEFAULT_VEHICLE })?.vehicle?.wheels).toHaveLength(4);
  });

  it("rests on its springs, drives forward, steers, and brakes to a stop", () => {
    const sc = scene();
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    step(session, 90);
    const rest = session.vehicle(1)!;
    expect(rest.wheels.every((w) => w.contact)).toBe(true); // on all four wheels
    const restY = position(session, 1)[1];
    expect(restY).toBeGreaterThan(0.6); // held up by its springs, not lying on the floor
    expect(Math.abs(session.query(PHYS_Q_VEHICLE, 1, [])![0]!)).toBeLessThan(0.05);
    expect(session.query(PHYS_Q_VEHICLE, 1, [])!.slice(1)).toEqual([4, 4]);
    expect(Math.hypot(...session.inspect().get(1)!.velocity)).toBeLessThan(0.05); // at rest as the cart reads its body too

    // Full throttle for three seconds: it sets off along its own +Z.
    step(session, 180, [{ op: PHYS_OP_DRIVE, a: 1, v: [1, 0, 0, 0, 0, 0] }]);
    const [x1, , z1] = position(session, 1);
    expect(z1).toBeGreaterThan(5);
    expect(Math.abs(x1)).toBeLessThan(0.5); // straight
    const speed = session.vehicle(1)!.speed;
    expect(speed).toBeGreaterThan(2);

    // Steering left (+) while driving turns it toward +X (its left, looking along +Z with +Y up).
    step(session, 120, [{ op: PHYS_OP_DRIVE, a: 1, v: [1, 1, 0, 0, 0, 0] }]);
    const [x2] = position(session, 1);
    expect(x2).toBeGreaterThan(x1 + 1);

    // Brakes on, throttle off: it stops.
    step(session, 300, [{ op: PHYS_OP_DRIVE, a: 1, v: [0, 0, 1, 0, 0, 0] }]);
    expect(Math.abs(session.vehicle(1)!.speed)).toBeLessThan(0.2);
    session.destroy();
  });

  it("places, steers and spins its wheel objects", () => {
    const sc = scene();
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    step(session, 90);
    const chassis = position(session, 1);
    const fl = session.overrides().get(2)!;
    // The front-left wheel sits at its corner, below the chassis, by about its radius off the floor.
    expect(fl[12]!).toBeCloseTo(chassis[0] - 0.9, 1);
    expect(fl[14]!).toBeCloseTo(chassis[2] + 1.3, 1);
    expect(fl[13]!).toBeLessThan(chassis[1]);
    expect(fl[13]!).toBeCloseTo(0.4, 1);
    // Driven forward, the wheels roll: the drawn wheel's matrix changes as the chassis's turns not at all.
    step(session, 60, [{ op: PHYS_OP_DRIVE, a: 1, v: [1, 1, 0, 0, 0, 0] }]);
    const state = session.vehicle(1)!;
    expect(Math.abs(state.wheels[2]!.rotation)).toBeGreaterThan(1);
    expect(state.wheels[0]!.steering).toBeCloseTo((DEFAULT_VEHICLE.steer * Math.PI) / 180, 3); // the front wheels steer
    expect(state.wheels[2]!.steering).toBe(0); // the rear ones don't
    session.destroy();
  });

  it("is driven from Lua through cartbox.drive, and read through cartbox.vehicle", () => {
    const sc = scene();
    const lua = physicsSdkLua(sc, { pmemAddress: 0 } as never) + sceneObjectsSdkLua(sc);
    expect(lua).toContain(`_cmd(${PHYS_OP_DRIVE}, i, throttle or 0, steer or 0, brake or 0)`);
    expect(lua).toContain(`_q(${PHYS_Q_VEHICLE}, i)`);
  });
});

describe("the editor's vehicle preset (S5)", () => {
  it("adds a round wheel object for each wheel, under the chassis, at the end of its spring", () => {
    const mesh = cube();
    const sidecar = decodeMeshSidecar(JSON.stringify({ version: 2, meshes: [{ id: "car", name: "car", mesh, transform: T([3, 1, 2], [1.8, 0.6, 4]) }] }));
    const vehicle = { ...DEFAULT_VEHICLE, wheels: DEFAULT_VEHICLE.wheels.map((w) => ({ ...w, at: [w.at[0] / 1.8, w.at[1] / 0.6, w.at[2] / 4] as [number, number, number] })) };
    const next = addVehicleWheels(sidecar, "car", vehicle);
    expect(next.meshes.map((m) => m.name)).toEqual(["car", "wheel-fl", "wheel-fr", "wheel-rl", "wheel-rr"]);
    expect(addVehicleWheels(next, "car", vehicle).meshes).toHaveLength(5); // not added twice
    const world = meshWorldMatrices(next);
    const fl = world[1]!;
    expect([fl[12], fl[13], fl[14]].map((v) => Number(v!.toFixed(3)))).toEqual([2.1, 0.2, 3.3]);
    // Round: its world columns (radius along Y and Z, width along X) undo the chassis's stretch.
    const len = (c: number) => Math.hypot(fl[c * 4]!, fl[c * 4 + 1]!, fl[c * 4 + 2]!);
    expect([len(0), len(1), len(2)].map((v) => Number(v.toFixed(3)))).toEqual([1, 1, 1]);
    expect(encodeMeshSidecar(next)).toContain("wheel-rr");
  });
});
