"use client";

/**
 * The DCC live link in the Mesh tab (AAA_PRODUCTION_ROADMAP.md D6): connect
 * to the Blender add-on running on this machine, and each object it pushes
 * lands in the scene (in place of the object of its name, or added).
 */

import { useEffect, useRef, useState } from "react";

import { connectLiveLink, applyLiveMesh, LIVE_LINK_PORT, type LinkStatus } from "@/lib/liveLink";
import { importMeshFile } from "@/lib/meshImport";
import { type MeshSidecar } from "@/lib/meshSidecar";
import { RailGroup, RailHint } from "./railControls";

export function LiveLinkPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const [status, setStatus] = useState<LinkStatus>("closed");
  const [note, setNote] = useState<string | null>(null);
  const link = useRef<{ close(): void } | null>(null);
  // The latest scene, so a push lands on what's there now, not what was there when the link opened.
  const latest = useRef(sidecar);
  latest.current = sidecar;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  useEffect(() => () => link.current?.close(), []);

  const connect = () => {
    link.current?.close();
    link.current = connectLiveLink({
      decode: (name, glb) => importMeshFile(new File([glb as BlobPart], `${name}.glb`, { type: "model/gltf-binary" })),
      onMesh: (name, mesh) => {
        const out = applyLiveMesh(latest.current, name, mesh);
        changeRef.current(out.sidecar);
        setNote(`${out.action === "replaced" ? "Updated" : "Added"} “${name}” from Blender.`);
      },
      onStatus: (s, detail) => {
        setStatus(s);
        if (detail) setNote(detail);
      },
    });
  };

  return (
    <RailGroup label="Live link (Blender)" collapsible defaultOpen={false}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {status === "closed" ? (
            <button type="button" className="cbx-btn" onClick={connect}>
              Connect
            </button>
          ) : (
            <button type="button" className="cbx-btn" onClick={() => link.current?.close()}>
              Disconnect
            </button>
          )}
          <span>{status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Not connected"}</span>
        </div>
        {note && <span>{note}</span>}
        <RailHint>
          Install tools/blender/cartbox_live_link.py in Blender, press Start link in its Cartbox sidebar, then Connect here. Push selection sends each selected object (port {LIVE_LINK_PORT}).
        </RailHint>
      </div>
    </RailGroup>
  );
}
