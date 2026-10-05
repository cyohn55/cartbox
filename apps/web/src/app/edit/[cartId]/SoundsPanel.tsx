"use client";

/**
 * Sound in the Mesh tab (ENGINE_PARITY_ROADMAP.md EP12): the scene's sounds —
 * imported files, synth presets, spoken lines — each on a bus, positional or
 * everywhere; the mixer's bus levels; and emitters that loop from the start.
 * The cart plays them with cartbox.sound / cartbox.loop and mixes with
 * cartbox.mix. See sound.ts in @cartbox/editor and soundEdit.ts.
 */

import { useRef, useState } from "react";

import { SYNTH_PRESETS, type SynthPreset } from "@cartbox/editor";

import { type MeshSidecar } from "@/lib/meshSidecar";
import { addEmitter, addFileSound, addSpeechSound, addSynthSound, audioOf, removeEmitter, removeSound, setBusVolume, updateEmitter, updateSound } from "@/lib/soundEdit";
import { fileToBase64, previewSound } from "@/lib/soundPreview";
import { RailGroup, RailHint, RangeControl } from "./railControls";

export function SoundsPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const audio = audioOf(sidecar);
  const fileRef = useRef<HTMLInputElement>(null);
  const [preset, setPreset] = useState<SynthPreset>("rifle");
  const [line, setLine] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busVolume = (name: string) => audio.buses.find((b) => b.name === name)?.volume ?? 1;

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const mime = file.type || (/\.ogg$/i.test(file.name) ? "audio/ogg" : /\.mp3$/i.test(file.name) ? "audio/mpeg" : /\.wav$/i.test(file.name) ? "audio/wav" : "");
    const made = addFileSound(sidecar, file.name.replace(/\.[^.]+$/, ""), mime, await fileToBase64(file));
    setError(made ? null : "That isn't an audio file this can keep (Ogg, MP3 or WAV, up to 2 MB).");
    if (made) {
      onChange(made.sidecar);
      setOpen(made.name);
    }
  };

  return (
    <RailGroup label="Sound" collapsible defaultOpen={audio.sounds.length > 0}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {audio.sounds.map((sound) => (
          <div key={sound.name} style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: 6 }}>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <button type="button" className="cbx-btn" aria-label={`Play ${sound.name}`} onClick={() => void previewSound(sound, busVolume(sound.bus))} title="Hear it">
                ▶
              </button>
              <button type="button" className="cbx-btn" style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }} onClick={() => setOpen(open === sound.name ? null : sound.name)} aria-expanded={open === sound.name}>
                {sound.name}
                <span style={{ opacity: 0.55, fontSize: 11 }}> · {sound.source.kind === "synth" ? (typeof sound.source.synth === "string" ? sound.source.synth : "synth") : sound.source.kind === "speech" ? "voice" : "file"}</span>
              </button>
            </div>
            {open === sound.name && (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                <input aria-label="Sound name" defaultValue={sound.name} onBlur={(event) => event.target.value && event.target.value !== sound.name && onChange(updateSound(sidecar, sound.name, { name: event.target.value }))} />
                {sound.source.kind === "speech" && (
                  <input aria-label="Line spoken" defaultValue={sound.source.text} onBlur={(event) => event.target.value.trim() && onChange(updateSound(sidecar, sound.name, { source: { ...(sound.source as { kind: "speech"; text: string }), text: event.target.value.trim() } }))} />
                )}
                <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                  Bus
                  <select value={sound.bus} onChange={(event) => onChange(updateSound(sidecar, sound.name, { bus: event.target.value }))} style={{ flex: 1 }}>
                    {audio.buses.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
                <RangeControl label="Volume" nested min={0} max={2} step={0.05} value={sound.volume} onChange={(volume) => onChange(updateSound(sidecar, sound.name, { volume }))} ariaLabel={`${sound.name} volume`} display={`${Math.round(sound.volume * 100)}%`} />
                {sound.source.kind !== "speech" && (
                  <>
                    <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={Boolean(sound.range)} onChange={(event) => onChange(updateSound(sidecar, sound.name, { range: event.target.checked ? [4, 60] : undefined }))} />
                      3D: pans and fades with distance
                    </label>
                    {sound.range && (
                      <RangeControl label="Heard up to" nested min={5} max={300} step={5} value={sound.range[1]} onChange={(far) => onChange(updateSound(sidecar, sound.name, { range: [Math.min(sound.range![0], far), far] }))} ariaLabel={`${sound.name} range`} display={`${sound.range[1]} m`} />
                    )}
                    <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={Boolean(sound.loop)} onChange={(event) => onChange(updateSound(sidecar, sound.name, { loop: event.target.checked || undefined }))} />
                      Loops
                    </label>
                  </>
                )}
                <button type="button" className="cbx-btn" onClick={() => onChange(removeSound(sidecar, sound.name))}>
                  Remove
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
        <select aria-label="Synth sound" value={preset} onChange={(event) => setPreset(event.target.value as SynthPreset)} style={{ flex: 1, minWidth: 0 }}>
          {(Object.keys(SYNTH_PRESETS) as SynthPreset[]).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button type="button" className="cbx-btn" onClick={() => onChange(addSynthSound(sidecar, preset).sidecar)} title="A synthesised sound: costs a few bytes, made when the scene loads">
          Add synth
        </button>
      </div>
      <form
        style={{ display: "flex", gap: 4, marginTop: 4 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!line.trim()) return;
          onChange(addSpeechSound(sidecar, line).sidecar);
          setLine("");
        }}
      >
        <input aria-label="Spoken line" placeholder="Double kill!" value={line} onChange={(event) => setLine(event.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <button type="submit" className="cbx-btn" title="A line the browser's voice reads out (an announcer)">
          Add voice
        </button>
      </form>
      <button type="button" className="cbx-btn" style={{ marginTop: 4 }} onClick={() => fileRef.current?.click()}>
        Import sound file…
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".ogg,.mp3,.wav,audio/*"
        hidden
        onChange={(event) => {
          void importFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {error && <RailHint>{error}</RailHint>}

      {audio.sounds.length > 0 && (
        <>
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 10 }}>Mixer</div>
          {audio.buses.map((bus) => (
            <RangeControl key={bus.name} label={bus.name} nested min={0} max={2} step={0.05} value={bus.volume} onChange={(v) => onChange(setBusVolume(sidecar, bus.name, v))} ariaLabel={`${bus.name} bus volume`} display={`${Math.round(bus.volume * 100)}%`} />
          ))}

          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 10 }}>Ambience — loops from the start</div>
          {audio.emitters.map((emitter, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: 6, marginTop: 4 }}>
              <select aria-label="Emitter sound" value={emitter.sound} onChange={(event) => onChange(updateEmitter(sidecar, i, { sound: event.target.value }))}>
                {audio.sounds.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select aria-label="Emitter object" value={emitter.object ?? ""} onChange={(event) => onChange(updateEmitter(sidecar, i, { object: event.target.value || undefined }))}>
                <option value="">Everywhere</option>
                {sidecar.meshes.map((m) => (
                  <option key={m.id} value={m.id}>
                    On {m.name}
                  </option>
                ))}
              </select>
              <RangeControl label="Volume" nested min={0} max={2} step={0.05} value={emitter.volume} onChange={(volume) => onChange(updateEmitter(sidecar, i, { volume }))} ariaLabel="Emitter volume" display={`${Math.round(emitter.volume * 100)}%`} />
              <button type="button" className="cbx-btn" onClick={() => onChange(removeEmitter(sidecar, i))}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="cbx-btn" style={{ marginTop: 4 }} onClick={() => onChange(addEmitter(sidecar, { sound: (audio.sounds.find((s) => s.loop) ?? audio.sounds[0]!).name, volume: 1 }))}>
            Add ambience
          </button>
          <RailHint>In code: cartbox.sound(&quot;{audio.sounds[0]!.name}&quot;, x, y, z) plays a sound there (no position: everywhere); cartbox.loop(slot, name, volume, x, y, z) keeps one looping; cartbox.mix(&quot;sfx&quot;, 0.5) sets a bus.</RailHint>
        </>
      )}
    </RailGroup>
  );
}
