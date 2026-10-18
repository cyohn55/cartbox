/**
 * Every map's offline bakes in one place (BEAVER_CREEK_ROADMAP.md B1): its
 * light map, its light probes and, for a map with a kit of its own, the kit's
 * occlusion and relief maps. `npm run bake:map <id>` bakes a map's parts into
 * its own generated files, and `map-bakes.test.ts` fails, for every map, when
 * a stored bake no longer fits the geometry it was made for. (At runtime a
 * stale bake still falls back to unlit, so a forgotten bake costs looks, not
 * a crash; CI is where it's caught.)
 */

import { bytesToBase64 } from "./base64";
import { encodeLightProbes, type LightProbeGrid } from "./lightProbes";
import { layoutFingerprint, type LightmapLayout } from "./lightmap";
import { BEAVER_LIGHTMAP } from "./beaverCreekLightmap.generated";
import { BEAVER_PROBES } from "./beaverCreekProbes.generated";
import { bakeBeaverLightmap, bakeBeaverProbes, beaverMapLayout } from "./beaverCreekSeed";
import { LOCKOUT_LIGHTMAP } from "./lockoutLightmap.generated";
import { LOCKOUT_PROBES } from "./lockoutProbes.generated";
import { bakeLockoutKit, bakeLockoutLightmap, bakeLockoutProbes, lockoutKitBakeCurrent, lockoutMapLayout } from "./lockoutSeed";
import { encodeRgbaPng } from "./png";
import { compressedImagesCurrent, type CompressedImageTable } from "./compressedImages";
import { BEAVER_SCENE } from "./beaverCreekSeed";
import { arenaMeshSidecar } from "./lockoutSeed";
import { BEAVER_TEXTURES } from "./beaverCreekTextures.generated";

/** The parts of a map that bake. */
export type MapBakePart = "lightmap" | "probes" | "kit" | "textures";
export const MAP_BAKE_PARTS: readonly MapBakePart[] = ["lightmap", "probes", "kit", "textures"];

/** A generated file a bake writes: its path from the repository root, and the constant it exports. */
export interface MapBakeFile {
  readonly path: string;
  readonly constant: string;
}

/** One map's bakes: how to bake each part, where it's stored, and whether the stored one still fits. */
export interface MapBakes {
  readonly id: string;
  readonly name: string;
  /** The map's light-map layout (its geometry, laid out for the light map: the fingerprint's source). */
  readonly layout: () => LightmapLayout;
  /** Bake the light map (RGBA at the layout's size). */
  readonly bakeLightmap: (progress?: (done: number) => void) => Uint8ClampedArray;
  /** Bake the light probes. */
  readonly bakeProbes: (progress?: (done: number) => void) => LightProbeGrid;
  /** Bake the map's own kit pieces, by name (absent: the map has no kit of its own). */
  readonly bakeKit?: () => Record<string, { fingerprint: string; occlusion: string; relief: string }>;
  /**
   * The map's sidecar as built, before its baked KTX2 images are attached: what
   * the texture bake reads (F1a; absent: the map's textures aren't baked).
   */
  readonly sidecar?: () => string;
  /** The stored bakes' fingerprints, and whether each stored kit piece still fits its piece. */
  readonly stored: {
    readonly lightmap: string;
    readonly probes: string | null;
    readonly kit?: () => Record<string, boolean>;
    /** The baked KTX2 images (see compressedImages.ts). */
    readonly textures?: CompressedImageTable;
  };
  readonly files: { readonly lightmap: MapBakeFile; readonly probes: MapBakeFile; readonly kit?: MapBakeFile; readonly textures?: MapBakeFile };
}

/** Every map that bakes, by id. */
export const MAP_BAKES: Readonly<Record<string, MapBakes>> = {
  lockout: {
    id: "lockout",
    name: "Lockout",
    layout: lockoutMapLayout,
    bakeLightmap: bakeLockoutLightmap,
    bakeProbes: bakeLockoutProbes,
    bakeKit: bakeLockoutKit,
    stored: { lightmap: LOCKOUT_LIGHTMAP.fingerprint, probes: LOCKOUT_PROBES.probes ? LOCKOUT_PROBES.fingerprint : null, kit: lockoutKitBakeCurrent },
    files: {
      lightmap: { path: "packages/editor/src/model/lockoutLightmap.generated.ts", constant: "LOCKOUT_LIGHTMAP" },
      probes: { path: "packages/editor/src/model/lockoutProbes.generated.ts", constant: "LOCKOUT_PROBES" },
      kit: { path: "packages/editor/src/model/lockoutKitMaps.generated.ts", constant: "LOCKOUT_KIT_MAPS" },
    },
  },
  beaver: {
    id: "beaver",
    name: "Beaver Creek",
    layout: beaverMapLayout,
    bakeLightmap: bakeBeaverLightmap,
    bakeProbes: bakeBeaverProbes,
    sidecar: () => arenaMeshSidecar(BEAVER_SCENE),
    stored: { lightmap: BEAVER_LIGHTMAP.fingerprint, probes: BEAVER_PROBES.probes ? BEAVER_PROBES.fingerprint : null, textures: BEAVER_TEXTURES },
    files: {
      lightmap: { path: "packages/editor/src/model/beaverCreekLightmap.generated.ts", constant: "BEAVER_LIGHTMAP" },
      probes: { path: "packages/editor/src/model/beaverCreekProbes.generated.ts", constant: "BEAVER_PROBES" },
      textures: { path: "packages/editor/src/model/beaverCreekTextures.generated.ts", constant: "BEAVER_TEXTURES" },
    },
  },
};

