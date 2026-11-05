/**
 * The DCC live link (AAA_PRODUCTION_ROADMAP.md D6): Blender pushes its
 * selection to an open editor tab, which puts it in the scene.
 *
 * The add-on (tools/blender/cartbox_live_link.py) runs a WebSocket server on
 * this machine (a browser can connect out, not listen). The editor connects to
 * it and, for each `{ type: "mesh", name, data }` (a GLB, base64), imports the
 * model the way the Import button does: in place of the object of that name
 * when the scene has one (keeping its place, props and copies), else as a new
 * object.
 */

import { encodeMeshSidecar, type MeshSidecar } from "./meshSidecar";
import { addImportedMesh } from "./meshSidecar";
import { replaceModel } from "./meshReplace";
import type { MeshAsset } from "@cartbox/editor";

export const LIVE_LINK_PORT = 9877;
export const LIVE_LINK_URL = `ws://127.0.0.1:${LIVE_LINK_PORT}`;

/** A model from the link in the scene: replacing the object of its name, or added. */
export function applyLiveMesh(sidecar: MeshSidecar, name: string, mesh: MeshAsset): { sidecar: MeshSidecar; action: "replaced" | "added"; id: string } {
  const existing = sidecar.meshes.find((m) => m.name === name);
  if (existing) return { sidecar: replaceModel(sidecar, existing.id, { ...mesh, name }).sidecar, action: "replaced", id: existing.id };
  const added = addImportedMesh(sidecar, { ...mesh, name });
  return { sidecar: { ...added.sidecar, meshes: added.sidecar.meshes.map((m) => (m.id === added.id ? { ...m, name } : m)) }, action: "added", id: added.id };
}

/** The slice of a WebSocket the link uses. */
export interface LinkSocket {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type LinkStatus = "connecting" | "connected" | "closed";

/**
 * Connect to the add-on. `decode` turns a GLB into a model (importMeshFile in
 * the editor); `onMesh` gets each one with its Blender object's name.
 */
export function connectLiveLink(options: {
  url?: string;
  socket?: (url: string) => LinkSocket;
  decode: (name: string, glb: Uint8Array) => Promise<MeshAsset>;
  onMesh: (name: string, mesh: MeshAsset) => void;
  onStatus?: (status: LinkStatus, detail?: string) => void;
}): { close(): void } {
  const make = options.socket ?? ((url: string) => new WebSocket(url) as unknown as LinkSocket);
  const socket = make(options.url ?? LIVE_LINK_URL);
  options.onStatus?.("connecting");
  socket.onopen = () => {
    options.onStatus?.("connected");
    socket.send(JSON.stringify({ type: "hello", client: "cartbox-editor" }));
  };
  socket.onclose = () => options.onStatus?.("closed");
  socket.onerror = () => options.onStatus?.("closed", "No live link here: is the Blender add-on running?");
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    let message: { type?: unknown; name?: unknown; data?: unknown };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type !== "mesh" || typeof message.name !== "string" || typeof message.data !== "string") return;
    const name = message.name.slice(0, 64) || "Blender object";
    const glb = Uint8Array.from(atob(message.data), (c) => c.charCodeAt(0));
    void options
      .decode(name, glb)
      .then((mesh) => options.onMesh(name, mesh))
      .catch((error) => options.onStatus?.("connected", `“${name}” didn't import: ${error instanceof Error ? error.message : String(error)}`));
  };
  return { close: () => socket.close() };
}

/** For tests and the panel: a sidecar's size after a push, as stored. */
export function storedSize(sidecar: MeshSidecar): number {
  return encodeMeshSidecar(sidecar)?.length ?? 0;
}
