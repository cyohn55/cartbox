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

/** Which shape the tool draws. */
export type VoxelShapeKind = "rectangle" | "circle";

/** Whether the shape is just its border or a solid area. */
export type VoxelShapeStyle = "outline" | "fill";

/** A single cell offset in the drawing plane, relative to the shape's centre. */
export interface ShapeOffset {
  readonly u: number;
  readonly v: number;
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
