/**
 * Tests for the shared tool-capability vocabulary and the four tool tables that
 * declare against it.
 *
 * These drive the real exported tables — the sprite editor's, the voxel
 * sculptor's, the map layers', and the handheld skin editor's — rather than
 * hand-built fixtures, because the property under test is precisely that those
 * tables are internally consistent and that the sets every editor branches on
 * are derived from them rather than maintained beside them. A fixture would
 * prove the helper works and prove nothing about the shipping rails.
 */

import { describe, expect, it } from "vitest";

import {
  capabilitiesOf,
  toolIdsWith,
  type ToolCapabilities,
  type ToolDefinition,
} from "../apps/web/src/app/edit/[cartId]/toolCapabilities";
import {
  TOOLS,
  SHAPE_TOOLS,
  WEIGHTED_TOOLS,
  TOLERANCE_TOOLS,
  type Tool,
} from "../apps/web/src/app/edit/[cartId]/tools";
import {
  VOXEL_TOOLS,
  BRUSH_TOOLS,
  MATERIAL_TOOLS,
  TOLERANCE_TOOLS as VOXEL_TOLERANCE_TOOLS,
  type VoxelTool,
} from "../apps/web/src/app/edit/[cartId]/voxelTools";
import { MAP_LAYERS } from "../apps/web/src/app/edit/[cartId]/maptools";
import {
  SKIN_TOOLS,
  SHAPE_TOOLS as SKIN_SHAPE_TOOLS,
  WEIGHTED_TOOLS as SKIN_WEIGHTED_TOOLS,
  type SkinTool,
} from "../apps/web/src/app/onboarding/handheld/skinTools";

/** Every capability flag, so a new one cannot be added without a test seeing it. */
const CAPABILITY_KEYS: ReadonlyArray<keyof ToolCapabilities> = ["weighted", "tolerant", "dragged"];

describe("capabilitiesOf", () => {
  it("resolves a partial declaration to a complete record", () => {
    // The pencil declares only `weighted`; the other flags must come back false
    // rather than undefined, since the rails branch on them directly.
    const pencil = capabilitiesOf(TOOLS, "pencil");

    expect(pencil).toEqual({ weighted: true, tolerant: false, dragged: false });
  });

  it("resolves a tool that declares nothing", () => {
    // Select declares no capabilities at all — no `capabilities` key on the entry.
    const select = capabilitiesOf(VOXEL_TOOLS, "select");

    expect(select).toEqual({ weighted: false, tolerant: false, dragged: false });
  });

  it("returns every flag off for an id no longer in the table", () => {
    // Editor state can outlive a tool being renamed, so an unknown id must yield
    // a rail with fewer sliders rather than a throw on mount.
    const stale = capabilitiesOf(TOOLS, "airbrush" as Tool);

    expect(stale).toEqual({ weighted: false, tolerant: false, dragged: false });
  });

  it("gives each table entry a resolvable, complete record", () => {
    for (const table of [TOOLS, VOXEL_TOOLS, SKIN_TOOLS] as readonly ToolDefinition<string>[][]) {
      for (const tool of table) {
        const resolved = capabilitiesOf(table, tool.id);
        for (const key of CAPABILITY_KEYS) {
          expect(typeof resolved[key], `${tool.id}.${key}`).toBe("boolean");
        }
      }
    }
  });
});

describe("toolIdsWith", () => {
  it("collects exactly the ids declaring a capability", () => {
    const dragged = toolIdsWith(TOOLS, "dragged");

    expect([...dragged].sort()).toEqual(["ellipse", "line", "rect"]);
  });

  it("agrees with capabilitiesOf across every table", () => {
    // The two readers of the same declaration must never disagree: the canvases
    // test the set per pointer event, the rails ask capabilitiesOf per render.
    const tables: readonly ToolDefinition<string>[][] = [TOOLS, VOXEL_TOOLS, SKIN_TOOLS];
    for (const table of tables) {
      for (const key of CAPABILITY_KEYS) {
        const ids = toolIdsWith(table, key);
        for (const tool of table) {
          expect(ids.has(tool.id), `${tool.id}.${key}`).toBe(capabilitiesOf(table, tool.id)[key]);
        }
      }
    }
  });

  it("returns an empty set for a capability no tool in the table declares", () => {
    // No 2D drawing tool is a voxel-style brush-only tool; more to the point, an
    // absent capability must not fall back to "all of them".
    expect(toolIdsWith(MAP_LAYERS, "weighted").size).toBe(0);
  });
});

