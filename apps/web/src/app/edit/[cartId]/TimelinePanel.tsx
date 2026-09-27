"use client";

/**
 * The Mesh tab's timeline editor (ENGINE_ROADMAP.md, Phase 3): cutscenes and
 * scripted camera moves. Pick or make a timeline, scrub it (previewing in the
 * Scene view), key the camera from the current Scene view, key objects'
 * transforms, cue animation clips / states, and name events for the cart. The
 * cart plays it with cartbox.playtimeline (or it autoplays).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  TIMELINE_EASES,
  TIMELINE_LIMITS,
  composeModelMatrix,
  newTimeline,
  sampleCamera,
  sampleObjects,
  type CameraKey,
  type Mat4,
  type SceneTimeline,
  type TimelineEase,
  type TimelineTrack,
  type TransformKey,
} from "@cartbox/editor";

import { readMeshEntry, setMeshTimelines, type MeshSidecar } from "@/lib/meshSidecar";
import styles from "./editor.module.css";
import { RailGroup, RailHint } from "./railControls";
import type { ViewpointKey } from "./SceneViewport";

const input: React.CSSProperties = { width: "100%", minWidth: 0, padding: "3px 5px", borderRadius: 6, fontSize: 12 };
const row: React.CSSProperties = { display: "flex", gap: 4, alignItems: "center", fontSize: 12 };
const card: React.CSSProperties = { display: "grid", gap: 4, padding: 6, borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)" };
const sub: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.7, marginTop: 8 };
const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

type CameraTrack = Extract<TimelineTrack, { kind: "camera" }>;
type ObjectTrack = Extract<TimelineTrack, { kind: "object" }>;
type AnimTrack = Extract<TimelineTrack, { kind: "animation" }>;
type EventTrack = Extract<TimelineTrack, { kind: "events" }>;

export interface TimelinePreview {
  readonly camera: ViewpointKey | null;
  readonly locals: ReadonlyMap<string, Mat4>;
}

function Num({ label, value, step = 0.1, width = 56, onChange }: { label: string; value: number; step?: number; width?: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      step={step}
      aria-label={label}
      value={fmt(value)}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
      style={{ ...input, width, flex: "none" }}
    />
  );
}

function Remove({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={styles.toolBtn} aria-label={label} onClick={onClick} style={{ padding: "2px 6px", flex: "none" }}>
      ×
    </button>
  );
}

function EaseSelect({ value, onChange }: { value: TimelineEase; onChange: (e: TimelineEase) => void }) {
  return (
    <select aria-label="Ease into the next key" value={value} onChange={(e) => onChange(e.target.value as TimelineEase)} style={{ ...input, width: 70, flex: "none" }}>
      {TIMELINE_EASES.map((e) => (
        <option key={e} value={e}>
          {e}
        </option>
      ))}
    </select>
  );
}

export function TimelinePanel({
  sidecar,
  onChange,
  view,
  onPreview,
}: {
  sidecar: MeshSidecar;
  onChange: (next: MeshSidecar) => void;
  /** The Scene view's current viewpoint (for keying the camera), if known. */
  view: ViewpointKey | null;
  /** Preview a moment of the timeline in the Scene view (null to stop). */
  onPreview: (preview: TimelinePreview | null) => void;
}) {
  const timelines = sidecar.timelines ?? [];
  const [selected, setSelected] = useState(0);
  const [time, setTime] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const tl = timelines[Math.min(selected, timelines.length - 1)] ?? null;
  const index = tl ? timelines.indexOf(tl) : -1;

  const save = (next: readonly SceneTimeline[]) => onChange(setMeshTimelines(sidecar, next));
  const update = (patch: Partial<SceneTimeline>) => tl && save(timelines.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  const setTracks = (tracks: TimelineTrack[]) => update({ tracks });
  const tracks = tl?.tracks ?? [];
  const replaceTrack = (track: TimelineTrack, next: TimelineTrack) => setTracks(tracks.map((t) => (t === track ? next : t)));

  // Objects that can be animated, and each skinned one's clip and state names (for cues).
  const objects = sidecar.meshes.map((m) => ({ id: m.id, name: m.name }));
  const nameOf = (id: string) => sidecar.meshes.find((m) => m.id === id)?.name ?? "(removed object)";
  const cueNames = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const m of sidecar.meshes) {
      try {
        const clips = (readMeshEntry(m).clips ?? []).map((c) => c.name);
        const states = (m.animator?.states ?? []).map((s) => s.name);
        if (clips.length > 0) out.set(m.id, [...new Set([...states, ...clips])]);
      } catch {
        // an unreadable entry just offers no cues
      }
    }
    return out;
  }, [sidecar.meshes]);

  // Preview: sample the timeline at the scrub time into the Scene view.
  useEffect(() => {
    if (!previewing || !tl) {
      onPreview(null);
      return;
    }
    const cam = sampleCamera(tl, time);
    const locals = new Map<string, Mat4>();
    for (const [id, t] of sampleObjects(tl, time)) locals.set(id, composeModelMatrix(t.position, t.rotation, t.scale));
    onPreview({ camera: cam, locals });
  }, [previewing, tl, time, onPreview]);
  useEffect(() => () => onPreview(null), [onPreview]);

  // Play the preview in real time.
  const start = useRef(0);
  useEffect(() => {
    if (!playing || !tl) return;
    let raf = 0;
    start.current = performance.now() - time * 1000;
    const tick = (now: number) => {
      const t = (now - start.current) / 1000;
      if (t >= tl.duration) {
        setTime(tl.duration);
        setPlaying(false);
        return;
      }
      setTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  if (!tl) {
    return (
      <RailGroup label="Timelines" advanced>
        <button type="button" className={styles.toolBtn} onClick={() => save([newTimeline("intro")])}>
          New timeline
        </button>
        <RailHint>Cutscenes and camera moves: key the camera from the Scene view, move objects, cue animations. The cart plays one with cartbox.playtimeline(name).</RailHint>
      </RailGroup>
    );
  }

  const camTrack = tracks.find((t): t is CameraTrack => t.kind === "camera");
  const keyCamera = () => {
    if (!view) return;
    const key: CameraKey = { time, eye: view.eye, target: view.target, fov: view.fov, ease: "smooth" };
    if (!camTrack) setTracks([{ kind: "camera", keys: [key] }, ...tracks]);
    else replaceTrack(camTrack, { kind: "camera", keys: [...camTrack.keys.filter((k) => Math.abs(k.time - time) > 1e-3), key] });
  };
  const eventTrack = tracks.find((t): t is EventTrack => t.kind === "events");
  const unique = (base: string) => {
    const taken = timelines.map((t) => t.name);
    if (!taken.includes(base)) return base;
    for (let n = 2; ; n += 1) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
  };

  return (
    <RailGroup label="Timelines">
      <div style={row}>
        <select aria-label="Timeline" value={index} onChange={(e) => setSelected(Number(e.target.value))} style={input}>
          {timelines.map((t, i) => (
            <option key={t.name} value={i}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.toolBtn}
          disabled={timelines.length >= TIMELINE_LIMITS.timelines}
          onClick={() => {
            save([...timelines, newTimeline(unique("scene"))]);
            setSelected(timelines.length);
          }}
          style={{ flex: "none", fontSize: 12 }}
        >
          + New
        </button>
        <Remove
          label={`Delete timeline ${tl.name}`}
          onClick={() => {
            save(timelines.filter((_, i) => i !== index));
            setSelected(0);
          }}
        />
      </div>
      <div style={row}>
        <span style={{ flex: "none" }}>Name</span>
        <input
          aria-label="Timeline name"
          defaultValue={tl.name}
          key={tl.name}
          onBlur={(e) => {
            const n = e.target.value.trim();
            if (n && n !== tl.name && !timelines.some((t) => t.name === n)) update({ name: n });
            else e.target.value = tl.name;
          }}
          style={input}
        />
      </div>
      <div style={row}>
        <span style={{ flex: "none" }}>Length s</span>
        <Num label="Timeline length" value={tl.duration} step={0.5} onChange={(v) => update({ duration: Math.max(0.05, v) })} />
        <label style={row}>
          <input type="checkbox" aria-label="Loop timeline" checked={tl.loop} onChange={(e) => update({ loop: e.target.checked })} />
          loop
        </label>
      </div>
      <div style={row}>
        <label style={row}>
          <input type="checkbox" aria-label="Autoplay" checked={tl.autoplay} onChange={(e) => update({ autoplay: e.target.checked })} />
          play when the game starts
        </label>
      </div>
      <div style={row}>
        <label style={row}>
          <input type="checkbox" aria-label="Hold last frame" checked={tl.hold} onChange={(e) => update({ hold: e.target.checked })} />
          hold the last frame
        </label>
      </div>

      <div style={sub}>Scrub and preview</div>
      <input
        type="range"
        aria-label="Timeline time"
        min={0}
        max={tl.duration}
        step={0.01}
        value={Math.min(time, tl.duration)}
        onChange={(e) => {
          setPlaying(false);
          setTime(Number(e.target.value));
        }}
      />
      <div style={row}>
        <span style={{ minWidth: 48 }}>{fmt(Math.min(time, tl.duration))} s</span>
        <label style={row}>
          <input type="checkbox" aria-label="Preview in the Scene view" checked={previewing} onChange={(e) => setPreviewing(e.target.checked)} />
          preview
        </label>
        <button
          type="button"
          className={styles.toolBtn}
          style={{ marginLeft: "auto", fontSize: 12 }}
          onClick={() => {
            setPreviewing(true);
            if (time >= tl.duration) setTime(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? "■ Stop" : "▶ Play"}
        </button>
      </div>

      <div style={sub}>Camera</div>
      <button type="button" className={styles.toolBtn} disabled={!view || previewing} onClick={keyCamera} style={{ fontSize: 12 }}>
        Key the Scene view at {fmt(time)} s
      </button>
      {(camTrack?.keys ?? []).map((k, i) => (
        <div key={i} style={row}>
          <Num label="Camera key time" value={k.time} onChange={(v) => replaceTrack(camTrack!, { kind: "camera", keys: camTrack!.keys.map((q, j) => (j === i ? { ...q, time: v } : q)) })} />
          <span style={{ opacity: 0.75, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }} title={`eye ${k.eye.map(fmt).join(", ")} → ${k.target.map(fmt).join(", ")}`}>
            {k.eye.map(fmt).join(",")}
          </span>
          <EaseSelect value={k.ease} onChange={(ease) => replaceTrack(camTrack!, { kind: "camera", keys: camTrack!.keys.map((q, j) => (j === i ? { ...q, ease } : q)) })} />
          <Remove label="Remove camera key" onClick={() => replaceTrack(camTrack!, { kind: "camera", keys: camTrack!.keys.filter((_, j) => j !== i) })} />
        </div>
      ))}
      {!view && <RailHint>Switch to the Scene view to key the camera from it.</RailHint>}

      <div style={sub}>Objects</div>
      {tracks
        .filter((t): t is ObjectTrack => t.kind === "object")
        .map((track, n) => {
          const entry = sidecar.meshes.find((m) => m.id === track.object);
          const keyNow = () => {
            if (!entry) return;
            const t = entry.transform;
            const key: TransformKey = { time, position: t.position, rotation: t.rotation, scale: t.scale, ease: "smooth" };
            replaceTrack(track, { ...track, keys: [...track.keys.filter((k) => Math.abs(k.time - time) > 1e-3), key] });
          };
          return (
            <div key={`${track.object}-${n}`} style={card}>
              <div style={row}>
                <strong style={{ flex: 1 }}>{nameOf(track.object)}</strong>
                <Remove label={`Remove ${nameOf(track.object)} track`} onClick={() => setTracks(tracks.filter((t) => t !== track))} />
              </div>
              <button type="button" className={styles.toolBtn} disabled={!entry} onClick={keyNow} style={{ fontSize: 12 }}>
                Key its current transform at {fmt(time)} s
              </button>
              {track.keys.map((k, i) => (
                <div key={i} style={{ display: "grid", gap: 3 }}>
                  <div style={row}>
                    <Num label="Object key time" value={k.time} onChange={(v) => replaceTrack(track, { ...track, keys: track.keys.map((q, j) => (j === i ? { ...q, time: v } : q)) })} />
                    <EaseSelect value={k.ease} onChange={(ease) => replaceTrack(track, { ...track, keys: track.keys.map((q, j) => (j === i ? { ...q, ease } : q)) })} />
                    <Remove label="Remove object key" onClick={() => replaceTrack(track, { ...track, keys: track.keys.filter((_, j) => j !== i) })} />
                  </div>
                  <div style={row}>
                    <span style={{ width: 24, flex: "none" }}>pos</span>
                    {([0, 1, 2] as const).map((c) => (
                      <Num
                        key={c}
                        label={`Key position ${"xyz"[c]}`}
                        value={k.position[c]}
                        width={50}
                        onChange={(v) =>
                          replaceTrack(track, {
                            ...track,
                            keys: track.keys.map((q, j) => (j === i ? { ...q, position: q.position.map((p, d) => (d === c ? v : p)) as unknown as TransformKey["position"] } : q)),
                          })
                        }
                      />
                    ))}
                  </div>
                  <div style={row}>
                    <span style={{ width: 24, flex: "none" }}>rot</span>
                    {([0, 1, 2] as const).map((c) => (
                      <Num
                        key={c}
                        label={`Key rotation ${"xyz"[c]}`}
                        value={k.rotation[c]}
                        step={5}
                        width={50}
                        onChange={(v) =>
                          replaceTrack(track, {
                            ...track,
                            keys: track.keys.map((q, j) => (j === i ? { ...q, rotation: q.rotation.map((p, d) => (d === c ? v : p)) as unknown as TransformKey["rotation"] } : q)),
                          })
                        }
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      <select
        aria-label="Animate an object"
        value=""
        onChange={(e) => e.target.value && setTracks([...tracks, { kind: "object", object: e.target.value, keys: [] }])}
        style={input}
        disabled={tracks.length >= TIMELINE_LIMITS.tracks}
      >
        <option value="">+ Move an object…</option>
        {objects.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>

      {cueNames.size > 0 && (
        <>
          <div style={sub}>Animation cues</div>
          {tracks
            .filter((t): t is AnimTrack => t.kind === "animation")
            .map((track, n) => (
              <div key={`${track.object}-${n}`} style={card}>
                <div style={row}>
                  <strong style={{ flex: 1 }}>{nameOf(track.object)}</strong>
                  <Remove label={`Remove ${nameOf(track.object)} cues`} onClick={() => setTracks(tracks.filter((t) => t !== track))} />
                </div>
                {track.cues.map((c, i) => (
                  <div key={i} style={row}>
                    <Num label="Cue time" value={c.time} onChange={(v) => replaceTrack(track, { ...track, cues: track.cues.map((q, j) => (j === i ? { ...q, time: v } : q)) })} />
                    <select
                      aria-label="Cue clip or state"
                      value={c.clip}
                      onChange={(e) => replaceTrack(track, { ...track, cues: track.cues.map((q, j) => (j === i ? { ...q, clip: e.target.value } : q)) })}
                      style={input}
                    >
                      {(cueNames.get(track.object) ?? [c.clip]).map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <Remove label="Remove cue" onClick={() => replaceTrack(track, { ...track, cues: track.cues.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                <button
                  type="button"
                  className={styles.toolBtn}
                  style={{ fontSize: 12 }}
                  onClick={() => replaceTrack(track, { ...track, cues: [...track.cues, { time, clip: cueNames.get(track.object)?.[0] ?? "", fade: 0.2, loop: true }] })}
                >
                  + Cue at {fmt(time)} s
                </button>
              </div>
            ))}
          <select
            aria-label="Cue an object's animation"
            value=""
            onChange={(e) => e.target.value && setTracks([...tracks, { kind: "animation", object: e.target.value, cues: [] }])}
            style={input}
          >
            <option value="">+ Cue an animation…</option>
            {[...cueNames.keys()].map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </select>
        </>
      )}

      <div style={sub}>Events</div>
      {(eventTrack?.events ?? []).map((ev, i) => (
        <div key={i} style={row}>
          <Num label="Event time" value={ev.time} onChange={(v) => replaceTrack(eventTrack!, { kind: "events", events: eventTrack!.events.map((q, j) => (j === i ? { ...q, time: v } : q)) })} />
          <input
            aria-label="Event name"
            defaultValue={ev.name}
            key={`${ev.name}-${i}`}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name) replaceTrack(eventTrack!, { kind: "events", events: eventTrack!.events.map((q, j) => (j === i ? { ...q, name } : q)) });
              else e.target.value = ev.name;
            }}
            style={input}
          />
          <Remove label={`Remove event ${ev.name}`} onClick={() => replaceTrack(eventTrack!, { kind: "events", events: eventTrack!.events.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <button
        type="button"
        className={styles.toolBtn}
        style={{ fontSize: 12 }}
        onClick={() => {
          const ev = { time, name: "event" };
          if (eventTrack) replaceTrack(eventTrack, { kind: "events", events: [...eventTrack.events, ev] });
          else setTracks([...tracks, { kind: "events", events: [ev] }]);
        }}
      >
        + Event at {fmt(time)} s
      </button>

      <RailHint>
        {`In code: cartbox.playtimeline(${JSON.stringify(tl.name)}), cartbox.timeline() for where it is, cartbox.timelineevents() for its events${tl.autoplay ? " — it also plays by itself when the game starts" : ""}. While it plays it has the camera; when it ends the camera goes back to the game${tl.hold ? " (after you stop it — it holds its last frame)" : ""}.`}
      </RailHint>
    </RailGroup>
  );
}
