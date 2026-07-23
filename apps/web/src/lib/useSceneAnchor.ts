"use client";

/**
 * Places a centred DOM element at a world anchor under the shared scene camera
 * (scene3d.ts), so the interactive handhelds and the voxel tagline are positioned
 * by the same `[x, y, z]` coordinates as the voxel world — projected to a CSS
 * transform rather than voxelised, which keeps them crisp and clickable.
 *
 * Returns the transform to apply, or `undefined` until the world renderer has
 * published a camera layout (the element then rests at its natural centred
 * position). It recomputes whenever the layout changes (a resize/rebuild).
 */

import { useEffect, useState } from "react";

import { getSceneLayout, projectAnchor, subscribeSceneLayout, type Vec3 } from "./scene3d";

/**
 * The CSS transform that seats a centred element at `anchor`.
 *
 * @param anchor      World-space position of the element.
 * @param selfCentred Pass `true` for an element pinned to the viewport centre via
 *                    `left/top: 50%` (folds in the -50% self-centring). Omit it for
 *                    an element its layout already centres (e.g. a flex child),
 *                    which needs only the projected offset + scale.
 */
export function useSceneAnchorTransform(anchor: Vec3, selfCentred = false): string | undefined {
  const [transform, setTransform] = useState<string | undefined>(undefined);

  useEffect(() => {
    const update = () => {
      const layout = getSceneLayout();
      if (!layout) return;
      const { offsetX, offsetY, scale } = projectAnchor(anchor, layout);
      const centring = selfCentred ? "translate(-50%, -50%) " : "";
      setTransform(`${centring}translate(${offsetX}px, ${offsetY}px) scale(${scale})`);
    };
    update();
    return subscribeSceneLayout(update);
  }, [anchor, selfCentred]);

  return transform;
}
