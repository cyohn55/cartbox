/**
 * Layered-scene compositor — a preview-only renderer that composites depth-
 * placed billboard planes under a perspective camera that can pan and yaw. Like
 * renderLitRgba it is pure (RGBA in, RGBA out, no DOM), so the editor preview
 * and the tests drive identical math.
 *
 * Each plane is a front-facing card at a world depth. Perspective makes near
 * planes move and scale more than far ones under a pan (true parallax), and yaw
 * about a pivot swings planes by an amount set by their depth relative to that
 * pivot (planes in front of the pivot swing opposite to those behind it). That
 * depth-driven swing is exactly what turns a stack of sprite parts into a
 * pseudo-3D, volumetric character.
 *
 * This module knows nothing about sprites or rigs; it composites generic RGBA
 * images so the same engine serves parallax backdrops and character rigs alike.
 */

/** An axis-aligned billboard: a textured card placed in the scene at a depth. */
export interface ScenePlane {
  /** RGBA pixels, row-major, length imageWidth * imageHeight * 4. */
  readonly image: Uint8ClampedArray;
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** Scene-space anchor (the plane's centre), world units, before the camera. */
  readonly x: number;
  readonly y: number;
  /** Depth from the camera plane, world units; must be > 0 (larger = farther). */
  readonly depth: number;
  /** World units covered by one source pixel — the plane's physical scale. */
  readonly unitsPerPixel: number;
}

/** A perspective camera that can translate (pan) and rotate (yaw) about a pivot. */
export interface Camera {
  /** Horizontal / vertical pan, world units. */
  readonly panX: number;
  readonly panY: number;
  /** Yaw about the vertical axis through the pivot, radians. */
  readonly yaw: number;
  /** World-space position of the yaw pivot (depth is distance from camera). */
  readonly pivotX: number;
  readonly pivotDepth: number;
  /** Focal length in pixels: on-screen scale = focalLength / depth. */
  readonly focalLength: number;
  /** Output framebuffer size, pixels. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/** Where a plane's anchor lands on screen, and how much its image is scaled. */
export interface ProjectedPlane {
  /** Screen position of the plane centre, pixels. */
  readonly screenX: number;
  readonly screenY: number;
  /** Output pixels per source pixel (perspective + physical scale combined). */
  readonly pixelScale: number;
  /** Post-transform depth from the camera; planes with viewDepth <= 0 are hidden. */
  readonly viewDepth: number;
}

/** A composited frame: RGBA pixels plus its dimensions. */
export interface RenderedFrame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * Project a plane's anchor through the camera. Yaw rotates the anchor about the
 * pivot in the X-depth plane, then the pan and a perspective divide place it on
 * screen. Exposed on its own so callers (and tests) can reason about parallax
 * and swing without rasterising.
 */
export function projectPlane(plane: ScenePlane, camera: Camera): ProjectedPlane {
  const relativeX = plane.x - camera.pivotX;
  const relativeDepth = plane.depth - camera.pivotDepth;

  const cos = Math.cos(camera.yaw);
  const sin = Math.sin(camera.yaw);
  const rotatedX = relativeX * cos + relativeDepth * sin;
  const rotatedDepth = -relativeX * sin + relativeDepth * cos;

  const worldX = camera.pivotX + rotatedX;
  const viewDepth = camera.pivotDepth + rotatedDepth;

  const viewX = worldX - camera.panX;
  const viewY = plane.y - camera.panY;

  const perspective = viewDepth > 0 ? camera.focalLength / viewDepth : 0;
  return {
    screenX: camera.viewportWidth / 2 + viewX * perspective,
    screenY: camera.viewportHeight / 2 + viewY * perspective,
    pixelScale: perspective * plane.unitsPerPixel,
    viewDepth,
  };
}

/** Alpha-composite one source pixel over the framebuffer at `destIndex`. */
function blendPixel(
  frame: Uint8ClampedArray,
  destIndex: number,
  red: number,
  green: number,
  blue: number,
  sourceAlpha: number,
): void {
  const alpha = sourceAlpha / 255;
  const inverse = 1 - alpha;
  frame[destIndex] = red * alpha + (frame[destIndex] ?? 0) * inverse;
  frame[destIndex + 1] = green * alpha + (frame[destIndex + 1] ?? 0) * inverse;
  frame[destIndex + 2] = blue * alpha + (frame[destIndex + 2] ?? 0) * inverse;
  frame[destIndex + 3] = Math.max(frame[destIndex + 3] ?? 0, sourceAlpha);
}

/**
 * Rasterise one projected plane into `frame` with nearest-neighbour sampling
 * (crisp for pixel art) and alpha compositing. Iterates the destination rect and
 * maps each output pixel back to a source pixel, so arbitrary scales are safe.
 */
function drawPlane(
  frame: Uint8ClampedArray,
  camera: Camera,
  plane: ScenePlane,
  projected: ProjectedPlane,
): void {
  if (projected.viewDepth <= 0 || projected.pixelScale <= 0) return;

  const drawWidth = plane.imageWidth * projected.pixelScale;
  const drawHeight = plane.imageHeight * projected.pixelScale;
  const left = projected.screenX - drawWidth / 2;
  const top = projected.screenY - drawHeight / 2;

  const startX = Math.max(0, Math.floor(left));
  const startY = Math.max(0, Math.floor(top));
  const endX = Math.min(camera.viewportWidth - 1, Math.ceil(left + drawWidth) - 1);
  const endY = Math.min(camera.viewportHeight - 1, Math.ceil(top + drawHeight) - 1);

  for (let destY = startY; destY <= endY; destY += 1) {
    const sourceY = Math.floor((destY + 0.5 - top) / projected.pixelScale);
    if (sourceY < 0 || sourceY >= plane.imageHeight) continue;

    for (let destX = startX; destX <= endX; destX += 1) {
      const sourceX = Math.floor((destX + 0.5 - left) / projected.pixelScale);
      if (sourceX < 0 || sourceX >= plane.imageWidth) continue;

      const sourceIndex = (sourceY * plane.imageWidth + sourceX) * 4;
      const sourceAlpha = plane.image[sourceIndex + 3] ?? 0;
      if (sourceAlpha === 0) continue;

      const destIndex = (destY * camera.viewportWidth + destX) * 4;
      blendPixel(
        frame,
        destIndex,
        plane.image[sourceIndex] ?? 0,
        plane.image[sourceIndex + 1] ?? 0,
        plane.image[sourceIndex + 2] ?? 0,
        sourceAlpha,
      );
    }
  }
}

/**
 * Composite `planes` under `camera` into a fresh RGBA frame. Each plane is
 * projected first, then drawn far-to-near by its *post-rotation* view depth
 * (painter's algorithm) so occlusion stays correct even as yaw reorders the
 * stack. The input order is not mutated.
 */
export function renderLayeredScene(planes: readonly ScenePlane[], camera: Camera): RenderedFrame {
  const width = camera.viewportWidth;
  const height = camera.viewportHeight;
  const data = new Uint8ClampedArray(width * height * 4);

  const projected = planes
    .map((plane) => ({ plane, view: projectPlane(plane, camera) }))
    .sort((a, b) => b.view.viewDepth - a.view.viewDepth);

  for (const { plane, view } of projected) {
    drawPlane(data, camera, plane, view);
  }

  return { data, width, height };
}
