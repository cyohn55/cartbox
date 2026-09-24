/**
 * A shared-mesh library for the mesh sidecar.
 *
 * A sidecar stores each placed instance's geometry as a serialized mesh string,
 * so a scene that places the same model several times — seven identical
 * soldiers, say — used to store it seven times over. The library fixes that at
 * the storage layer only: {@link packMeshLibrary} moves every mesh string that
 * appears more than once (and every animation frame) into a top-level `library`
 * keyed by a short id, leaving `"@lib:<key>"` references in its place, and
 * {@link resolveMeshRef} turns a reference back into the full string. Readers
 * resolve on load, so everything above storage keeps seeing whole meshes.
 *
 * Pure and DOM-free: the editor's sidecar codec and the runtime share it.
 */

/** Prefix marking a sidecar mesh field as a reference into the library. */
export const MESH_LIBRARY_REF = "@lib:";

/** A sidecar's shared meshes: key → serialized mesh string. */
export type MeshLibrary = Readonly<Record<string, string>>;

/** One sidecar entry's mesh-bearing fields (anything else passes through untouched). */
export interface MeshBearingEntry {
  readonly mesh: string;
  /** Optional animation frames: alternate meshes a pose can select by number. */
  readonly frames?: readonly string[];
}

/** Read a library defensively: only string values survive. */
export function readMeshLibrary(value: unknown): MeshLibrary {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, mesh] of Object.entries(value as Record<string, unknown>)) {
    if (typeof mesh === "string") out[key] = mesh;
  }
  return out;
}

/**
 * Resolve a stored mesh field: a `"@lib:<key>"` reference becomes the library's
 * string (null when the key is missing — the caller drops the entry); any other
 * string is returned as-is (a mesh stored inline).
 */
export function resolveMeshRef(value: string, library: MeshLibrary): string | null {
  if (!value.startsWith(MESH_LIBRARY_REF)) return value;
  return library[value.slice(MESH_LIBRARY_REF.length)] ?? null;
}

/** Resolve an entry's optional frame list, dropping any that fail to resolve. */
export function resolveMeshFrames(value: unknown, library: MeshLibrary): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const frame of value) {
    if (typeof frame !== "string") continue;
    const resolved = resolveMeshRef(frame, library);
    if (resolved) out.push(resolved);
  }
  return out;
}

/**
 * Pack entries for storage: every mesh string used more than once across all
 * entries' `mesh` and `frames` — plus every frame, which is shared by nature —
 * goes into the library once and is replaced by a reference. Returns the packed
 * entries (other fields kept) and the library, which is empty when nothing
 * repeats, so a plain scene stores exactly as before.
 */
export function packMeshLibrary<T extends MeshBearingEntry>(
  entries: readonly T[],
): { entries: T[]; library: Record<string, string> } {
  const uses = new Map<string, number>();
  const count = (mesh: string, weight = 1) => uses.set(mesh, (uses.get(mesh) ?? 0) + weight);
  for (const entry of entries) {
    count(entry.mesh);
    for (const frame of entry.frames ?? []) count(frame, 2);
  }
  const library: Record<string, string> = {};
  const keys = new Map<string, string>();
  const ref = (mesh: string): string => {
    if ((uses.get(mesh) ?? 0) < 2) return mesh;
    let key = keys.get(mesh);
    if (!key) {
      key = `m${keys.size}`;
      keys.set(mesh, key);
      library[key] = mesh;
    }
    return MESH_LIBRARY_REF + key;
  };
  const packed = entries.map((entry) => ({
    ...entry,
    mesh: ref(entry.mesh),
    ...(entry.frames && entry.frames.length > 0 ? { frames: entry.frames.map(ref) } : {}),
  }));
  return { entries: packed, library };
}
