/**
 * Pure in-plane geometry for the Voxel editor's Shape tool: the set of integer
 * cell offsets a rectangle or circle covers, as an outline or a filled area,
 * sized by a radius (voxels from the centre to the edge, so the shape spans
 * `2*radius + 1` voxels across).
 *
 * DOM-free and coordinate-free — it returns offsets around an origin `(0, 0)` in
 * an abstract plane, so the editor can map them onto whichever grid plane the
 * user clicked, and the unit tests can assert on the raw geometry. Kept in the
 * editor package (not the app) so it shares the model layer with {@link VoxelGrid}
 * and can be reused by any future 3D authoring surface.
 */

/** Which flat (in-plane) shape the tool draws. */
export type VoxelShapeKind = "rectangle" | "circle";

/** Which volumetric (3D) shape the tool draws. */
export type VoxelSolidKind = "cube" | "sphere";

/** Whether the shape is just its border/shell or a solid area/volume. */
export type VoxelShapeStyle = "outline" | "fill";

/** A single cell offset in the drawing plane, relative to the shape's centre. */
export interface ShapeOffset {
  readonly u: number;
  readonly v: number;
}

/** A single cell offset in 3D space, relative to the solid's centre. */
export interface SolidOffset {
  readonly du: number;
  readonly dv: number;
  readonly dw: number;
}

/**
 * The cell offsets covered by `kind`/`style` at the given `radius`, centred on
 * the origin. Offsets are unique. A radius of 0 is always the single centre
 * cell. `radius` is floored and clamped to be non-negative, so callers can pass
 * a raw slider value.
 */
export function shapeOffsets(kind: VoxelShapeKind, style: VoxelShapeStyle, radius: number): ShapeOffset[] {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return [{ u: 0, v: 0 }];
  return kind === "rectangle" ? rectangleOffsets(style, r) : circleOffsets(style, r);
}

/** Axis-aligned square: every border cell (outline) or the whole block (fill). */
function rectangleOffsets(style: VoxelShapeStyle, r: number): ShapeOffset[] {
  const offsets: ShapeOffset[] = [];
  for (let v = -r; v <= r; v += 1) {
    for (let u = -r; u <= r; u += 1) {
      const onBorder = u === -r || u === r || v === -r || v === r;
      if (style === "fill" || onBorder) offsets.push({ u, v });
    }
  }
  return offsets;
}

/**
 * Rasterised disk (fill) or ring (outline) of the given radius. The fill keeps
 * every cell whose centre is within the radius; the outline scans both axes of
 * the circle equation and rounds to the nearest cell, so the ring stays gap-free
 * on both steep and shallow arcs (the same both-axes scan the sprite editor's
 * ellipse uses), deduplicated.
 */
function circleOffsets(style: VoxelShapeStyle, r: number): ShapeOffset[] {
  if (style === "fill") {
    const offsets: ShapeOffset[] = [];
    // A cell at distance <= r + 0.5 reads as inside, so the cardinal edge cells
    // (exactly r out) are included and the disk looks round rather than clipped.
    const limit = (r + 0.5) * (r + 0.5);
    for (let v = -r; v <= r; v += 1) {
      for (let u = -r; u <= r; u += 1) {
        if (u * u + v * v <= limit) offsets.push({ u, v });
      }
    }
    return offsets;
  }

  const seen = new Set<number>();
  const offsets: ShapeOffset[] = [];
  const stride = 2 * r + 1;
  const add = (u: number, v: number) => {
    const key = (v + r) * stride + (u + r);
    if (seen.has(key)) return;
    seen.add(key);
    offsets.push({ u, v });
  };
  for (let u = -r; u <= r; u += 1) {
    const v = Math.round(Math.sqrt(Math.max(0, r * r - u * u)));
    add(u, v);
    add(u, -v);
  }
  for (let v = -r; v <= r; v += 1) {
    const u = Math.round(Math.sqrt(Math.max(0, r * r - v * v)));
    add(u, v);
    add(-u, v);
  }
  return offsets;
}

/**
 * The 3D cell offsets covered by a `cube` or `sphere` at the given `radius`,
 * centred on the origin, as a hollow shell (`outline`) or a solid volume
 * (`fill`). Radius is voxels from the centre to a face/pole, so the solid spans
 * `2*radius + 1` voxels across each axis. A radius of 0 is always the single
 * centre cell. `radius` is floored and clamped to be non-negative.
 *
 * DOM-free and coordinate-free like {@link shapeOffsets}, so the editor maps the
 * offsets around whichever grid cell the user targeted and the tests assert on
 * the raw geometry.
 */
export function solidOffsets(kind: VoxelSolidKind, style: VoxelShapeStyle, radius: number): SolidOffset[] {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return [{ du: 0, dv: 0, dw: 0 }];
  return kind === "cube" ? cubeOffsets(style, r) : sphereOffsets(style, r);
}

/** Axis-aligned cube: the whole block (fill) or only its outer shell (outline). */
function cubeOffsets(style: VoxelShapeStyle, r: number): SolidOffset[] {
  const offsets: SolidOffset[] = [];
  for (let dw = -r; dw <= r; dw += 1) {
    for (let dv = -r; dv <= r; dv += 1) {
      for (let du = -r; du <= r; du += 1) {
        // A shell cell touches the cube's boundary on at least one axis.
        const onShell = Math.abs(du) === r || Math.abs(dv) === r || Math.abs(dw) === r;
        if (style === "fill" || onShell) offsets.push({ du, dv, dw });
      }
    }
  }
  return offsets;
}

/**
 * Solid ball (fill) or hollow shell (outline). The ball keeps every cell whose
 * centre is within the radius (the same `r + 0.5` slack the disk uses, so the
 * poles are included and it reads round). The shell is the subset of the ball
 * that has at least one empty 6-neighbour — a gap-free single-cell skin at any
 * radius, without the double-scan a rasterised ring would need in 3D.
 */
function sphereOffsets(style: VoxelShapeStyle, r: number): SolidOffset[] {
  const limit = (r + 0.5) * (r + 0.5);
  const inside = (du: number, dv: number, dw: number): boolean => du * du + dv * dv + dw * dw <= limit;

  const offsets: SolidOffset[] = [];
  for (let dw = -r; dw <= r; dw += 1) {
    for (let dv = -r; dv <= r; dv += 1) {
      for (let du = -r; du <= r; du += 1) {
        if (!inside(du, dv, dw)) continue;
        if (style === "fill") {
          offsets.push({ du, dv, dw });
          continue;
        }
        const exposed =
          !inside(du + 1, dv, dw) ||
          !inside(du - 1, dv, dw) ||
          !inside(du, dv + 1, dw) ||
          !inside(du, dv - 1, dw) ||
          !inside(du, dv, dw + 1) ||
          !inside(du, dv, dw - 1);
        if (exposed) offsets.push({ du, dv, dw });
      }
    }
  }
  return offsets;
}
