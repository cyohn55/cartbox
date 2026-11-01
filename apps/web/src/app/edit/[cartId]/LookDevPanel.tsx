"use client";

/**
 * The look-dev stage in the Mesh tab (AAA_FIDELITY_ROADMAP.md F10c): the mesh
 * on a neutral stage, beside a grey and a chrome ball and a colour checker,
 * under a standard light rig, drawn by the AAA tier's renderer or the
 * path-traced reference (F10b). "Check" draws it both ways and says how far
 * apart they are; "Capture 4K" downloads the reference.
 */

import { useEffect, useRef, useState } from "react";

import type { DecodedTexture, EncodedImage, EnvironmentLight, MeshAsset } from "@cartbox/editor";
import { LOOK_DEV_RIGS, LookDevView, type LookDevCheck, type LookDevRig } from "@cartbox/player";

import { decodeImage } from "@/lib/meshImport";
import { RailGroup, RailHint } from "./railControls";

/** Each primitive's map in one slot, decoded (data maps as stored); null where it has none or it won't decode. */
async function decodeSlot(mesh: MeshAsset, pick: (m: MeshAsset["primitives"][number]["material"]) => EncodedImage | null | undefined, raw: boolean): Promise<(DecodedTexture | null)[]> {
  return Promise.all(
    mesh.primitives.map(async (p) => {
      const image = pick(p.material);
      if (!image || image.bytes.length === 0) return null;
      try {
        return await decodeImage(image.bytes, image.mime, raw);
      } catch {
        return null;
      }
    }),
  );
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function LookDevPanel({ mesh, environment }: { mesh: MeshAsset; environment: EnvironmentLight | null }) {
  const [open, setOpen] = useState(false);
  return (
    <RailGroup label="Look dev">
      <RailHint>The mesh under standard light, beside a grey and a chrome ball and a colour checker, on the AAA renderer or the path-traced reference.</RailHint>
      <button type="button" className="cbx-btn" onClick={() => setOpen(true)}>
        Open look-dev stage
      </button>
      {open && <LookDevStageView mesh={mesh} environment={environment} onClose={() => setOpen(false)} />}
    </RailGroup>
  );
}

function LookDevStageView({ mesh, environment, onClose }: { mesh: MeshAsset; environment: EnvironmentLight | null; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<LookDevView | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [rig, setRig] = useState<LookDevRig>("studio");
  const [mode, setMode] = useState<"raster" | "pathTraced">("raster");
  const [stops, setStops] = useState(0);
  const [spin, setSpin] = useState(true);
  const [samples, setSamples] = useState(0);
  const [check, setCheck] = useState<LookDevCheck | "running" | null>(null);
  const [capturing, setCapturing] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = Math.round(canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1));
    canvas.height = Math.round(canvas.clientHeight * Math.min(2, window.devicePixelRatio || 1));
    let cancelled = false;
    void LookDevView.create(canvas).then((view) => {
      if (cancelled) return view?.destroy();
      if (!view) return setFailed(true);
      viewRef.current = view;
      setReady(true);
    });
    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      decodeSlot(mesh, (m) => m.baseColorImage, false),
      decodeSlot(mesh, (m) => m.metallicRoughnessImage, true),
      decodeSlot(mesh, (m) => m.emissiveImage, false),
      decodeSlot(mesh, (m) => m.normalImage, true),
      decodeSlot(mesh, (m) => m.occlusionImage, true),
    ]).then(([textures, mrTextures, emissiveTextures, normalTextures, occlusionTextures]) => {
      if (!cancelled) viewRef.current?.setAsset(mesh, { textures, mrTextures, emissiveTextures, normalTextures, occlusionTextures });
    });
    // Shown at once without its maps, then with them.
    viewRef.current?.setAsset(mesh);
    return () => {
      cancelled = true;
    };
  }, [mesh, ready]);

  useEffect(() => {
    viewRef.current?.setOptions({ rig, mode, stops, spin: spin ? 0.4 : 0, environment });
    setCheck(null);
  }, [rig, mode, stops, spin, environment, ready]);

  useEffect(() => {
    if (mode !== "pathTraced") return;
    const timer = setInterval(() => setSamples(viewRef.current?.samples ?? 0), 500);
    return () => clearInterval(timer);
  }, [mode]);

  const runCheck = () => {
    const view = viewRef.current;
    if (!view) return;
    setCheck("running");
    void view.check().then(setCheck, () => setCheck(null));
  };

  const capture = () => {
    const view = viewRef.current;
    if (!view) return;
    setCapturing(0);
    void view
      .capture(3840, 256, (done) => setCapturing(done))
      .then((shot) => {
        const canvas = document.createElement("canvas");
        canvas.width = shot.width;
        canvas.height = shot.height;
        canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(shot.rgba), shot.width, shot.height), 0, 0);
        canvas.toBlob((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${mesh.name || "mesh"}-lookdev-${rig}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, "image/png");
      })
      .finally(() => setCapturing(null));
  };

  return (
    <div role="dialog" aria-label="Look-dev stage" style={{ position: "fixed", inset: 24, zIndex: 50, background: "#0c0c0e", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 12px 48px rgba(0,0,0,0.6)" }}>
      <div style={{ display: "flex", gap: 8, padding: 10, alignItems: "center", flexWrap: "wrap", color: "#ddd", fontSize: 12 }}>
        <strong style={{ marginRight: 8 }}>Look dev: {mesh.name || "mesh"}</strong>
        <select aria-label="Light rig" value={rig} onChange={(e) => setRig(e.target.value as LookDevRig)}>
          {LOOK_DEV_RIGS.map((r) => (
            <option key={r.id} value={r.id} title={r.hint} disabled={r.id === "hdri" && !environment}>
              Rig: {r.label}
            </option>
          ))}
        </select>
        <select aria-label="Renderer" value={mode} onChange={(e) => setMode(e.target.value as "raster" | "pathTraced")}>
          <option value="raster">AAA renderer</option>
          <option value="pathTraced">Path-traced reference</option>
        </select>
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
          Exposure
          <input type="range" min={-4} max={4} step={0.5} value={stops} onChange={(e) => setStops(Number(e.target.value))} aria-label="Exposure in stops" />
          {stops > 0 ? "+" : ""}
          {stops} EV
        </label>
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={spin} onChange={(e) => setSpin(e.target.checked)} /> Turntable
        </label>
        {mode === "pathTraced" && <span>{samples} spp</span>}
        <button type="button" className="cbx-btn" onClick={runCheck} disabled={failed || check === "running"} title="Draw the stage with the renderer and the reference and compare them">
          {check === "running" ? "Checking…" : "Check"}
        </button>
        <button type="button" className="cbx-btn" onClick={capture} disabled={failed || capturing !== null} title="Render the reference at 4K (256 samples a pixel) and download it">
          {capturing === null ? "Capture 4K" : `Capturing ${Math.round(capturing * 100)}%`}
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="cbx-btn" onClick={onClose}>
          Close
        </button>
      </div>
      {check && check !== "running" && (
        <div aria-label="Look-dev check" style={{ padding: "0 10px 8px", color: "#ccc", fontSize: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>Frame: renderer and reference {pct(check.frameError)} apart on average, {pct(check.outliers)} of pixels over 10%.</span>
          {check.greyBall && (
            <span>
              Grey ball: {check.greyBall.raster.toFixed(3)} / {check.greyBall.reference.toFixed(3)} ({pct(Math.abs(check.greyBall.raster - check.greyBall.reference) / Math.max(1e-4, check.greyBall.reference))})
            </span>
          )}
          {check.chromeBall && (
            <span>
              Chrome ball: {check.chromeBall.raster.toFixed(3)} / {check.chromeBall.reference.toFixed(3)}
            </span>
          )}
        </div>
      )}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
        {failed && <p style={{ position: "absolute", inset: 0, margin: "auto", height: 20, textAlign: "center", color: "#ccc" }}>The look-dev stage needs WebGPU (the AAA tier's renderer).</p>}
      </div>
    </div>
  );
}
