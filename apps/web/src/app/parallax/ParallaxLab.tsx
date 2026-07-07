"use client";

/**
 * Parallax Lab — demo for the layered-scene compositor. It builds a depth-
 * layered 3D scene (parallax backdrop planes plus a procedural segmented
 * character) and hands the planes to the shared LayeredSceneView, which owns the
 * camera and controls. Preview-only, like the lit/god-ray previews.
 */

import { useMemo } from "react";
import { buildRigPlanes, demoCharacterRig, type ScenePlane } from "@cartbox/editor";

import { LayeredSceneView } from "../edit/[cartId]/LayeredSceneView";

const PIVOT_DEPTH = 10;

/** A horizontally-banded backdrop image, darker toward the bottom for depth. */
function backdropImage(width: number, height: number, base: [number, number, number]): Uint8ClampedArray {
  const image = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const shade = 0.6 + 0.4 * (1 - y / height);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      image[i] = base[0] * shade;
      image[i + 1] = base[1] * shade;
      image[i + 2] = base[2] * shade;
      image[i + 3] = 255;
    }
  }
  return image;
}

/** Three wide backdrop planes at increasing depth, for visible parallax on pan. */
function backdropPlanes(): ScenePlane[] {
  const specs: Array<{ depth: number; base: [number, number, number]; unitsPerPixel: number }> = [
    { depth: 40, base: [65, 166, 246], unitsPerPixel: 1.0 }, // far sky
    { depth: 24, base: [37, 113, 121], unitsPerPixel: 0.7 }, // mid ridge
    { depth: 15, base: [56, 130, 80], unitsPerPixel: 0.5 }, // near ground band
  ];
  return specs.map(({ depth, base, unitsPerPixel }) => ({
    image: backdropImage(80, 52, base),
    imageWidth: 80,
    imageHeight: 52,
    x: 0,
    y: 6,
    depth,
    unitsPerPixel,
  }));
}

export function ParallaxLab() {
  const planes = useMemo(() => {
    const rig = demoCharacterRig(PIVOT_DEPTH);
    return [...backdropPlanes(), ...buildRigPlanes(rig)];
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <LayeredSceneView planes={planes} pivotDepth={PIVOT_DEPTH} />
      <p style={{ color: "#94b0c2", margin: 0, maxWidth: 720 }}>
        Drag the scene to pan; slide or auto-orbit to yaw. The fore arm swings
        faster than the torso and the cape drifts slower — depth-driven parallax
        from flat sprite layers.
      </p>
    </div>
  );
}
