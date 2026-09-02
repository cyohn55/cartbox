"use client";

/**
 * The envelope editor — the hero of the SFX editor. Each of the sample's ticks
 * is a vertical bar; click or drag to shape it. Mirrors the pixel canvas's
 * interaction model in one dimension.
 *
 * It drew the volume envelope and only the volume envelope, which is why three
 * of a sample's four channels were unreachable. It now draws whichever channel
 * it is given, including the one that runs negative: pitch is -8..7, so the bar
 * grows up or down from a centre line rather than up from the floor.
 */

import { useCallback, useEffect, useRef } from "react";
import type { SfxChannelName, SoundBank } from "@cartbox/editor";

import styles from "./editor.module.css";

const COL_WIDTH = 18;
const HEIGHT = 200;

/** Each channel's bar colour, so four stacked envelopes stay tellable apart. */
const CHANNEL_INK: Record<SfxChannelName, string> = {
  volume: "246,183,74",
  wave: "120,180,255",
  chord: "150,220,150",
  pitch: "224,140,200",
};

interface SfxEnvelopeProps {
  bank: SoundBank;
  sample: number;
  channel: SfxChannelName;
  min: number;
  max: number;
  loop: { start: number; size: number };
  version: number;
  /** Tick the playhead is on during a preview, or null when not playing. */
  playhead?: number | null;
  onEdit: () => void;
  onHover: (cell: { tick: number; level: number } | null) => void;
}

export function SfxEnvelope({
  bank,
  sample,
  channel,
  min,
  max,
  loop,
  version,
  playhead,
  onEdit,
  onHover,
}: SfxEnvelopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painting = useRef(false);
  const width = bank.ticks * COL_WIDTH;
  const span = max - min;
  // Where the value `0` sits vertically. For a signed channel that is the
  // middle of the canvas; for an unsigned one it is the floor.
  const zeroY = HEIGHT * (max / span);

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

    const ink = CHANNEL_INK[channel];
    for (let tick = 0; tick < bank.ticks; tick += 1) {
      const value = bank.envelopeValue(sample, channel, tick);
      const x = tick * COL_WIDTH;
      // Empty column: a faint baseline slab so the grid stays legible.
      context.fillStyle = "rgba(255,255,255,0.04)";
      context.fillRect(x + 1, 0, COL_WIDTH - 2, HEIGHT);
      if (value !== 0) {
        const magnitude = (Math.abs(value) / span) * HEIGHT;
        const top = value > 0 ? zeroY - magnitude : zeroY;
        context.fillStyle = `rgba(${ink},${0.4 + 0.6 * (Math.abs(value) / Math.max(1, Math.max(Math.abs(min), max)))})`;
        context.fillRect(x + 1, top, COL_WIDTH - 2, Math.max(2, magnitude));
      }
    }

    // The zero line, for a channel that runs both ways.
    if (min < 0) {
      context.fillStyle = "rgba(255,255,255,0.22)";
      context.fillRect(0, zeroY - 0.5, width, 1);
    }

    // Loop region marker along the bottom (green), when a loop is set.
    if (loop.size > 0) {
      context.fillStyle = "rgba(87,209,141,0.95)";
      context.fillRect(loop.start * COL_WIDTH, HEIGHT - 3, loop.size * COL_WIDTH, 3);
    }

    // The playhead, so a creator can see which tick they are hearing.
    if (playhead !== null && playhead !== undefined && playhead >= 0 && playhead < bank.ticks) {
      context.fillStyle = "rgba(255,255,255,0.85)";
      context.fillRect(playhead * COL_WIDTH, 0, 2, HEIGHT);
    }
  }, [bank, channel, sample, loop, min, max, span, width, zeroY, playhead]);

  useEffect(() => {
    draw();
  }, [draw, version]);

  const cellFromEvent = (event: React.PointerEvent): { tick: number; level: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const tick = Math.floor(((event.clientX - rect.left) / rect.width) * bank.ticks);
    const fraction = 1 - (event.clientY - rect.top) / rect.height;
    const level = Math.round(min + fraction * span);
    if (tick < 0 || tick >= bank.ticks) return null;
    return { tick, level: Math.max(min, Math.min(max, level)) };
  };

  const apply = (cell: { tick: number; level: number }) => {
    bank.setEnvelope(sample, channel, cell.tick, cell.level);
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
        aria-label={`SFX ${sample} ${channel} envelope`}
      />
    </div>
  );
}
