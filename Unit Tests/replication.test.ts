/**
 * Entity replication (AAA_PRODUCTION_ROADMAP.md N1): poses sent by the host to
 * every client with priority, relevancy by distance and delta compression,
 * through loss and reordering.
 */
import { describe, expect, it } from "vitest";
import { ReplicationClient, ReplicationHost, type EntityPose } from "../packages/player/src/net/replication";

const pose = (id: number, x: number, y = 0, z = 0, priority = 1, yaw = 0): EntityPose => ({ id, position: [x, y, z], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], priority });

/** Seeded loss. */
function lossy(seed: number, rate: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32) < rate;
}

describe("entity replication (N1)", () => {
  it("brings every client to the host's poses, at the quantization's precision", () => {
    const host = new ReplicationHost();
    const a = new ReplicationClient();
    const b = new ReplicationClient();
    const crates = Array.from({ length: 10 }, (_, i) => pose(i, i * 2.123, 1.5, -3.75, 1, i * 0.3));
    for (let t = 0; t < 3; t += 1) {
      const packet = host.send(crates, []);
      a.receive(packet);
      b.receive(packet);
      host.receive("a", a.ack([0, 0, 0]));
      host.receive("b", b.ack([0, 0, 0]));
    }
    for (const c of [a, b]) {
      const got = c.poses();
      expect(got.size).toBe(10);
      for (const p of crates) {
        const q = got.get(p.id)!;
        q.position.forEach((v, k) => expect(v).toBeCloseTo(p.position[k]!, 2));
        q.rotation.forEach((v, k) => expect(v).toBeCloseTo(p.rotation[k]!, 3));
      }
    }
  });

  it("sends only what changed, against what every client has: a still scene costs nothing", () => {
    const host = new ReplicationHost({ budget: 4000 });
    const client = new ReplicationClient();
    const scene = Array.from({ length: 40 }, (_, i) => pose(i, i, 0, 0));
    const full = host.send(scene, []);
    client.receive(full);
    host.receive("c", client.ack([0, 0, 0]));
    const still = host.send(scene, []);
    expect(host.lastSent).toBe(0);
    expect(still.length).toBeLessThan(10);
    // One crate moves along x: one entity, one field.
    const moved = scene.map((p) => (p.id === 7 ? pose(7, 7.5) : p));
    const delta = host.send(moved, []);
    expect(host.lastSent).toBe(1);
    expect(delta.length).toBe(7 + 2 + 1 + 1 + 4);
    expect(full.length).toBeGreaterThan(delta.length * 40);
    client.receive(still);
    expect(client.receive(delta)).toBe(true);
    expect(client.poses().get(7)!.position[0]).toBeCloseTo(7.5);
  });

  it("stays correct through 30% loss and reordering, with two clients that lose different packets", () => {
    const host = new ReplicationHost();
    const clients = [new ReplicationClient(), new ReplicationClient()];
    const drop = [lossy(1, 0.3), lossy(2, 0.3)];
    let late: { to: number; packet: Uint8Array } | null = null;
    let world: EntityPose[] = [];
    for (let t = 0; t < 200; t += 1) {
      world = Array.from({ length: 12 }, (_, i) => pose(i, Math.sin(t * 0.05 + i) * 10, i, Math.cos(t * 0.03 * i) * 5, 1, t * 0.01 * i));
      const packet = host.send(world, []);
      clients.forEach((c, k) => {
        if (drop[k]!()) return;
        // Now and then a packet arrives a tick late, behind the next.
        if (k === 1 && t % 17 === 0) {
          late = { to: k, packet };
          return;
        }
        expect(c.receive(packet)).toBe(true);
        if (late && late.to === k) {
          expect(c.receive(late.packet)).toBe(true);
          late = null;
        }
        host.receive(String(k), c.ack([0, 0, 0]));
      });
    }
    // A last clean round, then both agree with the host.
    for (let t = 0; t < 3; t += 1) {
      const packet = host.send(world, []);
      clients.forEach((c, k) => {
        c.receive(packet);
        host.receive(String(k), c.ack([0, 0, 0]));
      });
    }
    for (const c of clients) for (const p of world) c.poses().get(p.id)!.position.forEach((v, k) => expect(v).toBeCloseTo(p.position[k]!, 2));
  });

  it("puts what's near a viewer and high priority first within the budget, never sends what's out of range, and catches the rest up", () => {
    const host = new ReplicationHost({ near: 10, far: 50, budget: 7 + 5 * 32 });
    const client = new ReplicationClient();
    const world = [
      ...Array.from({ length: 10 }, (_, i) => pose(i, 30 + i)), // farther from the viewer: less relevant
      pose(50, 1, 0, 0, 1), // near
      pose(51, 2, 0, 0, 5), // near, important
      pose(60, 500, 0, 0, 10), // out of range
    ];
    const order: number[][] = [];
    for (let t = 0; t < 6; t += 1) {
      const moving = world.map((p) => ({ ...p, position: [p.position[0] + t * 0.1, p.position[1], p.position[2]] as const }));
      client.receive(host.send(moving, [[0, 0, 0]]));
      order.push([...client.poses().keys()]);
    }
    expect(order[0]!.slice(0, 2)).toEqual([51, 50]);
    expect(order[0]!.length).toBe(5); // the budget: five whole poses a packet
    expect(order[5]).not.toContain(60);
    expect(new Set(order.flat())).toEqual(new Set([...Array.from({ length: 10 }, (_, i) => i), 50, 51])); // the far ones got their turns
  });
});

