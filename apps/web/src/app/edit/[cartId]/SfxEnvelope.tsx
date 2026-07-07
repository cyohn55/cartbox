"use client";

/**
 * The volume envelope editor — the hero of the SFX editor. Each of the sample's
 * ticks is a vertical bar (0..15); click or drag to shape the envelope. Mirrors
 * the pixel canvas's interaction model in one dimension.
 */

import { useCallback, useEffect, useRef } from "react";
import type { SoundBank } from "@cartbox/editor";

import styles from "./editor.module.css";

const COL_WIDTH = 18;
const HEIGHT = 240;

interface SfxEnvelopeProps {
  bank: SoundBank;
  sample: number;
  loop: { start: number; size: number };
  version: number;
  onEdit: () => void;
  onHover: (cell: { tick: number; level: number } | null) => void;
}

export function SfxEnvelope({ bank, sample, loop, version, onEdit, onHover }: SfxEnvelopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painting = useRef(false);
  const width = bank.ticks * COL_WIDTH;

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

    for (let tick = 0; tick < bank.ticks; tick += 1) {
      const level = bank.getVolume(sample, tick);
      const x = tick * COL_WIDTH;
      // Empty column: a faint baseline slab so the grid stays legible.
      context.fillStyle = "rgba(255,255,255,0.04)";
      context.fillRect(x + 1, 0, COL_WIDTH - 2, HEIGHT);
      if (level > 0) {
        const barHeight = (level / bank.maxValue) * HEIGHT;
        context.fillStyle = `rgba(246,183,74,${0.4 + 0.6 * (level / bank.maxValue)})`;
        context.fillRect(x + 1, HEIGHT - barHeight, COL_WIDTH - 2, barHeight);
      }
    }

    // Loop region marker along the bottom (green), when a loop is set.
    if (loop.size > 0) {
      context.fillStyle = "rgba(87,209,141,0.95)";
      context.fillRect(loop.start * COL_WIDTH, HEIGHT - 3, loop.size * COL_WIDTH, 3);
    }
  }, [bank, sample, loop, width]);

  useEffect(() => {
    draw();
  }, [draw, version]);

  const cellFromEvent = (event: React.PointerEvent): { tick: number; level: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const tick = Math.floor(((event.clientX - rect.left) / rect.width) * bank.ticks);
    const level = Math.round((1 - (event.clientY - rect.top) / rect.height) * bank.maxValue);
    if (tick < 0 || tick >= bank.ticks) return null;
    return { tick, level: Math.max(0, Math.min(bank.maxValue, level)) };
  };

  const apply = (cell: { tick: number; level: number }) => {
    bank.setVolume(sample, cell.tick, cell.level);
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
    const cell = cellFromEvent(event);
    onHover(cell);
    if (painting.current && cell) apply(cell);
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
        onPointerLeave={() => onHover(null)}
        role="img"
        aria-label={`SFX ${sample} volume envelope`}
      />
    </div>
  );
}
