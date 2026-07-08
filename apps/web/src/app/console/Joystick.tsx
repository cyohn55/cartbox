"use client";

/**
 * Virtual joystick: drag the knob, and the stick presses/releases the four
 * directional controls on the input bus (8-way — diagonals hold two). From
 * the rest of the system's point of view it is indistinguishable from the
 * D-pad, so games and UI navigation both just work.
 */

import { useRef, useState, type PointerEvent } from "react";

import type { ConsoleControl, ConsoleInputBus } from "./consoleInput";

/** Fraction of the base radius the knob must travel before a direction engages. */
const ENGAGE_THRESHOLD = 0.35;

type Direction = Extract<ConsoleControl, "up" | "down" | "left" | "right">;

interface StickVector {
  x: number;
  y: number;
}

/** Which directions a knob offset (in [-1, 1] units) holds down. */
export function directionsForVector(vector: StickVector): Set<Direction> {
  const held = new Set<Direction>();
  if (vector.y < -ENGAGE_THRESHOLD) held.add("up");
  if (vector.y > ENGAGE_THRESHOLD) held.add("down");
  if (vector.x < -ENGAGE_THRESHOLD) held.add("left");
  if (vector.x > ENGAGE_THRESHOLD) held.add("right");
  return held;
}

export function Joystick({ bus }: { bus: ConsoleInputBus }) {
  const baseRef = useRef<HTMLDivElement>(null);
  const heldRef = useRef<Set<Direction>>(new Set());
  const [knob, setKnob] = useState<StickVector>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const applyVector = (vector: StickVector) => {
    setKnob(vector);
    const next = directionsForVector(vector);
    for (const direction of heldRef.current) {
      if (!next.has(direction)) {
        bus.release(direction);
      }
    }
    for (const direction of next) {
      if (!heldRef.current.has(direction)) {
        bus.press(direction);
      }
    }
    heldRef.current = next;
  };

  const vectorFromPointer = (event: PointerEvent): StickVector => {
    const base = baseRef.current!.getBoundingClientRect();
    const radius = base.width / 2;
    const x = (event.clientX - (base.left + radius)) / radius;
    const y = (event.clientY - (base.top + radius)) / radius;
    const length = Math.hypot(x, y);
    return length > 1 ? { x: x / length, y: y / length } : { x, y };
  };

  const start = (event: PointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* programmatic pointers have no capture; dragging still works */
    }
    setDragging(true);
    applyVector(vectorFromPointer(event));
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging) {
      applyVector(vectorFromPointer(event));
    }
  };

  const end = () => {
    setDragging(false);
    applyVector({ x: 0, y: 0 });
  };

  return (
    <div
      ref={baseRef}
      className="hh-joystick"
      role="application"
      aria-label="Joystick"
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="hh-joystick-knob"
        style={{ transform: `translate(${knob.x * 26}px, ${knob.y * 26}px)` }}
      />
    </div>
  );
}
