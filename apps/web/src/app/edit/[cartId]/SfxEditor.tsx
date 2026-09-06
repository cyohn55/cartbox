"use client";

/**
 * SFX editor: owns the sound editing state (selected sample, envelope channel,
 * preview note) and lays out the waveform rail, the envelope stage, and the
 * sample picker. Shares the cart's SoundBank with the rest of the workbench, so
 * edits serialise into the same .tic that Run and Publish use.
 *
 * Two things it could not do before. It can now **play the sound** — the whole
 * point of a sound editor, and previously only possible by pressing Run and
 * triggering the sample inside the game — and it can edit all four of a
 * sample's envelopes rather than just its volume.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  renderSfx,
  SFX_CHANNEL,
  SFX_CHANNEL_INFO,
  SFX_TICK_HZ,
  NOTE_NAMES,
  type SfxChannelName,
  type SoundBank,
} from "@cartbox/editor";

import styles from "./editor.module.css";
import { SfxEnvelope } from "./SfxEnvelope";
import { WaveformCurve } from "./WaveformCurve";
import { useAudioPreview } from "./useAudioPreview";
import { useShortcuts } from "./shortcuts";

const WAVEFORMS = Array.from({ length: 16 }, (_unused, index) => index);
/** Which loop channel each envelope's loop steppers edit. */
const LOOP_CHANNEL: Record<SfxChannelName, number> = SFX_CHANNEL;

interface SfxEditorProps {
  bank: SoundBank;
  /** Changes when the cart underneath is replaced (bank switch, undo). */
  revision: string;
}

