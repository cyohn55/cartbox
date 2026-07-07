"use client";

/**
 * Editor for one of the 16 shared custom waveforms — a WAVEFORM_STEPS-step
 * amplitude curve (0..15). Same one-dimensional paint interaction as the SFX
 * volume envelope, drawn in a cooler colour so the two read as different things.
 */

import { useCallback, useEffect, useRef } from "react";
import type { SoundBank } from "@cartbox/editor";

import styles from "./editor.module.css";

const COL_WIDTH = 14;
const HEIGHT = 128;

interface WaveformCurveProps {
  bank: SoundBank;
  waveform: number;
  version: number;
  onEdit: () => void;
}

export function WaveformCurve({ bank, waveform, version, onEdit }: WaveformCurveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painting = useRef(false);
  const width = bank.waveformSteps * COL_WIDTH;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr) {
      canvas.width = width * dpr;
      canvas.height = HEIGHT * dpr;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, HEIGHT);

    for (let step = 0; step < bank.waveformSteps; step += 1) {
      const level = bank.getWaveform(waveform, step);
      const x = step * COL_WIDTH;
      context.fillStyle = "rgba(255,255,255,0.04)";
      context.fillRect(x + 1, 0, COL_WIDTH - 2, HEIGHT);
      const barHeight = ((level + 1) / (bank.waveformMax + 1)) * HEIGHT;
      context.fillStyle = "rgba(115,239,247,0.75)";
      context.fillRect(x + 1, HEIGHT - barHeight, COL_WIDTH - 2, barHeight);
    }
  }, [bank, waveform, width]);

  useEffect(() => {
    draw();
  }, [draw, version]);

  const cellFromEvent = (event: React.PointerEvent): { step: number; level: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const step = Math.floor(((event.clientX - rect.left) / rect.width) * bank.waveformSteps);
    const level = Math.round((1 - (event.clientY - rect.top) / rect.height) * bank.waveformMax);
    if (step < 0 || step >= bank.waveformSteps) return null;
    return { step, level: Math.max(0, Math.min(bank.waveformMax, level)) };
  };

  const apply = (cell: { step: number; level: number }) => {
    bank.setWaveform(waveform, cell.step, cell.level);
    onEdit();
  };

  const handleDown = (event: React.PointerEvent) => {
    const cell = cellFromEvent(event);
    if (!cell) return;
    painting.current = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    apply(cell);
  };

  const handleMove = (event: React.PointerEvent) => {
    if (!painting.current) return;
    const cell = cellFromEvent(event);
    if (cell) apply(cell);
  };

  const stop = () => {
    painting.current = false;
  };

  return (
    <div className={styles.canvasPanel}>
      <canvas
        ref={canvasRef}
        className={styles.sfxCanvas}
        style={{ width, height: HEIGHT }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={stop}
        onPointerCancel={stop}
        role="img"
        aria-label={`Waveform ${waveform}`}
      />
    </div>
  );
}
