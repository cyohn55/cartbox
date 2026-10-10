"use client";

/**
 * Rigging in the Mesh tab (LOCKOUT_MULTIPLAYER_ROADMAP.md L16): the Pose
 * panel (the clip being keyed, the playhead, the picked bone's angles, and
 * keying a bone or the whole pose with an ease) and the Weights panel (the
 * bone being painted, the brush, and normalising everything). The preview
 * draws the skeleton or the heat map; poseMode.ts, weightPaint.ts and
 * dopeSheet.ts in @cartbox/editor hold the logic.
 */

import { useState } from "react";

import {
  TIMELINE_EASES,
  WEIGHT_PAINT_MODES,
  jointPose,
  keyBone,
  keyPose,
  newClip,
  normaliseWeights,
  posedJoints,
  quatFromEuler,
  quatToEuler,
  withJointPose,
  type EaseCurve,
  type MeshAsset,
  type TimelineEase,
  type WeightPaintMode,
} from "@cartbox/editor";

import styles from "./editor.module.css";
import { CurveEditor } from "./CurveEditor";
import { RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";

const field: React.CSSProperties = { width: "100%", minWidth: 0, padding: "4px 6px", borderRadius: 6 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, marginBottom: 6 };
const DEG = 180 / Math.PI;

function BoneSelect({ mesh, joint, onJoint, label }: { mesh: MeshAsset; joint: number; onJoint: (j: number) => void; label: string }) {
  return (
    <select aria-label={label} value={joint} onChange={(e) => onJoint(Number(e.target.value))} style={{ ...field, marginBottom: 6 }}>
      {(mesh.skin?.joints ?? []).map((j, k) => (
        <option key={`${j.name}-${k}`} value={k}>
          {j.name}
        </option>
      ))}
    </select>
  );
}

export interface PosePanelProps {
  mesh: MeshAsset;
  clip: number;
  onClip: (clip: number) => void;
  time: number;
  onTime: (time: number) => void;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  joint: number;
  onJoint: (joint: number) => void;
  /** The pose shown: the clip's at the playhead, or as edited. */
  pose: Float32Array;
  /** Whether the pose has been edited away from the clip. */
  edited: boolean;
  onPose: (pose: Float32Array | null) => void;
  /** The mesh with a key (or a new clip) added. */
  onEdit: (next: MeshAsset) => void;
}

export function PosePanel({ mesh, clip, onClip, time, onTime, playing, onPlaying, joint, onJoint, pose, edited, onPose, onEdit }: PosePanelProps) {
  const [ease, setEase] = useState<{ ease: TimelineEase; curve: EaseCurve }>({ ease: "smooth", curve: [0.42, 0, 0.58, 1] });
  const [draft, setDraft] = useState({ name: "taunt", duration: 1.6 });
  const skin = mesh.skin;
  const clips = mesh.clips ?? [];
  const current = clips[clip];
  if (!skin) return null;
  const euler = quatToEuler(jointPose(pose, joint).rotation).map((v) => Math.round(v * DEG * 10) / 10);
  const keyEase = ease.ease === "curve" ? { ease: ease.ease, curve: ease.curve } : { ease: ease.ease };
  const changed = current ? posedJoints(skin, current, time, pose) : [];
  return (
    <RailGroup label="Pose">
      <div style={row}>
        <select aria-label="Clip to key" value={clip} onChange={(e) => onClip(Number(e.target.value))} style={field}>
          {clips.map((c, i) => (
            <option key={`${c.name}-${i}`} value={i}>
              {c.name} ({c.duration.toFixed(2)}s)
            </option>
          ))}
        </select>
      </div>
      <div style={row}>
        <input aria-label="New clip name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={field} />
        <input aria-label="New clip length" type="number" step={0.1} min={0.1} value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: Number(e.target.value) || 1 })} style={{ ...field, width: 60, flex: "none" }} />
        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => {
            const made = newClip(mesh, draft.name, draft.duration);
            if (made.index < 0) return;
            onEdit(made.mesh);
            onClip(made.index);
            onTime(0);
          }}
        >
          New clip
        </button>
      </div>
      {current && (
        <div style={row}>
          <button type="button" className={styles.toolBtn} aria-pressed={playing} onClick={() => onPlaying(!playing)} style={{ flex: "none" }}>
            {playing ? "■" : "▶"}
          </button>
          <input
            type="range"
            aria-label="Playhead"
            min={0}
            max={current.duration}
            step={1 / 60}
            value={Math.min(time, current.duration)}
            onChange={(e) => onTime(Number(e.target.value))}
            style={{ flex: 1, minWidth: 0 }}
          />
          <span className={styles.hudLabel} style={{ width: 40, textAlign: "right" }}>
            {time.toFixed(2)}s
          </span>
        </div>
      )}
      <BoneSelect mesh={mesh} joint={joint} onJoint={onJoint} label="Bone" />
      <div style={row}>
        {[0, 1, 2].map((k) => (
          <input
            key={k}
            type="number"
            step={5}
            value={euler[k]}
            aria-label={`Bone angle ${"XYZ"[k]}°`}
            title={`About the bone's own ${"XYZ"[k]} axis, degrees`}
            onChange={(e) => {
              const next = [...euler];
              next[k] = Number(e.target.value) || 0;
              onPose(withJointPose(pose, joint, { rotation: quatFromEuler(next.map((v) => v / DEG)) }));
            }}
            style={field}
          />
        ))}
      </div>
      <div className={styles.toolGroup}>
        <button type="button" className={styles.toolBtn} onClick={() => onPose(withJointPose(pose, joint, { rotation: [...skin.joints[joint]!.rotation] }))}>
          Reset bone
        </button>
        <button type="button" className={styles.toolBtn} disabled={!edited} onClick={() => onPose(null)} title="Back to the clip's pose at the playhead">
          Revert pose
        </button>
      </div>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Key at {time.toFixed(2)}s</div>
      <SegmentedControl ariaLabel="Ease of new keys" selected={ease.ease} onSelect={(e) => setEase({ ...ease, ease: e })} options={TIMELINE_EASES.map((e) => ({ id: e, label: e }))} />
      {ease.ease === "curve" && <CurveEditor curve={ease.curve} onChange={(curve) => setEase({ ...ease, curve })} />}
      <div className={styles.toolGroup} style={{ marginTop: 6 }}>
        <button
          type="button"
          className={styles.toolBtn}
          disabled={!current}
          onClick={() => {
            onEdit(keyBone(mesh, clip, joint, time, jointPose(pose, joint), keyEase));
            onPose(null);
          }}
        >
          Key bone
        </button>
        <button
          type="button"
          className={styles.toolBtn}
          disabled={!current}
          title={changed.length > 0 ? `Key the ${changed.length} bone${changed.length === 1 ? "" : "s"} you moved` : "Key every bone as it stands"}
          onClick={() => {
            onEdit(keyPose(mesh, clip, time, pose, changed.length > 0 ? changed : skin.joints.map((_, j) => j), keyEase));
            onPose(null);
          }}
        >
          Key pose{changed.length > 0 ? ` (${changed.length})` : ""}
        </button>
      </div>
      <RailHint>
        Click a bone in the preview to pick it, and drag the gizmo&apos;s handles to turn it about that axis; right-drag orbits. Keys ease into the next
        as chosen, and the clip plays in the game exactly as the animator plays any clip.
      </RailHint>
    </RailGroup>
  );
}