/** Which of a map's stored bakes still fit it (a part the map doesn't have is current). */
export function mapBakeStatus(id: string): Record<MapBakePart, boolean> {
  const map = MAP_BAKES[id];
  if (!map) throw new Error(`No map "${id}" bakes (known: ${Object.keys(MAP_BAKES).join(", ")})`);
  const fingerprint = layoutFingerprint(map.layout());
  const kit = map.stored.kit ? Object.values(map.stored.kit()).every(Boolean) : true;
  const textures = map.sidecar && map.stored.textures ? compressedImagesCurrent(map.sidecar(), map.stored.textures) : true;
  return { lightmap: map.stored.lightmap === fingerprint, probes: map.stored.probes === fingerprint, kit, textures };
}

const header = (id: string, what: string) =>
  `// Generated by \`npm run bake:map ${id}\` — do not edit. ${what}\n`;

/** Bake a map's light map and render its generated file. */
export function bakeMapLightmapSource(id: string): string {
  const map = MAP_BAKES[id]!;
  const layout = map.layout();
  const png = encodeRgbaPng(map.bakeLightmap(), layout.size, layout.size, { compress: true });
  return `${header(id, `${map.name}'s baked light map (see lightmap.ts),\n// and the fingerprint of the light-map layout (the map's geometry) it was baked for.`)}export const ${map.files.lightmap.constant} = {
  fingerprint: ${JSON.stringify(layoutFingerprint(layout))},
  png: ${JSON.stringify(bytesToBase64(png))},
} as const;
`;
}

/** Bake a map's light probes and render their generated file. */
export function bakeMapProbesSource(id: string): string {
  const map = MAP_BAKES[id]!;
  const stored = encodeLightProbes(map.bakeProbes());
  return `${header(id, `${map.name}'s baked light probes (see lightProbes.ts),\n// and the fingerprint of the light-map layout (the map's geometry) they were baked for.`)}export const ${map.files.probes.constant} = {
  fingerprint: ${JSON.stringify(layoutFingerprint(map.layout()))},
  probes: ${JSON.stringify(stored)} as null | { min: [number, number, number]; max: [number, number, number]; counts: [number, number, number]; data: string },
};
`;
}

/** Bake a map's kit pieces and render their generated file (null for a map without a kit of its own). */
export function bakeMapKitSource(id: string): string | null {
  const map = MAP_BAKES[id]!;
  if (!map.bakeKit || !map.files.kit) return null;
  const body = Object.entries(map.bakeKit())
    .map(([name, m]) => `  ${name}: {\n    fingerprint: ${JSON.stringify(m.fingerprint)},\n    occlusion: ${JSON.stringify(m.occlusion)},\n    relief: ${JSON.stringify(m.relief)},\n  },`)
    .join("\n");
  return `${header(id, `${map.name}'s kit: each piece's baked occlusion and\n// relief maps (see textureBake.ts), with the fingerprint of the laid-out mesh each was baked for.`)}export const ${map.files.kit.constant}: Readonly<Record<string, { readonly fingerprint: string; readonly occlusion: string; readonly relief: string }>> = {
${body}
};
`;
}

/**
 * A map's baked textures' generated file (F1a), from the KTX2 the bake encoded
 * for each image (base64, `""` for one left uncompressed). The encoding itself
 * needs the Basis encoder, which only the bake (map-bake.test.ts) loads.
 */
export function bakeMapTexturesSource(id: string, table: CompressedImageTable): string | null {
  const map = MAP_BAKES[id]!;
  if (!map.files.textures) return null;
  const body = Object.entries(table)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, ktx2]) => `  ${JSON.stringify(key)}: ${JSON.stringify(ktx2)},`)
    .join("\n");
  return `${header(id, `${map.name}'s images as KTX2\n// (see compressedImages.ts), keyed by each image's bytes; "" for one left uncompressed.`)}export const ${map.files.textures.constant}: Readonly<Record<string, string>> = {
${body}
};
`;
}
