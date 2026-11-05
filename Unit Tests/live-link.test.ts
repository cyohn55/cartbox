/**
 * The DCC live link (AAA_PRODUCTION_ROADMAP.md D6): the Blender add-on's
 * server (plain Python, run here without Blender) pushes a GLB over a real
 * WebSocket to the editor's client, which puts it in the scene: in place of
 * the object of its name, or added.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { encodeGlb, parseGlb, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import { applyLiveMesh, connectLiveLink } from "../apps/web/src/lib/liveLink";
import { decodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";

const ADDON = path.resolve(__dirname, "../tools/blender/cartbox_live_link.py");

const tri = (s: number): MeshAsset => ({ name: "t", primitives: [{ positions: Float32Array.from([0, 0, 0, s, 0, 0, 0, s, 0]), normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] });

describe("the live link (D6)", () => {
  it("puts a pushed model in place of the object of its name, keeping its place, or adds it", () => {
    const sidecar = decodeMeshSidecar(JSON.stringify({ version: 2, meshes: [{ id: "a", name: "Crate", mesh: serializeMeshAsset(tri(1)), transform: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] }));
    const replaced = applyLiveMesh(sidecar, "Crate", tri(3));
    expect(replaced.action).toBe("replaced");
    expect(replaced.sidecar.meshes).toHaveLength(1);
    expect(replaced.sidecar.meshes[0]!.transform.position).toEqual([4, 0, 0]);
    expect(replaced.sidecar.meshes[0]!.mesh).not.toBe(sidecar.meshes[0]!.mesh);
    const added = applyLiveMesh(sidecar, "Lamp", tri(2));
    expect(added.action).toBe("added");
    expect(added.sidecar.meshes.map((m) => m.name)).toEqual(["Crate", "Lamp"]);
  });

  it("carries a GLB from the add-on's server to the editor over a real WebSocket", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cbx-link-"));
    const file = path.join(dir, "rock.glb");
    writeFileSync(file, encodeGlb(tri(2)));
    const port = 19000 + Math.floor(Math.random() * 500);
    const server = spawn("python3", ["-I", ADDON, "--serve", file, "--port", String(port), "--name", "Rock"], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => server.stdout!.once("data", () => resolve()));
    const got = await new Promise<{ name: string; mesh: MeshAsset }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("nothing pushed")), 8000);
      connectLiveLink({
        url: `ws://127.0.0.1:${port}`,
        decode: async (name, glb) => parseGlb(glb, name),
        onMesh: (name, mesh) => {
          clearTimeout(timer);
          resolve({ name, mesh });
        },
      });
    });
    server.kill();
    expect(got.name).toBe("Rock");
    expect(Array.from(got.mesh.primitives[0]!.positions)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  }, 20_000);
});
