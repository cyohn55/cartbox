"use client";

/**
 * SFX editor: owns the sound editing state (selected sample, base waveform) and
 * lays out the waveform rail, the volume-envelope stage, and the sample picker.
 * Shares the cart's SoundBank with the rest of the workbench, so edits serialise
 * into the same .tic that Run and Publish use.
 */

import { useState } from "react";
import { SFX_CHANNEL, type SoundBank } from "@cartbox/editor";

import styles from "./editor.module.css";
import { SfxEnvelope } from "./SfxEnvelope";
import { WaveformCurve } from "./WaveformCurve";

const WAVEFORMS = Array.from({ length: 16 }, (_unused, index) => index);

interface SfxEditorProps {
  bank: SoundBank;
}

export function SfxEditor({ bank }: SfxEditorProps) {
  const [sample, setSample] = useState(0);
  const [wave, setWave] = useState(() => bank.getWave(0, 0));
  const [version, setVersion] = useState(0);
  const [hover, setHover] = useState<{ tick: number; level: number } | null>(null);

  const bump = () => setVersion((current) => current + 1);

  const selectSample = (next: number) => {
    setSample(next);
    setWave(bank.getWave(next, 0));
  };

  const chooseWave = (next: number) => {
    bank.setWaveAll(sample, next);
    setWave(next);
    bump();
  };

  // The volume envelope's loop; the rail's Loop steppers edit it in place.
  const loop = bank.getLoop(sample, SFX_CHANNEL.volume);
  const setLoopStart = (value: number) => {
    bank.setLoopStart(sample, SFX_CHANNEL.volume, Math.max(0, Math.min(15, value)));
    bump();
  };
  const setLoopSize = (value: number) => {
    bank.setLoopSize(sample, SFX_CHANNEL.volume, Math.max(0, Math.min(15, value)));
    bump();
  };

  return (
    <div className={styles.body}>
      <aside className={styles.rail}>
        <div>
          <div className={styles.groupLabel}>Waveform</div>
          <div className={styles.waveGrid}>
            {WAVEFORMS.map((index) => (
              <button
                key={index}
                type="button"
                className={`${styles.waveBtn} data ${wave === index ? styles.waveBtnActive : ""}`}
                onClick={() => chooseWave(index)}
                aria-pressed={wave === index}
              >
                {index.toString(16).toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className={styles.groupLabel}>Volume loop</div>
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
          <span className={styles.stageCaption}>Volume envelope</span>
          <SfxEnvelope bank={bank} sample={sample} loop={loop} version={version} onEdit={bump} onHover={setHover} />
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
            <span className={styles.hudLabel}>Level</span>
            <span className={`${styles.hudValue} data`}>{hover ? hover.level : "—"}</span>
          </span>
        </div>
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
      </aside>
    </div>
  );
}
