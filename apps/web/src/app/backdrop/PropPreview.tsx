"use client";

/**
 * A live 3D preview of one backdrop prop: extrudes its stored pixels into a
 * voxel model (the same core the real backdrop uses) and continuously spins +
 * bobs it, relit by the backdrop's key light. Continuous spin (rather than the
 * prop's occasional-spin cadence) so the author can judge the 3D shape at a
 * glance. Re-extrudes only when the pixels or depth change.
 */

import { useEffect, useRef } from "react";

import { renderVoxelModel, voxelCanvasSize } from "@cartbox/editor";

import { type StoredBackdropProp } from "@/lib/backdropProps";
import { BACKDROP_LIGHT, propToVoxelModel } from "@/lib/retroVoxels";
import styles from "./backdrop.module.css";

const PREVIEW_CELL = 4;
const PITCH = 0.42;
const SPIN_SPEED = 0.8;
const BOB_SPEED = 1.3;

export function PropPreview({ prop }: { prop: StoredBackdropProp }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const model = propToVoxelModel(prop);
    if (!model) return;
    const size = voxelCanvasSize(model, PREVIEW_CELL);
    const bobAmplitude = Math.round(PREVIEW_CELL * 1.2);
    canvas.width = size;
    canvas.height = size + bobAmplitude * 2;

    const tile = document.createElement("canvas");
    tile.width = size;
    tile.height = size;
    const tileContext = tile.getContext("2d");
    if (!tileContext) return;
    const image = tileContext.createImageData(size, size);
    const out = new Uint8ClampedArray(size * size * 4);
    const depthBuffer = new Float32Array(size * size);

    const draw = (yaw: number, bobY: number) => {
      renderVoxelModel(model, { yaw, pitch: PITCH, cell: PREVIEW_CELL, light: BACKDROP_LIGHT, out, depthBuffer });
      image.data.set(out);
      tileContext.putImageData(image, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(tile, 0, Math.round(bobAmplitude - bobY));
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      draw(0.6, 0);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const loop = (now: number) => {
      const seconds = (now - start) / 1000;
      draw(seconds * SPIN_SPEED, Math.sin(seconds * BOB_SPEED) * bobAmplitude);
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frame);
  }, [prop]);

  return <canvas ref={canvasRef} className={styles.preview} aria-label={`3D preview of ${prop.name}`} />;
}