export interface BrushSettings {
  readonly mode: WeightPaintMode;
  readonly radius: number;
  readonly strength: number;
}

export function WeightPaintPanel({
  mesh,
  joint,
  onJoint,
  brush,
  onBrush,
  onEdit,
}: {
  mesh: MeshAsset;
  joint: number;
  onJoint: (joint: number) => void;
  brush: BrushSettings;
  onBrush: (brush: BrushSettings) => void;
  onEdit: (next: MeshAsset) => void;
}) {
  return (
    <RailGroup label="Weights">
      <BoneSelect mesh={mesh} joint={joint} onJoint={onJoint} label="Bone to paint" />
      <SegmentedControl ariaLabel="Brush" selected={brush.mode} onSelect={(mode) => onBrush({ ...brush, mode })} options={WEIGHT_PAINT_MODES.map((m) => ({ id: m, label: m }))} />
      <RangeControl label="Radius" min={0.01} max={0.5} step={0.005} value={brush.radius} ariaLabel="Brush radius" display={`${(brush.radius * 100).toFixed(1)} cm`} onChange={(radius) => onBrush({ ...brush, radius })} />
      <RangeControl label="Strength" min={0.02} max={1} step={0.02} value={brush.strength} ariaLabel="Brush strength" display={brush.strength.toFixed(2)} onChange={(strength) => onBrush({ ...brush, strength })} />
      <button type="button" className={styles.toolBtn} onClick={() => onEdit(normaliseWeights(mesh))} title="Every vertex's weights rescaled to sum to 1, slivers dropped">
        Normalise all
      </button>
      <RailHint>
        Paint on the model: blue where the bone carries nothing, through green, to red where it carries everything. Every stroke leaves each vertex&apos;s
        weights summing to 1 (what a bone gains the others give up). Right-drag orbits.
      </RailHint>
    </RailGroup>
  );
}
