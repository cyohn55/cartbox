"use client";

/**
 * The asset check and package export in the Mesh tab (AAA_FIDELITY_ROADMAP.md
 * F9e): what assetValidation.ts finds (texel density, names, budgets, missing
 * maps and tangents), and the mesh as a binary package (cartPackage.ts), its
 * geometry squeezed with meshoptimizer, to download or upload.
 */

import { useMemo, useState } from "react";

import { packMeshAsset, validateMeshAsset, type MeshAsset, type MeshoptCodec } from "@cartbox/editor";

import { RailGroup, RailHint } from "./railControls";

/** meshoptimizer's codecs, loaded the first time a package is made. */
async function loadMeshopt(): Promise<MeshoptCodec | null> {
  try {
    const { MeshoptEncoder, MeshoptDecoder } = await import("meshoptimizer");
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;
    return {
      encodeVertexBuffer: (s, c, z) => MeshoptEncoder.encodeVertexBuffer(s, c, z),
      encodeIndexBuffer: (s, c, z) => MeshoptEncoder.encodeIndexBuffer(s, c, z),
      decodeVertexBuffer: (t, c, z, s) => MeshoptDecoder.decodeVertexBuffer(t, c, z, s),
      decodeIndexBuffer: (t, c, z, s) => MeshoptDecoder.decodeIndexBuffer(t, c, z, s),
    };
  } catch {
    return null;
  }
}

export function AssetCheckPanel({ mesh }: { mesh: MeshAsset }) {
  const [density, setDensity] = useState(512);
  const [note, setNote] = useState<string | null>(null);
  const issues = useMemo(() => validateMeshAsset(mesh, { texelDensity: density }), [mesh, density]);
  const exportPackage = async () => {
    const codec = await loadMeshopt();
    const bytes = packMeshAsset(mesh, codec);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.cartbox.package" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${mesh.name || "mesh"}.cbpk`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNote(`Packaged ${(bytes.byteLength / 1024).toFixed(0)} KB${codec ? ", geometry squeezed with meshopt" : ""}.`);
  };
  return (
    <RailGroup label="Asset check">
      <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
        Texel density aim
        <select aria-label="Texel density aim" value={density} onChange={(e) => setDensity(Number(e.target.value))}>
          {[128, 256, 512, 1024, 2048].map((d) => (
            <option key={d} value={d}>
              {d} px/m
            </option>
          ))}
        </select>
      </label>
      {issues.length === 0 ? (
        <RailHint>No problems found.</RailHint>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }} aria-label="Asset issues">
          {issues.map((issue, i) => (
            <li key={i} style={{ color: issue.severity === "error" ? "var(--danger, #c33)" : undefined }}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => void exportPackage()}>
        Download package (.cbpk)
      </button>
      {note && <RailHint>{note}</RailHint>}
    </RailGroup>
  );
}