describe("sprite editor tools", () => {
  it("derives its rail sets from the table", () => {
    expect(WEIGHTED_TOOLS).toEqual(toolIdsWith(TOOLS, "weighted"));
    expect(TOLERANCE_TOOLS).toEqual(toolIdsWith(TOOLS, "tolerant"));
    expect(SHAPE_TOOLS).toEqual(toolIdsWith(TOOLS, "dragged"));
  });

  it("keeps the brush-size and tolerance sliders mutually exclusive", () => {
    // The rail renders both conditionally; a tool in both sets would stack two
    // sliders that mean different things by the same stroke.
    for (const tool of TOOLS) {
      const { weighted, tolerant } = capabilitiesOf(TOOLS, tool.id);
      expect(weighted && tolerant, tool.id).toBe(false);
    }
  });

  it("gives every dragged tool an adjustable weight", () => {
    // PixelCanvas thickens a dragged shape by the brush weight, so a dragged
    // tool with no weight slider would silently draw at 1px with no way to change it.
    for (const id of toolIdsWith(TOOLS, "dragged")) {
      expect(capabilitiesOf(TOOLS, id).weighted, id).toBe(true);
    }
  });
});

describe("voxel sculptor tools", () => {
  it("derives its rail sets from the table", () => {
    expect(BRUSH_TOOLS).toEqual(toolIdsWith(VOXEL_TOOLS, "weighted"));
    expect(VOXEL_TOLERANCE_TOOLS).toEqual(toolIdsWith(VOXEL_TOOLS, "tolerant"));
  });

  it("stamps no 3D tool as dragged", () => {
    // The voxel Shape tool click-stamps on the face under the cursor; nothing in
    // the sculptor drags a live preview out the way the 2D shapes do.
    expect(toolIdsWith(VOXEL_TOOLS, "dragged").size).toBe(0);
  });

  it("names only real tools as material-capable", () => {
    const ids = new Set<VoxelTool>(VOXEL_TOOLS.map((tool) => tool.id));
    for (const id of MATERIAL_TOOLS) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("arms a material only for tools that write cells", () => {
    // Remove and Wand don't author a cell's material — Remove clears cells and
    // Wand only selects — so the material palette must stay hidden for them.
    expect(MATERIAL_TOOLS).not.toContain("remove");
    expect(MATERIAL_TOOLS).not.toContain("wand");
  });
});

describe("handheld skin tools", () => {
  it("derives its rail sets from the table", () => {
    expect(SKIN_WEIGHTED_TOOLS).toEqual(toolIdsWith(SKIN_TOOLS, "weighted"));
    expect(SKIN_SHAPE_TOOLS).toEqual(toolIdsWith(SKIN_TOOLS, "dragged"));
  });

  it("declares the same capabilities as the sprite editor for the tools they share", () => {
    // The skin editor is the sprite editor plus an eyedropper and a pan grip.
    // Where the two offer the same tool it must behave the same, which is the
    // drift the two hand-written sets used to allow.
    const shared = TOOLS.map((tool) => tool.id).filter((id) =>
      SKIN_TOOLS.some((skin) => skin.id === (id as string)),
    );

    expect(shared.length).toBeGreaterThan(0);
    for (const id of shared) {
      expect(capabilitiesOf(SKIN_TOOLS, id as SkinTool), id).toEqual(capabilitiesOf(TOOLS, id));
    }
  });

  it("gives the non-painting tools no brush controls", () => {
    // Eyedropper samples and Pan scrolls; neither lays down pixels, so neither
    // should offer a stroke width.
    expect(capabilitiesOf(SKIN_TOOLS, "eyedropper").weighted).toBe(false);
    expect(capabilitiesOf(SKIN_TOOLS, "pan").weighted).toBe(false);
  });
});

describe("map layers", () => {
  it("carries the rail's tool shape, so the layer switch renders as a tool rail", () => {
    for (const layer of MAP_LAYERS) {
      expect(typeof layer.label, layer.id).toBe("string");
      expect(typeof layer.glyph, layer.id).toBe("string");
      expect(typeof layer.hint, layer.id).toBe("string");
      expect(layer.tools.length, layer.id).toBeGreaterThan(0);
    }
  });

  it("gives every layer's tools a label, glyph and hint", () => {
    for (const layer of MAP_LAYERS) {
      for (const tool of layer.tools) {
        expect(tool.label, `${layer.id}/${tool.id}`).toBeTruthy();
        expect(tool.glyph, `${layer.id}/${tool.id}`).toBeTruthy();
        expect(tool.hint, `${layer.id}/${tool.id}`).toBeTruthy();
      }
    }
  });
});

describe("tool tables as a whole", () => {
  it("has unique ids within each table", () => {
    const tables: ReadonlyArray<readonly { id: string }[]> = [TOOLS, VOXEL_TOOLS, SKIN_TOOLS, MAP_LAYERS];
    for (const table of tables) {
      const ids = table.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("gives every tool a label and a glyph for the rail to render", () => {
    const tables: ReadonlyArray<readonly ToolDefinition<string>[]> = [TOOLS, VOXEL_TOOLS, SKIN_TOOLS];
    for (const table of tables) {
      for (const tool of table) {
        expect(tool.label, tool.id).toBeTruthy();
        expect(tool.glyph, tool.id).toBeTruthy();
      }
    }
  });
});