import { MemoryNetHub, NetSession } from "@cartbox/player";
import { decodeNetMessage, encodeNetMessage } from "../packages/player/src/net/netCodec";

describe("replication in the session (N1)", () => {
  it("rides the session's messages, binary codec included, from the host to a guest", async () => {
    const hub = new MemoryNetHub();
    let clock = 0;
    const host = new NetSession(hub.transport("h"), () => clock);
    await host.connect();
    const guest = new NetSession(hub.transport("g"), () => clock);
    await guest.connect();
    const world = [pose(3, 4, 5, 6), pose(9, -1, 0, 2)];
    host.replicate(() => world, () => [0, 0, 0]);
    guest.replicate(() => [], () => [1, 2, 3]);
    const words = new Uint32Array(256);
    for (let t = 0; t < 40; t += 1) {
      clock += 1000 / 60;
      for (const s of [host, guest]) {
        s.beforeTick(words);
        s.afterTick(words);
      }
    }
    const got = guest.replicated();
    expect([...got.keys()].sort()).toEqual([3, 9]);
    expect(got.get(3)!.position[0]).toBeCloseTo(4);
    expect(host.replicated().size).toBe(0);
    // The binary codec carries it intact.
    const message = { x: "AQIDBA==", xa: "BQY=", t: 7 };
    expect(decodeNetMessage(encodeNetMessage(message))).toEqual(message);
  });
});

import { parseMeshScene } from "@cartbox/player";
import { serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import { decodeMeshSidecar, encodeMeshSidecar, setMeshReplicate } from "../apps/web/src/lib/meshSidecar";

describe("marking objects replicated (N1)", () => {
  it("is stored on the object and read into the player's scene", () => {
    const tri: MeshAsset = { name: "t", primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
    const sidecar = decodeMeshSidecar(JSON.stringify({ version: 2, meshes: [{ id: "crate", name: "crate", mesh: serializeMeshAsset(tri), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] }));
    const marked = setMeshReplicate(sidecar, "crate", 3);
    const encoded = encodeMeshSidecar(marked)!;
    expect(decodeMeshSidecar(encoded).meshes[0]!.replicate).toBe(3);
    expect(parseMeshScene(encoded)!.instances[0]!.replicate).toBe(3);
    expect(setMeshReplicate(marked, "crate", null).meshes[0]!.replicate).toBeUndefined();
  });
});
