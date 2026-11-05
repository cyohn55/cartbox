"use client";

/**
 * The audio track in the Mesh tab (AAA_PRODUCTION_ROADMAP.md U1–U5), beside the
 * Sounds panel: the mixer's routing, ducking and snapshots (U3), reverb zones
 * (U1), occlusion (U2), music tracks (U4), and each sound's variation and
 * streaming (U5). The cart drives them with cartbox.snapshot, music, layer,
 * stinger and switch.
 */

import { useState } from "react";

import { sabineDecay, type ReverbZone, type SoundVariation } from "@cartbox/editor";

import { type MeshSidecar } from "@/lib/meshSidecar";
import { audioOf, saveSnapshot, setAudioTrack, updateBus, updateSound } from "@/lib/soundEdit";
import { RailGroup, RailHint } from "./railControls";

const row = { fontSize: 12, display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" } as const;
const box = { border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: 6, display: "flex", flexDirection: "column", gap: 4 } as const;
const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);
const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

export function AudioTrackPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const audio = audioOf(sidecar);
  const [sound, setSound] = useState<string>("");
  if (!sidecar.audio) return null;
  const busNames = audio.buses.map((b) => b.name);
  const zones = audio.reverbZones ?? [];
  const setZone = (i: number, patch: Partial<ReverbZone>) => onChange(setAudioTrack(sidecar, { reverbZones: zones.map((z, k) => (k === i ? { ...z, ...patch } : z)) }));
  const selected = audio.sounds.find((s) => s.name === sound);
  const variation: SoundVariation = selected?.variation ?? { variants: [], choose: "random", pitch: 0, volume: 0 };
  const setVariation = (patch: Partial<SoundVariation>) => selected && onChange(updateSound(sidecar, selected.name, { variation: { ...variation, ...patch } }));
  return (
    <RailGroup label="Audio track" collapsible defaultOpen={false}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={box}>
          <strong style={{ fontSize: 12 }}>Mixer</strong>
          {audio.buses.map((b) => (
            <div key={b.name} style={row}>
              <span style={{ width: 60 }}>{b.name}</span>
              <select aria-label={`${b.name} into`} value={b.parent ?? ""} onChange={(e) => onChange(updateBus(sidecar, b.name, { parent: e.target.value || undefined }))}>
                <option value="">→ master</option>
                {busNames.filter((n) => n !== b.name).map((n) => (
                  <option key={n} value={n}>
                    → {n}
                  </option>
                ))}
              </select>
              <select aria-label={`${b.name} ducked by`} value={b.duck?.by ?? ""} onChange={(e) => onChange(updateBus(sidecar, b.name, { duck: e.target.value ? { by: e.target.value, amount: b.duck?.amount ?? 0.35, attack: b.duck?.attack ?? 0.08, release: b.duck?.release ?? 0.6 } : undefined }))}>
                <option value="">no duck</option>
                {busNames.filter((n) => n !== b.name).map((n) => (
                  <option key={n} value={n}>
                    ducked by {n}
                  </option>
                ))}
              </select>
              {b.duck && <input aria-label={`${b.name} duck to`} type="number" step={0.05} min={0} max={1} value={b.duck.amount} onChange={(e) => onChange(updateBus(sidecar, b.name, { duck: { ...b.duck!, amount: num(e.target.value, 0.35) } }))} style={{ width: 50 }} />}
            </div>
          ))}
          <div style={row}>
            Snapshots: {(audio.snapshots ?? []).map((s) => s.name).join(", ") || "none"}
            <button type="button" className="cbx-btn" onClick={() => { const name = window.prompt("Save the buses' volumes now as snapshot:")?.trim(); if (name) onChange(saveSnapshot(sidecar, name)); }}>
              + Snapshot
            </button>
          </div>
          <label style={row}>
            Limiter dB
            <input type="number" step={0.5} max={0} min={-24} value={audio.limiter ?? -1} onChange={(e) => onChange(setAudioTrack(sidecar, { limiter: num(e.target.value, -1) }))} style={{ width: 60 }} />
          </label>
        </div>

        <div style={box}>
          <strong style={{ fontSize: 12 }}>Reverb zones</strong>
          {zones.map((z, i) => (
            <div key={i} style={row}>
              <span style={{ width: 60 }}>{z.name}</span>
              {(["min", "max"] as const).map((k) => (
                <input key={k} aria-label={`${z.name} ${k}`} defaultValue={z[k].join(", ")} onBlur={(e) => { const v = list(e.target.value).map(Number); if (v.length === 3 && v.every(Number.isFinite)) setZone(i, { [k]: v as unknown as ReverbZone["min"] }); }} style={{ width: 80 }} />
              ))}
              <label>decay s <input type="number" step={0.1} value={z.decay} onChange={(e) => setZone(i, { decay: num(e.target.value, z.decay) })} style={{ width: 46 }} /></label>
              <label>wet <input type="number" step={0.05} value={z.wet} onChange={(e) => setZone(i, { wet: num(e.target.value, z.wet) })} style={{ width: 46 }} /></label>
              <button type="button" className="cbx-btn" title="Its decay from its size, for hard walls (Sabine)" onClick={() => setZone(i, { decay: +sabineDecay([z.max[0] - z.min[0], z.max[1] - z.min[1], z.max[2] - z.min[2]], 0.05 + 0.5 * z.damping).toFixed(2) })}>
                from size
              </button>
              <button type="button" className="cbx-btn" aria-label={`Remove ${z.name}`} onClick={() => onChange(setAudioTrack(sidecar, { reverbZones: zones.filter((_, k) => k !== i) }))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="cbx-btn" onClick={() => onChange(setAudioTrack(sidecar, { reverbZones: [...zones, { name: `zone${zones.length + 1}`, min: [-10, 0, -10], max: [10, 6, 10], decay: 1.5, damping: 0.5, wet: 0.4, fade: 2 }] }))}>
            + Zone
          </button>
          <label style={row}>
            <input type="checkbox" checked={Boolean(audio.occlusion)} onChange={(e) => onChange(setAudioTrack(sidecar, { occlusion: e.target.checked ? { strength: 1, smoothing: 0.15 } : undefined }))} />
            Occlusion: walls between the camera and a positional sound muffle it
          </label>
        </div>

        <div style={box}>
          <strong style={{ fontSize: 12 }}>Music</strong>
          {(audio.music ?? []).map((t, i) => (
            <div key={t.name} style={row}>
              <span style={{ width: 60 }}>{t.name}</span>
              <label>bpm <input type="number" value={t.bpm} onChange={(e) => onChange(setAudioTrack(sidecar, { music: audio.music!.map((m, k) => (k === i ? { ...m, bpm: num(e.target.value, m.bpm) } : m)) }))} style={{ width: 50 }} /></label>
              <input aria-label={`${t.name} layers`} defaultValue={t.layers.join(", ")} onBlur={(e) => onChange(setAudioTrack(sidecar, { music: audio.music!.map((m, k) => (k === i ? { ...m, layers: list(e.target.value) } : m)) }))} title="Layers: looping sounds, in sync, the first one up" />
              <button type="button" className="cbx-btn" aria-label={`Remove ${t.name}`} onClick={() => onChange(setAudioTrack(sidecar, { music: audio.music!.filter((_, k) => k !== i) }))}>
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="cbx-btn"
            onClick={() => {
              const name = window.prompt("Music track name")?.trim();
              const loops = audio.sounds.filter((s) => s.loop).map((s) => s.name);
              if (name) onChange(setAudioTrack(sidecar, { music: [...(audio.music ?? []), { name, bpm: 120, beats: 4, layers: loops.slice(0, 2) }] }));
            }}
          >
            + Track
          </button>
        </div>

        <div style={box}>
          <strong style={{ fontSize: 12 }}>Variation</strong>
          <select aria-label="Sound to vary" value={sound} onChange={(e) => setSound(e.target.value)}>
            <option value="">Pick a sound…</option>
            {audio.sounds.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          {selected && (
            <>
              <div style={row}>
                <select aria-label="How it picks" value={variation.choose} onChange={(e) => setVariation({ choose: e.target.value as SoundVariation["choose"] })}>
                  <option value="random">random (no repeats)</option>
                  <option value="sequence">in sequence</option>
                  <option value="switch">by a switch</option>
                </select>
                <label>pitch ± <input type="number" step={0.02} value={variation.pitch} onChange={(e) => setVariation({ pitch: num(e.target.value, 0) })} style={{ width: 46 }} /></label>
                <label>volume ± <input type="number" step={0.05} value={variation.volume} onChange={(e) => setVariation({ volume: num(e.target.value, 0) })} style={{ width: 46 }} /></label>
              </div>
              {variation.choose === "switch" ? (
                <>
                  <input aria-label="Switch name" placeholder="switch (e.g. surface)" defaultValue={variation.switchName ?? ""} onBlur={(e) => setVariation({ switchName: e.target.value.trim() || undefined })} />
                  <input
                    aria-label="Cases"
                    placeholder="metal=step_metal, grass=step_grass"
                    defaultValue={Object.entries(variation.cases ?? {}).map(([k, v]) => `${k}=${v}`).join(", ")}
                    onBlur={(e) => setVariation({ cases: Object.fromEntries(list(e.target.value).map((p) => p.split("=").map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1])) })}
                  />
                </>
              ) : (
                <input aria-label="Variants" placeholder="other sounds it may play: a, b" defaultValue={variation.variants.join(", ")} onBlur={(e) => setVariation({ variants: list(e.target.value) })} />
              )}
              {selected.source.kind === "file" && (
                <label style={row}>
                  <input type="checkbox" checked={Boolean(selected.stream)} onChange={(e) => onChange(updateSound(sidecar, selected.name, { stream: e.target.checked || undefined }))} />
                  Stream (long music: played as it loads, not decoded whole)
                </label>
              )}
            </>
          )}
        </div>
        <RailHint>
          In code: <code>cartbox.snapshot(name, seconds)</code>, <code>cartbox.music(track)</code>, <code>cartbox.layer(track, n, on)</code>, <code>cartbox.stinger(sound)</code>, <code>cartbox.switch(name, value)</code>.
        </RailHint>
      </div>
    </RailGroup>
  );
}
