"use client";

/**
 * The dope sheet (LOCKOUT_MULTIPLAYER_ROADMAP.md L16), under the preview in
 * pose mode: a row per bone, a diamond per key across the clip's length, and
 * the playhead. Click a track to move the playhead (and pick that bone);
 * click a key to pick it — then change how it eases into the next (the
 * timeline's eases, with its curve editor), retime it by dragging, or delete
 * it. Keys made here are orange; a bone of an imported clip shows its own
 * keys in grey, and keying it starts from them (see dopeSheet.ts).
 */

import { useRef, useState } from "react";

import { TIMELINE_EASES, deleteBoneKey, dopeSheetRows, moveBoneKey, setBoneKeyEase, DEFAULT_EASE_CURVE, type MeshAsset } from "@cartbox/editor";

import styles from "./editor.module.css";
import { CurveEditor } from "./CurveEditor";
import { SegmentedControl } from "./railControls";

const LABEL = 92;
const ROW = 20;

export function DopeSheet({
  mesh,
  clip,
  time,
  onTime,
  joint,
  onJoint,
  onEdit,
}: {
  mesh: MeshAsset;
  clip: number;
  time: number;
  onTime: (time: number) => void;
  joint: number;
  onJoint: (joint: number) => void;
  onEdit: (next: MeshAsset) => void;
}) {
  const [picked, setPicked] = useState<{ joint: number; time: number } | null>(null);
  const [dragging, setDragging] = useState<{ joint: number; from: number; to: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const current = mesh.clips?.[clip];
  if (!current || !mesh.skin) return null;
  const duration = Math.max(1e-3, current.duration);
  const rows = dopeSheetRows(mesh, clip);
  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    // Snapped to the game's 60 Hz ticks.
    return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration * 60) / 60;
  };
  const pct = (t: number) => `${(Math.max(0, Math.min(duration, t)) / duration) * 100}%`;
  const key = picked ? rows[picked.joint]?.keys.find((k) => Math.abs(k.time - picked.time) < 1e-3) : undefined;
  const ticks = Array.from({ length: 5 }, (_, k) => (duration * k) / 4);

  return (
    <div style={{ padding: "8px 12px", borderTop: "1px solid rgba(255,255,255,0.08)", fontSize: 12 }} aria-label="Dope sheet">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <span className={styles.groupLabel}>Dope sheet</span>
        <span className={styles.hudLabel}>
          {current.name} · {duration.toFixed(2)}s · {rows.reduce((n, r) => n + r.keys.length, 0)} keys
        </span>
      </div>
      <div style={{ display: "flex", marginLeft: LABEL, position: "relative", height: 14 }}>
        {ticks.map((t) => (
          <span key={t} className={styles.hudLabel} style={{ position: "absolute", left: pct(t), transform: "translateX(-50%)", fontSize: 10 }}>
            {t.toFixed(2)}
          </span>
        ))}
      </div>
      <div style={{ maxHeight: 220, overflowY: "auto" }}>
        {rows.map((r, i) => (
          <div key={r.joint} style={{ display: "flex", alignItems: "center", height: ROW }}>
            <button
              type="button"
              onClick={() => onJoint(r.joint)}
              style={{ width: LABEL, flex: "none", textAlign: "left", background: "none", border: "none", color: r.joint === joint ? "#ffb03a" : "inherit", cursor: "pointer", padding: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {r.name}
            </button>
            <div
              ref={i === 0 ? trackRef : undefined}
              onPointerDown={(e) => {
                onTime(timeAt(e.clientX));
                onJoint(r.joint);
                setPicked(null);
              }}
              style={{ position: "relative", flex: 1, height: ROW - 4, background: r.joint === joint ? "rgba(255,176,58,0.08)" : "rgba(255,255,255,0.04)", borderRadius: 3, cursor: "pointer" }}
            >
              <div style={{ position: "absolute", left: pct(time), top: -2, bottom: -2, width: 1, background: "#ff5a5a", pointerEvents: "none" }} />
              {r.keys.map((k) => {
                const isPicked = picked?.joint === r.joint && Math.abs(picked.time - k.time) < 1e-3;
                const at = dragging && dragging.joint === r.joint && Math.abs(dragging.from - k.time) < 1e-3 ? dragging.to : k.time;
                return (
                  <span
                    key={k.time}
                    role="button"
                    aria-label={`${r.name} key at ${k.time.toFixed(2)}s (${k.ease})`}
                    title={`${r.name} · ${k.time.toFixed(2)}s · ${k.ease}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setPicked({ joint: r.joint, time: k.time });
                      onJoint(r.joint);
                      setDragging({ joint: r.joint, from: k.time, to: k.time });
                    }}
                    onPointerMove={(e) => {
                      if (dragging && dragging.joint === r.joint && Math.abs(dragging.from - k.time) < 1e-3) setDragging({ ...dragging, to: timeAt(e.clientX) });
                    }}
                    onPointerUp={() => {
                      if (dragging && Math.abs(dragging.to - dragging.from) > 1e-3) {
                        onEdit(moveBoneKey(mesh, clip, dragging.joint, dragging.from, dragging.to));
                        setPicked({ joint: dragging.joint, time: dragging.to });
                      }
                      setDragging(null);
                    }}
                    style={{
                      position: "absolute",
                      left: pct(at),
                      top: "50%",
                      width: 9,
                      height: 9,
                      transform: "translate(-50%, -50%) rotate(45deg)",
                      background: r.authored ? "#ffb03a" : "#8fa0c0",
                      outline: isPicked ? "2px solid #ffffff" : "none",
                      cursor: "ew-resize",
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {picked && key && (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 8, flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 6 }}>
            <span className={styles.hudLabel}>
              {rows[picked.joint]?.name} at {picked.time.toFixed(2)}s eases into the next key:
            </span>
            <SegmentedControl
              ariaLabel="Key ease"
              selected={key.ease}
              onSelect={(ease) => onEdit(setBoneKeyEase(mesh, clip, picked.joint, picked.time, ease, ease === "curve" ? (key.curve ?? DEFAULT_EASE_CURVE) : undefined))}
              options={TIMELINE_EASES.map((e) => ({ id: e, label: e }))}
            />
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => {
                onEdit(deleteBoneKey(mesh, clip, picked.joint, picked.time));
                setPicked(null);
              }}
            >
              Delete key
            </button>
          </div>
          {key.ease === "curve" && <CurveEditor curve={key.curve ?? DEFAULT_EASE_CURVE} onChange={(curve) => onEdit(setBoneKeyEase(mesh, clip, picked.joint, picked.time, "curve", curve))} />}
        </div>
      )}
    </div>
  );
}
