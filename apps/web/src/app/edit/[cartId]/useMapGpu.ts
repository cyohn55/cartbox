"use client";

/**
 * Owning the map's GPU renderer from React.
 *
 * Both 3D views want the same three things and want them in the same order: a
 * canvas to draw into, a device that may or may not exist, and a promise to fall
 * back gracefully when it does not. Doing that twice invites the two views to
 * drift — one falling back where the other does not, or one leaking a device on
 * unmount — so it is done once here.
 *
 * The status is deliberately three-valued. "probing" is not "no": adapter
 * request is asynchronous, and treating the first render as a refusal would make
 * every load flash the software path before switching, which looks like a bug
 * even when it is not. A view shows nothing until the question is answered, which
 * takes a few milliseconds.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextureAtlas, VoxelModel } from "@cartbox/editor";

import { worldTileFinish } from "@/lib/faceTextures";
import { MapGpuRenderer, type MapGpuFrame } from "./MapGpuRenderer";

/** Whether hardware rendering is available, still being decided, or refused. */
export type MapGpuStatus = "probing" | "gpu" | "cpu";

export interface MapGpuHandle {
  readonly status: MapGpuStatus;
  /** Attach to the canvas the GPU draws into; it is not a 2D context. */
  readonly canvasRef: React.RefObject<HTMLCanvasElement>;
  /**
   * Upload a surface. Returns false when the upload failed, which drops the view
   * to its CPU path for good rather than leaving a stale frame on screen.
   */
  readonly uploadModel: (model: VoxelModel) => boolean;
  /** Draw a frame. Returns false on failure, with the same meaning. */
  readonly draw: (frame: MapGpuFrame) => boolean;
}

/**
 * Create and hold a renderer for a canvas, keeping the atlas uploaded.
 *
 * `atlasVersion` exists because the atlas is rebuilt into a new object whenever
 * any of the cart's art changes, and re-uploading a few hundred small textures on
 * every render would undo the point of moving to the GPU.
 */
export function useMapGpu(atlas: TextureAtlas, atlasVersion: number): MapGpuHandle {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MapGpuRenderer | null>(null);
  const faceLayerRef = useRef<Int32Array | undefined>(undefined);
  const [status, setStatus] = useState<MapGpuStatus>("probing");

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) {
      setStatus("cpu");
      return;
    }
    void MapGpuRenderer.create(canvas).then((renderer) => {
      if (cancelled || !renderer) {
        renderer?.destroy();
        if (!cancelled) setStatus("cpu");
        return;
      }
      rendererRef.current = renderer;
      setStatus("gpu");
    });
    return () => {
      cancelled = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || status !== "gpu") return;
    const packed = renderer.setAtlas(atlas, worldTileFinish);
    if (!packed) {
      setStatus("cpu");
      return;
    }
    faceLayerRef.current = packed.faceLayer;
  }, [atlas, atlasVersion, status]);

  const uploadModel = useCallback((model: VoxelModel): boolean => {
    const renderer = rendererRef.current;
    if (!renderer || !renderer.ready) return false;
    renderer.setModel(model, faceLayerRef.current);
    return true;
  }, []);

  const draw = useCallback((frame: MapGpuFrame): boolean => {
    const renderer = rendererRef.current;
    if (!renderer) return false;
    return renderer.render(frame);
  }, []);

  // Memoised, and that is load-bearing rather than tidiness: callers hang effects
  // off this handle, and a fresh object every render would re-upload the whole
  // surface — hundreds of thousands of vertices — on any state change at all.
  return useMemo(
    () => ({ status, canvasRef, uploadModel, draw }),
    [status, uploadModel, draw],
  );
}