export function SfxEditor({ bank, revision }: SfxEditorProps) {
  const [sample, setSample] = useState(0);
  const [channel, setChannel] = useState<SfxChannelName>("volume");
  const [wave, setWave] = useState(() => bank.getWave(0, 0));
  const [version, setVersion] = useState(0);
  const [hover, setHover] = useState<{ tick: number; level: number } | null>(null);
  // The note a preview plays at. C-4 is where a sound designer's ear expects a
  // sample to sit; a laser tuned at C-0 tells you nothing.
  const [note, setNote] = useState(0);
  const [octave, setOctave] = useState(4);
  const [playhead, setPlayhead] = useState<number | null>(null);

  const preview = useAudioPreview();
  const bump = () => setVersion((current) => current + 1);

  // The cart underneath was replaced — an undo, or a bank switch — so every
  // value read from it is stale. Re-reading beats being remounted: the sample
  // and channel a creator was working on survive.
  useEffect(() => {
    setWave(bank.getWave(sample, 0));
    setVersion((current) => current + 1);
    // Only on revision: this is a resync, not a reaction to local edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const selectSample = (next: number) => {
    setSample(next);
    setWave(bank.getWave(next, 0));
  };

  const chooseWave = (next: number) => {
    bank.setWaveAll(sample, next);
    setWave(next);
    bump();
  };

  const info = SFX_CHANNEL_INFO.find((entry) => entry.id === channel) ?? SFX_CHANNEL_INFO[0]!;
  const loop = bank.getLoop(sample, LOOP_CHANNEL[channel]);
  const setLoopStart = (value: number) => {
    bank.setLoopStart(sample, LOOP_CHANNEL[channel], Math.max(0, Math.min(15, value)));
    bump();
  };
  const setLoopSize = (value: number) => {
    bank.setLoopSize(sample, LOOP_CHANNEL[channel], Math.max(0, Math.min(15, value)));
    bump();
  };

  // ---- preview ------------------------------------------------------------

  const playSample = useCallback(() => {
    if (preview.playing) {
      preview.stop();
      setPlayhead(null);
      return;
    }
    preview.play((sampleRate) => renderSfx({ ...bank.renderSpec(sample), note, octave, sampleRate }));
  }, [bank, note, octave, preview, sample]);

  // Walk a playhead across the envelope while a preview sounds, so the creator
  // can see which tick they are hearing. Driven by the clock rather than the
  // audio graph: it only has to be close, and a timer costs nothing.
  useEffect(() => {
    if (!preview.playing) {
      setPlayhead(null);
      return undefined;
    }
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const tick = Math.floor(((performance.now() - startedAt) / 1000) * SFX_TICK_HZ);
      setPlayhead(tick < bank.ticks ? tick : null);
    }, 1000 / SFX_TICK_HZ);
    return () => window.clearInterval(timer);
  }, [bank.ticks, preview.playing]);

  // Stop a sound that is still ringing when the creator moves to another sample.
  useEffect(() => {
    preview.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample]);

  const shortcuts = useMemo(
    () => [[{ key: " ", label: "Play the sound", group: "Tools" as const }, playSample] as const],
    [playSample],
  );
  useShortcuts(shortcuts);

  return (
    <div className={styles.body}>
      <aside className={styles.rail}>
        <div>
          <div className={styles.groupLabel}>Preview</div>
          <button
            type="button"
            className="cbx-btn cbx-btn-accent"
            onClick={playSample}
            disabled={!preview.supported}
            title={preview.supported ? "Play this sample (Space)" : "This browser has no Web Audio"}
          >
            {preview.playing ? "■ Stop" : "▶ Play"}
          </button>
          <div className={styles.stepper} style={{ marginTop: 8 }}>
            <span className={styles.hudLabel}>Note</span>
            <select
              className={styles.langSelect}
              value={note}
              onChange={(event) => setNote(Number(event.target.value))}
              aria-label="Preview note"
            >
              {NOTE_NAMES.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.stepper} style={{ marginTop: 6 }}>
            <span className={styles.hudLabel}>Octave</span>
            <button type="button" className="cbx-btn" onClick={() => setOctave((value) => Math.max(0, value - 1))}>
              −
            </button>
            <span className={`${styles.stepperValue} data`}>{octave}</span>
            <button type="button" className="cbx-btn" onClick={() => setOctave((value) => Math.min(7, value + 1))}>
              +
            </button>
          </div>
        </div>

        <div>
          <div className={styles.groupLabel}>Envelope</div>
          <div className={styles.toolGroup}>
            {SFX_CHANNEL_INFO.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`${styles.toolBtn} ${channel === entry.id ? styles.toolBtnActive : ""}`}
                onClick={() => setChannel(entry.id)}
                aria-pressed={channel === entry.id}
                title={entry.hint}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className={styles.groupLabel}>Base waveform</div>
          <div className={styles.waveGrid}>
            {WAVEFORMS.map((index) => (
              <button
                key={index}
                type="button"
                className={`${styles.waveBtn} data ${wave === index ? styles.waveBtnActive : ""}`}
                onClick={() => chooseWave(index)}
                aria-pressed={wave === index}
                title={`Set every tick to waveform ${index.toString(16).toUpperCase()}`}
              >
                {index.toString(16).toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className={styles.groupLabel}>{info.label} loop</div>
          <div className={styles.stepper}>
            <span className={styles.hudLabel}>Start</span>
            <button type="button" className="cbx-btn" onClick={() => setLoopStart(loop.start - 1)}>
              −
            </button>
            <span className={`${styles.stepperValue} data`}>{loop.start.toString(16).toUpperCase()}</span>
            <button type="button" className="cbx-btn" onClick={() => setLoopStart(loop.start + 1)}>
              +
            </button>
          </div>
          <div className={styles.stepper} style={{ marginTop: 6 }}>
            <span className={styles.hudLabel}>Size</span>
            <button type="button" className="cbx-btn" onClick={() => setLoopSize(loop.size - 1)}>
              −
            </button>
            <span className={`${styles.stepperValue} data`}>{loop.size.toString(16).toUpperCase()}</span>
            <button type="button" className="cbx-btn" onClick={() => setLoopSize(loop.size + 1)}>
              +
            </button>
          </div>
        </div>
      </aside>

      <section className={styles.sfxStage}>
        <div className={styles.stageBlock}>
          <span className={styles.stageCaption}>{info.label} envelope</span>
          <SfxEnvelope
            bank={bank}
            sample={sample}
            channel={channel}
            min={info.min}
            max={info.max}
            loop={loop}
            version={version}
            playhead={playhead}
            onEdit={bump}
            onHover={setHover}
          />
        </div>
        <div className={styles.stageBlock}>
          <span className={styles.stageCaption}>
            Waveform <span className="data">{wave.toString(16).toUpperCase()}</span>
          </span>
          <WaveformCurve bank={bank} waveform={wave} version={version} onEdit={bump} />
        </div>
        <div className={styles.hud}>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Sample</span>
            <span className={`${styles.hudValue} data`}>#{sample.toString().padStart(2, "0")}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Tick</span>
            <span className={`${styles.hudValue} data`}>{hover ? hover.tick : "—"}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>{info.label}</span>
            <span className={`${styles.hudValue} data`}>{hover ? hover.level : "—"}</span>
          </span>
        </div>
        <p className={styles.inspectorHint}>{info.hint}</p>
      </section>

      <aside className={styles.inspector}>
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>Samples</span>
          <span className={`${styles.panelMeta} data`}>#{sample.toString().padStart(2, "0")}</span>
        </div>
        <div className={styles.sampleGrid}>
          {Array.from({ length: bank.sampleCount }, (_unused, index) => (
            <button
              key={index}
              type="button"
              className={`${styles.sampleCell} data ${index === sample ? styles.sampleCellActive : ""} ${
                bank.isSilent(index) ? styles.sampleCellSilent : ""
              }`}
              onClick={() => selectSample(index)}
              aria-pressed={index === sample}
              title={`Sample ${index}`}
            >
              {index.toString(16).toUpperCase().padStart(2, "0")}
            </button>
          ))}
        </div>
        <p className={styles.inspectorHint}>
          Press <span className="data">Space</span> to hear the selected sample. The preview is the editor&rsquo;s
          own synthesis of these envelopes — press Run to hear the cart&rsquo;s real mixer.
        </p>
      </aside>
    </div>
  );
}
