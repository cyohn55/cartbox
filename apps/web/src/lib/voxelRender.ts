/**
 * Isometric voxel renderer for avatars: rotate the voxel cloud around the
 * vertical axis, painter-sort it, and draw each cube as three shaded faces on
 * a plain 2D canvas. The math (rotation, projection, ordering) is pure and
 * unit-testable; only drawVoxels touches a canvas context.
 */

import type { Voxel } from "./voxelAvatar";

export interface ProjectedVoxel {
  /** Screen-space top-center of the cube, in unscaled units. */
  screenX: number;
  screenY: number;
  /** Painter key: draw ascending. */
  depth: number;
  color: string;
}

/**
 * Rotates a voxel around the y axis (about x = -0.5, z = 0 — the body's
 * center) and projects it to 2:1 isometric screen space.
 */
export function projectVoxel(voxel: Voxel, angle: number): ProjectedVoxel {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = voxel.x + 0.5;
  const rx = dx * cos - voxel.z * sin;
  const rz = dx * sin + voxel.z * cos;
  return {
    screenX: rx - rz,
    screenY: (rx + rz) * 0.5 - voxel.y,
    depth: rx + rz + voxel.y * 0.001, // ties break upward so stacks layer correctly
    color: voxel.color,
  };
}

/** Projects and painter-sorts a voxel cloud for one frame. */
export function projectVoxels(voxels: readonly Voxel[], angle: number): ProjectedVoxel[] {
  return voxels.map((voxel) => projectVoxel(voxel, angle)).sort((a, b) => a.depth - b.depth);
}

/** Mixes a hex color toward black (amount<0) or white (amount>0). */
export function shadeHex(hex: string, amount: number): string {
  const target = amount >= 0 ? 255 : 0;
  const strength = Math.min(1, Math.abs(amount));
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((pair) => {
    const value = parseInt(pair, 16);
    const mixed = Math.round(value + (target - value) * strength);
    return mixed.toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

export interface DrawOptions {
  width: number;
  height: number;
  /** Cube half-width in pixels. */
  scale: number;
  /** Vertical center offset, 0..1 of height (default centers the body). */
  centerY?: number;
}

/** Draws one frame of the rotating avatar onto a 2D context. */
export function drawVoxels(
  context: CanvasRenderingContext2D,
  voxels: readonly Voxel[],
  angle: number,
  options: DrawOptions,
): void {
  const { width, height, scale } = options;
  const cx = width / 2;
  const cy = height * (options.centerY ?? 0.62);
  const projected = projectVoxels(voxels, angle);

  context.clearRect(0, 0, width, height);
  for (const voxel of projected) {
    const px = cx + voxel.screenX * scale;
    const py = cy + voxel.screenY * scale;

    // Top face.
    context.fillStyle = shadeHex(voxel.color, 0.25);
    context.beginPath();
    context.moveTo(px, py);
    context.lineTo(px + scale, py + scale * 0.5);
    context.lineTo(px, py + scale);
    context.lineTo(px - scale, py + scale * 0.5);
    context.closePath();
    context.fill();

    // Left face.
    context.fillStyle = shadeHex(voxel.color, -0.3);
    context.beginPath();
    context.moveTo(px - scale, py + scale * 0.5);
    context.lineTo(px, py + scale);
    context.lineTo(px, py + scale * 2);
    context.lineTo(px - scale, py + scale * 1.5);
    context.closePath();
    context.fill();

    // Right face.
    context.fillStyle = shadeHex(voxel.color, -0.08);
    context.beginPath();
    context.moveTo(px + scale, py + scale * 0.5);
    context.lineTo(px, py + scale);
    context.lineTo(px, py + scale * 2);
    context.lineTo(px + scale, py + scale * 1.5);
    context.closePath();
    context.fill();
  }
}
