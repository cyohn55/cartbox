"use client";

/**
 * LayeredSceneView — a reusable canvas that composites depth-layered planes
 * under a perspective camera the user drives (drag to pan, slide to yaw,
 * auto-orbit). It owns only the camera; the caller supplies the planes, so the
 * same view serves the Parallax Lab and the sprite-editor rig panel. Preview
 * only: it runs the CPU compositor, nothing touches the cart core.
 */

import { useEffect, useRef, useState } from "react";
import { renderLayeredScene, type Camera, type ScenePlane } from "@cartbox/editor";

interface LayeredSceneViewProps {
  planes: readonly ScenePlane[];
  pivotDepth: number;
  focalLength?: number;
  viewWidth?: number;
  viewHeight?: number;
  displayScale?: number;
  maxYaw?: number;
}

export function LayeredSceneView({
  planes,
  pivotDepth,
  focalLength = 220,
  viewWidth = 240,
  viewHeight = 160,
  displayScale = 3,
  maxYaw = 0.6,
}: LayeredSceneViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [yaw, setYaw] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [orbiting, setOrbiting] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  // Auto-orbit oscillates yaw so the volume reads at a glance.
  useEffect(() => {
    if (!orbiting) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      setYaw(maxYaw * Math.sin((now - start) / 900));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [orbiting, maxYaw]);

  // Recompose whenever the planes or the camera change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const camera: Camera = {
      panX: pan.x,
      panY: pan.y,
      yaw,
      pivotX: 0,
      pivotDepth,
      focalLength,
      viewportWidth: viewWidth,
      viewportHeight: viewHeight,
    };
    const frame = renderLayeredScene(planes, camera);
    const imageData = ctx.createImageData(frame.width, frame.height);
    imageData.data.set(frame.data);
    ctx.putImageData(imageData, 0, 0);
  }, [planes, yaw, pan, pivotDepth, focalLength, viewWidth, viewHeight]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (orbiting) return;
    dragRef.current = { startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const worldPerScreenPixel = 1 / (displayScale * 6);
    setPan({
      x: drag.panX - (event.clientX - drag.startX) * worldPerScreenPixel,
      y: drag.panY - (event.clientY - drag.startY) * worldPerScreenPixel,
    });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const reset = () => {
    setOrbiting(false);
    setYaw(0);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: viewWidth * displayScale }}>
      <canvas
        ref={canvasRef}
        width={viewWidth}
        height={viewHeight}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          width: viewWidth * displayScale,
          height: viewHeight * displayScale,
          imageRendering: "pixelated",
          border: "1px solid #333c57",
          borderRadius: 6,
          touchAction: "none",
          cursor: orbiting ? "default" : "grab",
        }}
      />

      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 40 }}>Yaw</span>
        <input
          type="range"
          min={-maxYaw}
          max={maxYaw}
          step={0.01}
          value={yaw}
          disabled={orbiting}
          onChange={(event) => setYaw(Number(event.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{ width: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{yaw.toFixed(2)}</span>
      </label>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => setOrbiting((value) => !value)}>
          {orbiting ? "Stop orbit" : "Auto-orbit"}
        </button>
        <button type="button" onClick={reset}>
          Reset
        </button>
      </div>
    </div>
  );
}
