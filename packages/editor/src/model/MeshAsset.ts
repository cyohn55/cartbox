/**
 * A triangle-mesh asset — the editor's first true polygon-geometry type, sitting
 * alongside the voxel {@link VoxelGrid} rather than replacing it. A mesh is
 * imported from OBJ or glTF/GLB (see the codecs), previewed and transformed in
 * the editor, rasterised at runtime by the player, and re-exported.
 *
 * The model is deliberately small and flat:
 *
 * - A mesh is a list of {@link MeshPrimitive}s, each a triangle list with its own
 *   material. glTF's node hierarchy is baked into world-space vertex positions at
 *   import (see {@link parseGlb}), so a primitive is a plain buffer of geometry in
 *   one object space — the runtime then applies a single model matrix per instance.
 * - Geometry is stored the way the GPU and the software rasteriser both want it:
 *   de-indexed attribute streams (`positions`, `normals`, `uvs`) plus a triangle
 *   `indices` buffer. Normals and UVs are optional; a mesh without normals can
 *   have smooth ones derived with {@link computeSmoothNormals}.
 * - A material carries a base-colour factor and, optionally, one embedded
 *   base-colour image kept as its original compressed bytes (see
 *   {@link EncodedImage}) — decoding is the browser's job, and storing the
 *   compressed form keeps the sidecar far smaller than raw RGBA would.
 *
 * Pure and DOM-free: the same types feed the editor UI, the runtime rasteriser,
 * and the unit tests, and serialise to a compact JSON string for a cart sidecar.
 */

import { bytesToBase64, base64ToBytes } from "./base64";
import { generateTextures, isGeneratedImage, readGenerator, type TextureGenerator } from "./textureGenerators";
import { readInstanceLink, type MaterialInstanceLink } from "./materialInstanceLink";
import { readSurfaceEffects, writeSurfaceEffects } from "./materialEffects";
import { readMaterialLayers, writeMaterialLayers } from "./materialLayers";
import { MAX_MORPH_TARGETS, type MorphTarget } from "./morphTargets";
import { readMaterialExtensions, writeMaterialExtensions } from "./materialExtensions";
import { readSmartStack, writeSmartStack, type SmartStack } from "./smartMaterials";
import type { MaterialGraph } from "./materialGraph";
import { readMeshTrails, type MeshTrail } from "../render/meshTrails";
import {
  MAX_CLIP_KEYS,
  MAX_CLIPS,
  MAX_SKIN_JOINTS,
  type AnimationClip,
  type ClipChannel,
  type ClipKey,
  type MeshSkin,
  type SkinJoint,
} from "./skeleton";

/** Serialized-format version, bumped on any schema change. */
export const MESH_ASSET_VERSION = 1;

// Defensive caps for untrusted input (a mesh can arrive from another user's cart
// or an arbitrary uploaded file): large enough for real props, small enough that
// a malformed header can't drive a multi-gigabyte allocation.
export const MAX_MESH_VERTICES = 4_000_000;
export const MAX_MESH_INDICES = 12_000_000;

/** A compressed image (PNG/JPEG) kept in its original bytes; decoded on demand. */
export interface EncodedImage {
  /** MIME type, e.g. `"image/png"` — governs how a consumer decodes `bytes`. */
  readonly mime: string;
  readonly bytes: Uint8Array;
  /**
   * A streamed texture's placeholder: `bytes` is empty until the player is
   * handed the image for this ref (an asset-backed texture's content hash).
   */
  readonly ref?: string;
  /**
   * The same image as KTX2 with its mip chain (AAA_FIDELITY_ROADMAP.md F1a), a
   * map bake's: a renderer that samples the GPU's own compressed formats
   * decodes this instead, and every other path decodes `bytes`, so a map looks
   * the same on the tiers that never see it.
   */
  readonly ktx2?: Uint8Array;
  /** `ktx2` is this occlusion map already packed with its material's relief map (I4's packing, baked). */
  readonly ktx2Relief?: boolean;
}

/**
 * A rectangle of the cart's sprite sheet (page + pixel bounds) that a mesh
 * texture is authored in. When set, the editor treats the scene's texture as an
 * editable cart asset: it rebakes {@link MeshMaterial.baseColorImage} from these
 * sprite pixels (through the cart palette) whenever the cart is playtested or
 * saved, so editing the sprite in the Assets tab changes the 3D scene.
 *
 * It is purely an editor authoring link. The runtime never reads it — it samples
 * the already-baked `baseColorImage` — so a published cart renders identically
 * whether or not it carries this reference.
 */
export interface SpriteTextureRef {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A primitive's surface appearance: a base colour, optionally textured. */
export interface MeshMaterial {
  readonly name: string;
  /** Straight-alpha RGBA multiplier in 0..1, glTF's `baseColorFactor`. */
  readonly baseColorFactor: readonly [number, number, number, number];
  /** The base-colour (albedo) texture, or null for a flat-coloured surface. */
  readonly baseColorImage: EncodedImage | null;
  /**
   * A tangent-space normal map (RGB = normal·0.5+0.5), or null/absent for a
   * surface lit only by its geometry. Baked from the source sprite's Normal
   * layer alongside {@link baseColorImage}; the rasteriser perturbs the geometric
   * normal by it for per-pixel lighting (option 2). Optional so the many
   * materials without one need not spell it out.
   */
  readonly normalImage?: EncodedImage | null;
  /**
   * A packed surface-material map (RGBA: R = height, G = specular strength,
   * B = roughness, A = emissive; each 0..255), or null/absent for a plain
   * diffuse surface. Baked from the source sprite's Material layer alongside
   * {@link baseColorImage}; the rasteriser reads specular/roughness for a
   * view-dependent Blinn-Phong highlight and emissive for a self-illumination
   * floor (option 2, slice 5). Optional so the many materials without one — flat
   * primitives, imported meshes, world tiles — need not spell it out.
   */
  readonly materialImage?: EncodedImage | null;
  /**
   * --- PBR (metallic-roughness) channels, for the "Modern" render tier ---
   * These mirror glTF 2.0's metallic-roughness model so an imported asset keeps
   * its authored surface response. All optional and defaulting to a plain diffuse
   * surface, so a fantasy-console material that sets none renders exactly as
   * before — the AAA tier is purely additive (see AAA_TIER_ROADMAP.md).
   *
   * A packed metallic-roughness map, glTF's `metallicRoughnessTexture`
   * (G = roughness, B = metallic), or null/absent.
   */
  readonly metallicRoughnessImage?: EncodedImage | null;
  /** An ambient-occlusion map, glTF's `occlusionTexture` (R = AO), or null/absent. */
  readonly occlusionImage?: EncodedImage | null;
  /** An emissive map, glTF's `emissiveTexture` (RGB), or null/absent. */
  readonly emissiveImage?: EncodedImage | null;
  /**
   * A baked light map (RGB), sampled with the primitive's second UV set
   * ({@link MeshPrimitive.uvs2}): how much sky and bounced light reaches each
   * point, multiplying the ambient / image-based light (see lightBake.ts).
   * Null/absent: lit only by the scene's live lighting.
   */
  readonly lightmapImage?: EncodedImage | null;
  /**
   * The same bake as an HDR directional light map (AAA_FIDELITY_ROADMAP.md
   * F3d; see hdrLightmap.ts): the irradiance in linear light, where it comes
   * from, and how much sky reaches the point. The AAA tier lights by it in
   * place of the sky's irradiance; every other tier reads
   * {@link lightmapImage}. Null/absent: no GPU bake.
   */
  readonly lightmapHdrImage?: EncodedImage | null;
  /** Scalar metalness multiplier, glTF's `metallicFactor` (default 1). */
  readonly metallicFactor?: number;
  /** Scalar roughness multiplier, glTF's `roughnessFactor` (default 1). */
  readonly roughnessFactor?: number;
  /** RGB emissive multiplier, glTF's `emissiveFactor` (default [0,0,0]). */
  readonly emissiveFactor?: readonly [number, number, number];
  /**
   * The sprite-sheet region this texture is authored from, or null/absent for a
   * texture that is not sprite-backed (an imported mesh, a flat colour). Optional
   * so the many materials that never carry one — codecs, world tiles, flat
   * primitives — need not spell it out. See {@link SpriteTextureRef}.
   */
  readonly textureSprite?: SpriteTextureRef | null;
  /**
   * Whether a cart may recolour this material at runtime through a pose's tint
   * (`cartbox.meshpose(..., tint)`) — e.g. a character's armour paint, so one
   * mesh serves every team colour. Absent/false: tints never touch it.
   */
  readonly tintable?: boolean;
  /**
   * A team-colour mask by part (HALO_INFINITE_STYLE_ROADMAP.md I11): how much of
   * the tint a tintable material takes, 0..1 — 1 (absent) paints it the team
   * colour outright, less mixes the colour into its own, so trims and
   * secondary plates pick up only a hint of it.
   */
  readonly tintMix?: number;
  /**
   * A team-colour mask painted per texel (LOCKOUT_MULTIPLAYER_ROADMAP.md
   * L17): its red channel (0..255, sampled with the base UVs) is how much of
   * the tint each texel takes, times {@link tintMix} — the paint on a plate
   * but not its scuffs, a stripe of team colour on a helmet. Absent: the
   * whole part takes {@link tintMix} of it.
   */
  readonly tintMaskImage?: EncodedImage | null;
  // --- Surface effects (HALO2_STYLE_ROADMAP.md, H3; see materialEffects.ts) ---
  /**
   * A finely tiled detail map blended into the albedo up close (it fades out
   * with distance): mid-grey changes nothing, lighter brightens, darker grimes.
   */
  readonly detailImage?: EncodedImage | null;
  /** Detail tiles per base UV unit (default 8). */
  readonly detailScale?: number;
  /** How strongly the detail map shows, 0..1 (default 0.5). */
  readonly detailStrength?: number;
  /** Scroll the emissive map, UV units per second, so energy lines flow. */
  readonly emissiveScroll?: readonly [number, number];
  /** Pulse the emissive glow: `rate` cycles per second, dipping by `depth` (0..1) at the trough. */
  readonly emissivePulse?: { readonly rate: number; readonly depth: number };
  /** A fresnel rim: light of `color` × `strength` at grazing angles, tightening as `power` rises. */
  readonly rim?: { readonly color: readonly [number, number, number]; readonly power: number; readonly strength: number };
  /** Scales reflections of the sky and probes (default 1). */
  readonly reflectivity?: number;
  /** Mask reflections per texel by the metallic-roughness map's alpha (opaque = full). */
  readonly reflectionMask?: boolean;
  // --- A second surface blended in per vertex (HALO2_STYLE_ROADMAP.md H4) ---
  /**
   * Where a primitive carries per-vertex {@link MeshPrimitive.blend} weights,
   * its albedo and roughness mix toward this second surface by them — snow
   * drifting over rock without a hard edge between triangles. The image is
   * sampled with the same UVs; the colour multiplies it (or stands alone).
   */
  readonly blendImage?: EncodedImage | null;
  readonly blendColor?: readonly [number, number, number];
  readonly blendRoughness?: number;
  // --- The full material set (AAA_FIDELITY_ROADMAP.md F1d; see materialExtensions.ts) ---
  /** Sheen (KHR_materials_sheen): its colour, linear (absent or black is none), and roughness 0..1. */
  readonly sheenColor?: readonly [number, number, number];
  readonly sheenRoughness?: number;
  /** Transmission (KHR_materials_transmission), 0..1: the share of light let through rather than diffused. */
  readonly transmission?: number;
  /** The volume (KHR_materials_volume): its thickness in metres (0 thin-walled), and the colour light takes after `attenuationDistance` metres (linear). */
  readonly thickness?: number;
  readonly attenuationDistance?: number;
  readonly attenuationColor?: readonly [number, number, number];
  /** The index of refraction (KHR_materials_ior, default 1.5). */
  readonly ior?: number;
  /** The dielectric specular's strength and colour (KHR_materials_specular, linear; default 1 and white). */
  readonly specularFactor?: number;
  readonly specularColor?: readonly [number, number, number];
  /** A thin film (KHR_materials_iridescence): its strength 0..1, index (default 1.3) and thickness in nm (default 400). */
  readonly iridescence?: number;
  readonly iridescenceIor?: number;
  readonly iridescenceThickness?: number;
  /** The emission's strength past its factor (KHR_materials_emissive_strength, default 1). */
  readonly emissiveStrength?: number;
  /** The UVs' offset, rotation and scale (KHR_texture_transform), for every map. */
  readonly uvTransform?: { readonly offset: readonly [number, number]; readonly rotation: number; readonly scale: readonly [number, number] };
  /**
   * Subsurface scattering (F1d-2), 0..1: the share of the diffuse light that spreads under the surface (skin,
   * wax, marble, leaves), how far each channel goes as a colour (red farthest for skin), and the radius in metres.
   */
  readonly subsurface?: number;
  readonly subsurfaceColor?: readonly [number, number, number];
  readonly subsurfaceRadius?: number;
  /** Thin-surface transmission (KHR_materials_diffuse_transmission): the share of light from behind a leaf or a lampshade that comes through, and its tint (linear). */
  readonly diffuseTransmission?: number;
  readonly diffuseTransmissionColor?: readonly [number, number, number];
  // --- Layers and relief (HALO_INFINITE_STYLE_ROADMAP.md I4; see materialLayers.ts) ---
  /**
   * A clearcoat: a thin glossy lacquer over the base surface (armour paint, a
   * visor), with a reflection of its own that the base shows through, 0..1.
   * Absent or 0 is no coat. glTF's KHR_materials_clearcoat `clearcoatFactor`.
   */
  readonly clearcoat?: number;
  /** The coat's roughness, 0..1 (default 0.05, a fresh lacquer). */
  readonly clearcoatRoughness?: number;
  /**
   * Anisotropy, −1..1: highlights stretched across the surface's grain, as on
   * brushed metal. Positive stretches them along the tangent (the direction U
   * increases, turned by {@link anisotropyRotation}), negative along the
   * bitangent. Absent or 0 is an ordinary round highlight.
   */
  readonly anisotropy?: number;
  /** Turns the anisotropy's tangent about the normal, radians from U toward V (default 0). */
  readonly anisotropyRotation?: number;
  /**
   * A relief map (R = height, white the top; G = curvature about mid-grey,
   * lighter a convex edge, darker a cavity), sampled with the base UVs. Its
   * height gives panel seams depth by parallax occlusion ({@link parallaxDepth});
   * its curvature drives the material graph's wear masks.
   */
  /**
   * The smart-material stack that painted this material's maps (AAA_FIDELITY_ROADMAP.md
   * F9b; smartMaterials.ts), kept so it can be edited and painted again. Absent = none.
   */
  readonly smartStack?: SmartStack;
  readonly reliefImage?: EncodedImage | null;
  /** How deep the relief's darkest point sits, in world units (0..0.25); absent or 0 is flat. */
  readonly parallaxDepth?: number;
  // --- Refraction (HALO_INFINITE_STYLE_ROADMAP.md I5; see render/refraction.ts) ---
  /**
   * How strongly a see-through surface bends the view behind it by its normal,
   * 0..1 (glass, a plasma blade). Absent or 0 is a straight view through.
   */
  readonly refraction?: number;
  /** How strongly the view behind shimmers with drifting noise, 0..1 (heat haze, plasma). */
  readonly distortion?: number;
  // --- Water (BEAVER_CREEK_ROADMAP.md B5; see materialEffects.ts) ---
  /**
   * A moving water surface: ripples, in world space, that tilt the normal so
   * reflections and refraction wobble as the water flows. `strength` is how
   * steep the ripples are (0..2; absent or 0 is still), `scale` how many per
   * metre (0.05..8), `speed` how fast they drift (0..4), and `flow` the
   * direction they drift, radians about +Y from +X (a creek's current).
   */
  readonly water?: {
    readonly strength: number;
    readonly scale: number;
    readonly speed: number;
    readonly flow: number;
    /**
     * Ripples in the surface's UV space instead of the world's (EDITOR_PRO_ROADMAP.md
     * P3): with UVs in metres, U across and V along, `flow` π/2 drifts them along
     * V — down a river spline's course, round every bend.
     */
    readonly along?: boolean;
  };
  // --- Texture generators (EDITOR_PRO_ROADMAP.md P1c; see textureGenerators.ts) ---
  /**
   * A procedural surface (rock, cliff strata, grass, mud, worn stone,
   * Forerunner metal…) that fills the base colour, normal, metallic-roughness
   * and relief maps when the material loads. Only the recipe is stored: the
   * maps it bakes are left out when the material is saved.
   */
  readonly generator?: TextureGenerator;
  // --- Material instances (EDITOR_PRO_ROADMAP.md P1b; see materialInstances.ts) ---
  /**
   * This material is an instance of a parent in the cart's material library:
   * the editor fills every field it doesn't override from the parent, and
   * fills them again whenever the parent changes. The fields are kept here
   * too, so nothing but the editor needs the library.
   */
  readonly instance?: MaterialInstanceLink;
  // --- Living terrain (BEAVER_CREEK_ROADMAP.md B6; see materialEffects.ts) ---
  /**
   * Triplanar mapping: the base colour and blend maps are projected from the
   * three axes in the mesh's own space, one repeat every this many units, and
   * mixed by the surface's normal — so a cliff isn't streaked by a texture
   * laid flat from above. Flat ground looks exactly as planar mapping
   * (U = x, V = z, over the same repeat) would. Absent or 0 is off.
   */
  readonly triplanar?: number;
  /**
   * Height-blended transitions (0..1): where a second surface is blended in
   * per vertex, the lighter of the two (its "height") pokes through first and
   * the edge tightens, so rock juts through grass and snow fills the
   * hollows rather than both fading evenly. Absent or 0 is an even mix.
   */
  readonly blendSharpness?: number;
  // --- Landscape materials (EDITOR_PRO_ROADMAP.md P2b; see materialEffects.ts) ---
  /**
   * Macro variation: the base colour drifts lighter and darker in broad,
   * soft patches `scale` units across (in the mesh's own space), by up to
   * `strength` (0..1), so a tiled texture doesn't repeat visibly across a
   * valley. Absent is none.
   */
  readonly macro?: { readonly scale: number; readonly strength: number };
  /**
   * Distance tiling: from a quarter of this view distance (world units) out to
   * it, the base map blends to itself tiled four times larger, so far ground
   * shows broad shapes rather than a fine repeating grid. Absent or 0 is off.
   */
  readonly farTile?: number;
  // --- Transparency (ENGINE_PARITY_ROADMAP.md EP6), glTF's alphaMode plus additive ---
  /**
   * How the surface's alpha (base colour factor × texture) is used. Absent is
   * opaque. "mask" drops texels below {@link alphaCutoff} (foliage, grilles);
   * "blend" is see-through (glass, water, smoke), drawn after everything
   * opaque, farthest first, without hiding what's behind it; "additive" adds
   * its light to what's behind (glows, energy, sparks).
   */
  readonly alphaMode?: "mask" | "blend" | "additive";
  /** The alpha below which a "mask" surface is dropped (default 0.5). */
  readonly alphaCutoff?: number;
  /**
   * Soft edges (EP6b): a blended or added surface fades out over this many
   * world units as it nears the opaque surface behind it, so smoke and glows
   * meet the floor and walls without a hard line. Absent or 0 is a hard edge.
   */
  readonly softDepth?: number;
  /**
   * A material graph (EP7): nodes wired into the base colour, alpha,
   * emissive, metallic and roughness, replacing the material's own values for
   * whichever it drives. A material with a graph always takes the PBR path.
   */
  readonly graph?: MaterialGraph;
  /** This material's settings of the graph's static switches (F1e), over the graph's defaults: a permutation of its own. */
  readonly graphSwitches?: Readonly<Record<string, boolean>>;
  /** The images the graph's texture nodes sample besides the base map (F1e), slot 1 first. */
  readonly graphImages?: readonly (EncodedImage | null)[];
}

/** One triangle list with a single material. */
export interface MeshPrimitive {
  /** Interleave-free vertex positions, `x,y,z` per vertex. */
  readonly positions: Float32Array;
  /** Per-vertex normals (`x,y,z`), or null when the source had none. */
  readonly normals: Float32Array | null;
  /**
   * Per-vertex tangents (`x,y,z,w`, glTF's TANGENT), the frame a normal map was
   * baked in (AAA_FIDELITY_ROADMAP.md F1c): MikkTSpace, from the file or made
   * on import (tangents.ts), with the bitangent `w · (normal × tangent)`
   * pointing up the image (+V, as the engine samples at 1 − V; glTF's V is
   * flipped into this on import and back on export, so its w carries over). The
   * AAA tier's shader decodes normal maps with them; every other path, and a
   * primitive without them, takes the tangent from the UVs' screen derivatives.
   */
  readonly tangents?: Float32Array | null;
  /** Per-vertex weight (0..1) of the material's blend surface ({@link MeshMaterial.blendImage}), or absent. */
  readonly blend?: Float32Array;
  /** Per-vertex texture coordinates (`u,v`), or null when untextured. */
  readonly uvs: Float32Array | null;
  /**
   * Per-vertex sway (B6; see wind.ts): how far each vertex bends in the
   * scene's wind, metres per unit of wind — zero at a plant's root, more toward
   * its tip. Absent is stiff. Built when a scene loads (foliage), not stored.
   */
  readonly sway?: Float32Array;
  /** Triangle vertex indices (three per triangle) into the attribute streams. */
  readonly indices: Uint32Array;
  readonly material: MeshMaterial;
  /**
   * A second set of texture coordinates, unique per surface point, that the
   * material's light map is sampled with (the first set tiles). Null/absent
   * without a light map.
   */
  readonly uvs2?: Float32Array | null;
  /**
   * Skinned meshes only (see skeleton.ts): four joint indices and four weights
   * per vertex, binding it to the mesh's {@link MeshAsset.skin}.
   */
  readonly joints?: Uint16Array | null;
  readonly weights?: Float32Array | null;
  /**
   * Set on a live skinned copy whose positions/normals are rewritten each frame:
   * renderers that cache uploaded geometry re-upload when `revision` changes.
   * Never serialized.
   */
  readonly dynamic?: {
    revision: number;
    /**
     * Skinned on the GPU (F7a; gpuSkinning.ts in @cartbox/player): the pose's joint matrices and the morph
     * weights the renderer's compute pass applies, in place of positions rewritten on the CPU.
     */
    gpu?: { readonly matrices: Float32Array; readonly morphWeights: Float32Array | null; readonly dualQuaternion: boolean };
  };
  /** Morph targets (F7a; morphTargets.ts): deltas from this shape, blended by the mesh's weights before skinning. */
  readonly morphTargets?: readonly MorphTarget[];
}

/** A named mesh: one or more primitives in a shared object space. */
export interface MeshAsset {
  readonly name: string;
  readonly primitives: readonly MeshPrimitive[];
  /** The skeleton skinned primitives are bound to (ENGINE_ROADMAP.md, Phase 3), if any. */
  readonly skin?: MeshSkin | null;
  /** The morph targets' default weights (F7a; glTF's mesh weights), by target index. */
  readonly morphWeights?: readonly number[];
  /** Skin by dual quaternions (F7a), keeping a twisting joint's volume, rather than by blending matrices. */
  readonly dualQuaternion?: boolean;
  /** Animation clips that move the skeleton. */
  readonly clips?: readonly AnimationClip[];
  /** Ribbons of light the mesh leaves as parts of it sweep (I10; see meshTrails.ts). */
  readonly trails?: readonly MeshTrail[];
  /** Named material sets (I13): glTF's KHR_materials_variants, chosen per placed copy. */
  readonly variants?: readonly MeshVariant[];
}

/**
 * A material set (HALO_INFINITE_STYLE_ROADMAP.md I13): an alternative
 * material for some of the mesh's primitives — another armour finish, a
 * damaged look, a team's livery — as an artist exports it with
 * KHR_materials_variants. `materials` runs parallel to the primitives; null
 * keeps a primitive's own material.
 */
export interface MeshVariant {
  readonly name: string;
  readonly materials: readonly (MeshMaterial | null)[];
}

/** The most material sets a mesh keeps. */
export const MAX_MESH_VARIANTS = 16;

/** `mesh` wearing its material set `name` (unchanged when it has no such set). */
export function applyMeshVariant(mesh: MeshAsset, name: string | undefined): MeshAsset {
  const variant = name ? mesh.variants?.find((v) => v.name === name) : undefined;
  if (!variant) return mesh;
  return { ...mesh, primitives: mesh.primitives.map((p, i) => (variant.materials[i] ? { ...p, material: variant.materials[i]! } : p)) };
}

/** A neutral, fully-opaque white material — the default when a source names none. */
export function defaultMaterial(name = "default"): MeshMaterial {
  return { name, baseColorFactor: [1, 1, 1, 1], baseColorImage: null, textureSprite: null };
}

/**
 * Return a copy of `mesh` with one primitive's material patched — the pure edit
 * behind the material editor (Phase 6). Only the named fields change; the rest of
 * the material (its textures, sprite ref) and every other primitive are shared by
 * reference, so an edit allocates only the changed primitive. An out-of-range
 * index returns the mesh unchanged.
 */
export function updateMeshMaterial(
  mesh: MeshAsset,
  primitiveIndex: number,
  patch: Partial<MeshMaterial>,
): MeshAsset {
  if (primitiveIndex < 0 || primitiveIndex >= mesh.primitives.length) return mesh;
  return {
    ...mesh,
    primitives: mesh.primitives.map((primitive, i) =>
      i === primitiveIndex ? { ...primitive, material: { ...primitive.material, ...patch } } : primitive,
    ),
  };
}

/** Total vertices across every primitive. */
export function meshVertexCount(mesh: MeshAsset): number {
  return mesh.primitives.reduce((sum, primitive) => sum + primitive.positions.length / 3, 0);
}

/** Total triangles across every primitive. */
export function meshTriangleCount(mesh: MeshAsset): number {
  return mesh.primitives.reduce((sum, primitive) => sum + primitive.indices.length / 3, 0);
}

/** The axis-aligned bounds of every vertex, or null for an empty mesh. */
export interface MeshBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Compute the mesh's world-space AABB — what the editor frames and the importer fits. */
export function meshBounds(mesh: MeshAsset): MeshBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const primitive of mesh.primitives) {
    const p = primitive.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!;
      const y = p[i + 1]!;
      const z = p[i + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (minX > maxX) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Derive per-vertex normals by area-weighted averaging of the adjacent triangle
 * faces — the standard fallback for geometry that arrived without normals, so the
 * rasteriser and the preview always have a surface direction to light. Averaging
 * keeps the shared-vertex indexing intact (flat shading would require splitting
 * every vertex); the weighting falls out of using the un-normalised cross
 * product, whose length is twice the triangle area.
 */
export function computeSmoothNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]! * 3;
    const ib = indices[t + 1]! * 3;
    const ic = indices[t + 2]! * 3;
    const ax = positions[ia]!;
    const ay = positions[ia + 1]!;
    const az = positions[ia + 2]!;
    const ex1 = positions[ib]! - ax;
    const ey1 = positions[ib + 1]! - ay;
    const ez1 = positions[ib + 2]! - az;
    const ex2 = positions[ic]! - ax;
    const ey2 = positions[ic + 1]! - ay;
    const ez2 = positions[ic + 2]! - az;
    // Face normal (un-normalised): its magnitude weights by twice the face area.
    const nx = ey1 * ez2 - ez1 * ey2;
    const ny = ez1 * ex2 - ex1 * ez2;
    const nz = ex1 * ey2 - ey1 * ex2;
    for (const base of [ia, ib, ic]) {
      normals[base] = normals[base]! + nx;
      normals[base + 1] = normals[base + 1]! + ny;
      normals[base + 2] = normals[base + 2]! + nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
    normals[i] = normals[i]! / length;
    normals[i + 1] = normals[i + 1]! / length;
    normals[i + 2] = normals[i + 2]! / length;
  }
  return normals;
}

// --- Serialization --------------------------------------------------------

/** LE base64 of a Float32Array's exact bytes (all target platforms are little-endian). */
function f32ToBase64(array: Float32Array): string {
  return bytesToBase64(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
}
function base64ToF32(base64: string): Float32Array {
  const bytes = base64ToBytes(base64);
  // Copy into a fresh, 4-aligned buffer — a decoded byte array need not be aligned.
  return new Float32Array(bytes.slice().buffer);
}
function u32ToBase64(array: Uint32Array): string {
  return bytesToBase64(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
}
function base64ToU32(base64: string): Uint32Array {
  const bytes = base64ToBytes(base64);
  return new Uint32Array(bytes.slice().buffer);
}

interface SerializedImage {
  mime: string;
  bytes?: string;
  ref?: string;
  /**
   * The same image as an earlier slot of this mesh, named `<primitive>.<field>`
   * (`"0.lightmapImage"`), so it is stored once — a light map shared by every
   * primitive of a mesh, say.
   */
  same?: string;
  /** An asset-store reference (content hash) in place of `bytes` (see meshTextureAssets.ts in the web app). */
  asset?: string;
  /** The image as KTX2, base64 (see EncodedImage.ktx2), and whether it is packed with its relief map. */
  ktx2?: string;
  ktx2Relief?: boolean;
}
export interface SerializedMaterial {
  name: string;
  baseColorFactor: [number, number, number, number];
  image: SerializedImage | null;
  normalImage?: SerializedImage | null;
  materialImage?: SerializedImage | null;
  metallicRoughnessImage?: SerializedImage | null;
  occlusionImage?: SerializedImage | null;
  emissiveImage?: SerializedImage | null;
  lightmapImage?: SerializedImage | null;
  lightmapHdrImage?: SerializedImage | null;
  metallicFactor?: number;
  roughnessFactor?: number;
  emissiveFactor?: [number, number, number];
  textureSprite?: SpriteTextureRef | null;
  tintable?: boolean;
  tintMix?: number;
  tintMaskImage?: SerializedImage | null;
  detailImage?: SerializedImage | null;
  detailScale?: number;
  detailStrength?: number;
  emissiveScroll?: [number, number];
  emissivePulse?: { rate: number; depth: number };
  rim?: { color: [number, number, number]; power: number; strength: number };
  reflectivity?: number;
  reflectionMask?: boolean;
  blendImage?: SerializedImage | null;
  reliefImage?: SerializedImage | null;
  sheenColor?: readonly [number, number, number];
  sheenRoughness?: number;
  transmission?: number;
  thickness?: number;
  attenuationDistance?: number;
  attenuationColor?: readonly [number, number, number];
  ior?: number;
  specularFactor?: number;
  specularColor?: readonly [number, number, number];
  iridescence?: number;
  iridescenceIor?: number;
  iridescenceThickness?: number;
  emissiveStrength?: number;
  uvTransform?: { readonly offset: readonly [number, number]; readonly rotation: number; readonly scale: readonly [number, number] };
  subsurface?: number;
  subsurfaceColor?: readonly [number, number, number];
  subsurfaceRadius?: number;
  diffuseTransmission?: number;
  diffuseTransmissionColor?: readonly [number, number, number];
  clearcoat?: number;
  clearcoatRoughness?: number;
  anisotropy?: number;
  anisotropyRotation?: number;
  parallaxDepth?: number;
  blendColor?: [number, number, number];
  blendRoughness?: number;
  alphaMode?: "mask" | "blend" | "additive";
  alphaCutoff?: number;
  softDepth?: number;
  refraction?: number;
  distortion?: number;
  water?: { strength: number; scale: number; speed: number; flow: number };
  triplanar?: number;
  blendSharpness?: number;
  generator?: { kind: string; seed: number; scale: number; tint: [number, number, number]; size: number };
  graph?: MaterialGraph;
  graphSwitches?: Readonly<Record<string, boolean>>;
  graphImages?: (SerializedImage | null)[];
  instance?: { of: string; overrides: string[] };
}
interface SerializedPrimitive {
  positions: string;
  normals: string | null;
  uvs: string | null;
  uvs2?: string;
  blend?: string;
  tangents?: string;
  indices: string;
  material: SerializedMaterial;
  joints?: string;
  weights?: string;
  /** In place of joints and weights: the one joint every vertex rides wholly. */
  bone?: number;
  /** In place of joints and weights: each vertex's one joint (a byte each), every weight 1. */
  bones?: string;
  /** Morph targets (F7a): position (and normal) deltas, and a corrective's driver. */
  morphTargets?: { name: string; positions: string; normals?: string; driver?: { joint: number; angles: number[] } }[];
}
interface SerializedJoint {
  name: string;
  parent: number;
  t: number[];
  r: number[];
  s: number[];
  base?: number[];
}
interface SerializedClip {
  name: string;
  duration: number;
  channels: { joint: number; path: string; interp?: string; times: string; values: string }[];
  /** The dope sheet's keys (L16): joint, time, ease (absent = linear) and a curve's handles. */
  keys?: { j: number; t: number; e?: string; c?: number[] }[];
}
interface SerializedMesh {
  version: number;
  name: string;
  primitives: SerializedPrimitive[];
  skin?: { joints: SerializedJoint[]; inverseBind: string };
  clips?: SerializedClip[];
  trails?: MeshTrail[];
  variants?: { name: string; materials: (SerializedMaterial | null)[] }[];
  morphWeights?: number[];
  dualQuaternion?: boolean;
}

function u16ToBase64(array: Uint16Array): string {
  return bytesToBase64(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
}
function base64ToU16(base64: string): Uint16Array {
  const bytes = base64ToBytes(base64);
  if (bytes.length % 2 !== 0) throw new Error("Mesh asset payload is malformed");
  return new Uint16Array(bytes.slice().buffer);
}

function serializeSkin(skin: MeshSkin): NonNullable<SerializedMesh["skin"]> {
  return {
    joints: skin.joints.map((j) => ({
      name: j.name,
      parent: j.parent,
      t: [...j.translation],
      r: [...j.rotation],
      s: [...j.scale],
      ...(j.base ? { base: [...j.base] } : {}),
    })),
    inverseBind: f32ToBase64(skin.inverseBind),
  };
}

function serializeClip(clip: AnimationClip): SerializedClip {
  return {
    name: clip.name,
    duration: clip.duration,
    channels: clip.channels.map((c) => ({
      joint: c.joint,
      path: c.path,
      ...(c.interpolation === "step" ? { interp: "step" } : {}),
      times: f32ToBase64(c.times),
      values: f32ToBase64(c.values),
    })),
    ...(clip.keys && clip.keys.length > 0
      ? { keys: clip.keys.map((k) => ({ j: k.joint, t: k.time, ...(k.ease !== "linear" ? { e: k.ease } : {}), ...(k.ease === "curve" && k.curve ? { c: [...k.curve] } : {}) })) }
      : {}),
  };
}

const finiteList = (value: unknown, length: number): number[] | null =>
  Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? (value as number[]) : null;

/** Validate an untrusted skeleton: parents in range and acyclic, one inverse bind per joint. */
function deserializeSkin(raw: unknown): MeshSkin | null {
  if (!raw || typeof raw !== "object") return null;
  const { joints, inverseBind } = raw as { joints?: unknown; inverseBind?: unknown };
  if (!Array.isArray(joints) || joints.length === 0 || joints.length > MAX_SKIN_JOINTS || typeof inverseBind !== "string") {
    throw new Error("Mesh asset payload is malformed");
  }
  const n = joints.length;
  const out: SkinJoint[] = joints.map((j: SerializedJoint) => {
    const t = finiteList(j?.t, 3);
    const r = finiteList(j?.r, 4);
    const sc = finiteList(j?.s, 3);
    const parent = typeof j?.parent === "number" && Number.isInteger(j.parent) && j.parent >= -1 && j.parent < n ? j.parent : null;
    if (!t || !r || !sc || parent === null) throw new Error("Mesh asset payload is malformed");
    const base = finiteList(j.base, 16);
    return {
      name: typeof j.name === "string" ? j.name.slice(0, 64) : "joint",
      parent,
      translation: [t[0]!, t[1]!, t[2]!],
      rotation: [r[0]!, r[1]!, r[2]!, r[3]!],
      scale: [sc[0]!, sc[1]!, sc[2]!],
      ...(base ? { base } : {}),
    };
  });
  // No cycles: every chain of parents reaches a root within n steps.
  out.forEach((_, start) => {
    let j = start;
    for (let steps = 0; j >= 0; steps += 1) {
      if (steps > n) throw new Error("Mesh asset payload is malformed");
      j = out[j]!.parent;
    }
  });
  const ibm = base64ToF32(inverseBind);
  if (ibm.length !== n * 16) throw new Error("Mesh asset payload is malformed");
  return { joints: out, inverseBind: ibm };
}

/**
 * A primitive's skin binding as stored: just the joint when every vertex rides
 * that one joint wholly (a rigid part, the way held weapons are bound — a few
 * bytes instead of 24 a vertex); a byte a vertex when each rides one joint but
 * not all the same (plates bound piece by piece); else every vertex's four
 * joints and weights.
 */
function serializeBinding(joints: Uint16Array, weights: Float32Array): { bone: number } | { bones: string } | { joints: string; weights: string } {
  const count = joints.length / 4;
  const bone = joints[0] ?? 0;
  let same = count > 0;
  let single = count > 0;
  for (let v = 0; single && v < count; v += 1) {
    single = weights[v * 4] === 1 && weights[v * 4 + 1] === 0 && weights[v * 4 + 2] === 0 && weights[v * 4 + 3] === 0 && joints[v * 4]! < 256;
    same = same && joints[v * 4] === bone;
  }
  if (single && same) return { bone };
  // Every vertex on one joint, but not all the same one (plates bound piece by piece): a byte each.
  if (single) {
    const bytes = new Uint8Array(count);
    for (let v = 0; v < count; v += 1) bytes[v] = joints[v * 4]!;
    return { bones: bytesToBase64(bytes) };
  }
  return { joints: u16ToBase64(joints), weights: f32ToBase64(weights) };
}

/** Validate untrusted clips against a skeleton of `jointCount` joints. */
function deserializeClips(raw: unknown, jointCount: number): AnimationClip[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_CLIPS) throw new Error("Mesh asset payload is malformed");
  let keys = 0;
  return raw.map((clip: SerializedClip) => {
    if (!clip || !Array.isArray(clip.channels)) throw new Error("Mesh asset payload is malformed");
    const channels: ClipChannel[] = clip.channels.map((c) => {
      const path = c?.path === "translation" || c?.path === "rotation" || c?.path === "scale" ? c.path : null;
      if (!path || !Number.isInteger(c.joint) || c.joint < 0 || c.joint >= jointCount) throw new Error("Mesh asset payload is malformed");
      const times = base64ToF32(c.times);
      const values = base64ToF32(c.values);
      const width = path === "rotation" ? 4 : 3;
      if (times.length === 0 || values.length !== times.length * width) throw new Error("Mesh asset payload is malformed");
      for (let i = 0; i < times.length; i += 1) {
        if (!Number.isFinite(times[i]!) || (i > 0 && times[i]! < times[i - 1]!)) throw new Error("Mesh asset payload is malformed");
      }
      if (!values.every(Number.isFinite)) throw new Error("Mesh asset payload is malformed");
      keys += times.length;
      if (keys > MAX_CLIP_KEYS) throw new Error("Mesh asset payload is malformed");
      return { joint: c.joint, path, interpolation: c.interp === "step" ? "step" : "linear", times, values };
    });
    const duration = typeof clip.duration === "number" && Number.isFinite(clip.duration) ? Math.max(0, clip.duration) : 0;
    // The dope sheet's keys: kept where they make sense, the rest dropped (the channels still play).
    const authored: ClipKey[] = [];
    if (Array.isArray(clip.keys)) {
      for (const k of clip.keys.slice(0, Math.max(0, MAX_CLIP_KEYS - keys))) {
        if (!k || !Number.isInteger(k.j) || k.j < 0 || k.j >= jointCount || typeof k.t !== "number" || !Number.isFinite(k.t)) continue;
        const ease = k.e === "smooth" || k.e === "step" || k.e === "curve" ? k.e : "linear";
        const c = Array.isArray(k.c) && k.c.length === 4 && k.c.every((v) => typeof v === "number" && Number.isFinite(v)) ? k.c : null;
        authored.push({
          joint: k.j,
          time: Math.max(0, k.t),
          ease,
          ...(ease === "curve" ? { curve: c ? [Math.max(0, Math.min(1, c[0]!)), Math.max(-1, Math.min(2, c[1]!)), Math.max(0, Math.min(1, c[2]!)), Math.max(-1, Math.min(2, c[3]!))] : [0.42, 0, 0.58, 1] } : {}),
        });
      }
      keys += authored.length;
    }
    return { name: typeof clip.name === "string" ? clip.name.slice(0, 64) : "clip", duration, channels, ...(authored.length > 0 ? { keys: authored } : {}) };
  });
}

/** Serialize a mesh to a compact JSON string for storage in a cart sidecar. */
export function serializeMeshAsset(mesh: MeshAsset): string {
  const images = newImageTable();
  const payload: SerializedMesh = {
    version: MESH_ASSET_VERSION,
    name: mesh.name,
    primitives: mesh.primitives.map((primitive, index) => ({
      positions: f32ToBase64(primitive.positions),
      normals: primitive.normals ? f32ToBase64(primitive.normals) : null,
      uvs: primitive.uvs ? f32ToBase64(primitive.uvs) : null,
      ...(primitive.uvs2 ? { uvs2: f32ToBase64(primitive.uvs2) } : {}),
      ...(primitive.blend ? { blend: f32ToBase64(primitive.blend) } : {}),
      ...(primitive.tangents ? { tangents: f32ToBase64(primitive.tangents) } : {}),
      indices: u32ToBase64(primitive.indices),
      material: serializeMaterial(primitive.material, Object.assign(images, { primitive: index })),
      ...(primitive.joints && primitive.weights && mesh.skin ? serializeBinding(primitive.joints, primitive.weights) : {}),
      ...(primitive.morphTargets?.length
        ? {
            morphTargets: primitive.morphTargets.slice(0, MAX_MORPH_TARGETS).map((t) => ({
              name: t.name,
              positions: f32ToBase64(t.positions),
              ...(t.normals ? { normals: f32ToBase64(t.normals) } : {}),
              ...(t.driver ? { driver: { joint: t.driver.joint, angles: [t.driver.angles[0], t.driver.angles[1]] } } : {}),
            })),
          }
        : {}),
    })),
    ...(mesh.morphWeights?.length ? { morphWeights: [...mesh.morphWeights] } : {}),
    ...(mesh.dualQuaternion ? { dualQuaternion: true } : {}),
    ...(mesh.skin ? { skin: serializeSkin(mesh.skin) } : {}),
    ...(mesh.skin && mesh.clips && mesh.clips.length > 0 ? { clips: mesh.clips.map(serializeClip) } : {}),
    ...(mesh.trails && mesh.trails.length > 0 ? { trails: mesh.trails.map((t) => ({ ...t, from: [...t.from], to: [...t.to], color: [...t.color] })) } : {}),
    // Material sets after the primitives, so an image a set shares with them is stored once.
    ...(mesh.variants && mesh.variants.length > 0
      ? {
          variants: mesh.variants.slice(0, MAX_MESH_VARIANTS).map((v, k) => ({
            name: v.name,
            materials: mesh.primitives.map((_, i) => {
              const m = v.materials[i];
              return m ? serializeMaterial(m, Object.assign(images, { primitive: `v${k}.${i}` })) : null;
            }),
          })),
        }
      : {}),
  };
  return JSON.stringify(payload);
}

/**
 * The images of one mesh as they are written (each distinct image object once,
 * under the slot it first fills) and read back (by slot), so an image several
 * primitives share is stored once and comes back as one shared object.
 */
interface ImageTable {
  readonly written: Map<EncodedImage, string>;
  readonly read: Map<string, EncodedImage>;
  /** The primitive whose material is being written or read (a material set's: "v<set>.<primitive>"). */
  primitive: number | string;
}
const newImageTable = (): ImageTable => ({ written: new Map(), read: new Map(), primitive: 0 });

/** Encode an optional image to the serialized form (null when absent). */
function serializeImage(image: EncodedImage | null | undefined, field: string, table?: ImageTable): SerializedImage | null {
  if (!image) return null;
  const same = table?.written.get(image);
  if (same !== undefined) return { mime: image.mime, same };
  table?.written.set(image, `${table.primitive}.${field}`);
  return { mime: image.mime, bytes: bytesToBase64(image.bytes), ...(image.ref ? { ref: image.ref } : {}), ...(image.ktx2 ? { ktx2: bytesToBase64(image.ktx2), ...(image.ktx2Relief ? { ktx2Relief: true } : {}) } : {}) };
}
/** Decode an optional serialized image back to bytes (null when absent). */
function deserializeImage(image: SerializedImage | null | undefined, field: string, table?: ImageTable): EncodedImage | null {
  if (!image) return null;
  if (image.same !== undefined) return (typeof image.same === "string" && table?.read.get(image.same)) || null;
  const decoded = decodeImage(image);
  table?.read.set(`${table.primitive}.${field}`, decoded);
  return decoded;
}
function decodeImage(image: SerializedImage): EncodedImage {
  // A texture whose bytes live elsewhere — a streamed placeholder (`ref`) or an
  // asset-store reference (`asset`, its content hash) — decodes to a
  // placeholder the player fills in when the bytes arrive.
  const ref = typeof image.ref === "string" ? image.ref : typeof image.asset === "string" ? image.asset : undefined;
  return {
    mime: String(image.mime ?? "image/png"),
    bytes: base64ToBytes(image.bytes ?? ""),
    ...(ref ? { ref } : {}),
    ...(typeof image.ktx2 === "string" && image.ktx2.length > 0 ? { ktx2: base64ToBytes(image.ktx2), ...(image.ktx2Relief === true ? { ktx2Relief: true } : {}) } : {}),
  };
}

const MALFORMED = "Mesh asset payload is malformed";

function toColor(value: unknown): [number, number, number, number] {
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number")) {
    return [value[0], value[1], value[2], value[3]] as [number, number, number, number];
  }
  return [1, 1, 1, 1];
}

/** Validate an optional emissive factor triple, dropping anything malformed. */
function toEmissiveFactor(value: unknown): [number, number, number] | undefined {
  if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return [value[0], value[1], value[2]] as [number, number, number];
  }
  return undefined;
}

/** Validate an untrusted sprite-texture reference, dropping anything malformed. */
function toTextureSprite(value: unknown): SpriteTextureRef | null {
  if (!value || typeof value !== "object") return null;
  const ref = value as Record<string, unknown>;
  const nums = [ref.page, ref.x, ref.y, ref.width, ref.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  if ((ref.width as number) <= 0 || (ref.height as number) <= 0) return null;
  return {
    page: ref.page as number,
    x: ref.x as number,
    y: ref.y as number,
    width: ref.width as number,
    height: ref.height as number,
  };
}

/** Encode a material (with its images) to the stored form — shared with the terrain codec. */
export function serializeMaterial(material: MeshMaterial, table?: ImageTable): SerializedMaterial {
  // A generator's maps are baked again on load (P1c): store the recipe, not them.
  const own = (image: EncodedImage | null | undefined) => (material.generator && isGeneratedImage(image) ? null : image);
  return {
    name: material.name,
    baseColorFactor: [...material.baseColorFactor],
    image: serializeImage(own(material.baseColorImage), "image", table),
    normalImage: serializeImage(own(material.normalImage), "normalImage", table),
    materialImage: serializeImage(material.materialImage, "materialImage", table),
    metallicRoughnessImage: serializeImage(own(material.metallicRoughnessImage), "metallicRoughnessImage", table),
    occlusionImage: serializeImage(material.occlusionImage, "occlusionImage", table),
    emissiveImage: serializeImage(material.emissiveImage, "emissiveImage", table),
    ...(material.lightmapImage ? { lightmapImage: serializeImage(material.lightmapImage, "lightmapImage", table) } : {}),
    ...(material.lightmapHdrImage ? { lightmapHdrImage: serializeImage(material.lightmapHdrImage, "lightmapHdrImage", table) } : {}),
    metallicFactor: material.metallicFactor,
    roughnessFactor: material.roughnessFactor,
    emissiveFactor: material.emissiveFactor ? [...material.emissiveFactor] : undefined,
    textureSprite: material.textureSprite ?? null,
    ...(material.tintable ? { tintable: true } : {}),
    ...(material.tintable && material.tintMix !== undefined && material.tintMix < 1 ? { tintMix: material.tintMix } : {}),
    ...(material.tintMaskImage ? { tintMaskImage: serializeImage(material.tintMaskImage, "tintMaskImage", table) } : {}),
    ...(material.detailImage ? { detailImage: serializeImage(material.detailImage, "detailImage", table) } : {}),
    ...(material.blendImage ? { blendImage: serializeImage(material.blendImage, "blendImage", table) } : {}),
    ...(own(material.reliefImage) ? { reliefImage: serializeImage(material.reliefImage, "reliefImage", table) } : {}),
    ...(material.graphImages?.length ? { graphImages: material.graphImages.slice(0, 8).map((image, i) => serializeImage(image, `graphImage${i}`, table)) } : {}),
    ...(material.generator ? { generator: { kind: material.generator.kind, seed: material.generator.seed, scale: material.generator.scale, tint: [material.generator.tint[0], material.generator.tint[1], material.generator.tint[2]], size: material.generator.size } } : {}),
    ...(material.instance ? { instance: { of: material.instance.of, overrides: [...material.instance.overrides] } } : {}),
    ...writeSurfaceEffects(material),
    ...writeMaterialLayers(material),
    ...writeMaterialExtensions(material),
    ...writeSmartStack(material),
  };
}

/** Decode a stored material defensively (anything missing falls back to the default). */
export function deserializeMaterial(value: unknown, table?: ImageTable): MeshMaterial {
  const material = (value && typeof value === "object" ? value : { name: "default", baseColorFactor: [1, 1, 1, 1], image: null }) as SerializedMaterial;
  const generator = readGenerator(material.generator);
  const instance = readInstanceLink(material.instance);
  return withGeneratedMaps({
    ...(generator ? { generator } : {}),
    ...(instance ? { instance } : {}),
    name: typeof material.name === "string" ? material.name : "default",
    baseColorFactor: toColor(material.baseColorFactor),
    baseColorImage: deserializeImage(material.image, "image", table),
    normalImage: deserializeImage(material.normalImage, "normalImage", table),
    materialImage: deserializeImage(material.materialImage, "materialImage", table),
    metallicRoughnessImage: deserializeImage(material.metallicRoughnessImage, "metallicRoughnessImage", table),
    occlusionImage: deserializeImage(material.occlusionImage, "occlusionImage", table),
    emissiveImage: deserializeImage(material.emissiveImage, "emissiveImage", table),
    ...(material.lightmapImage ? { lightmapImage: deserializeImage(material.lightmapImage, "lightmapImage", table) } : {}),
    ...(material.lightmapHdrImage ? { lightmapHdrImage: deserializeImage(material.lightmapHdrImage, "lightmapHdrImage", table) } : {}),
    metallicFactor: typeof material.metallicFactor === "number" ? material.metallicFactor : undefined,
    roughnessFactor: typeof material.roughnessFactor === "number" ? material.roughnessFactor : undefined,
    emissiveFactor: toEmissiveFactor(material.emissiveFactor),
    textureSprite: toTextureSprite(material.textureSprite),
    ...(material.tintable === true ? { tintable: true } : {}),
    ...(material.tintable === true && typeof material.tintMix === "number" && Number.isFinite(material.tintMix) && material.tintMix < 1 ? { tintMix: Math.max(0, material.tintMix) } : {}),
    ...(material.tintMaskImage ? { tintMaskImage: deserializeImage(material.tintMaskImage, "tintMaskImage", table) } : {}),
    ...(material.detailImage ? { detailImage: deserializeImage(material.detailImage, "detailImage", table) } : {}),
    ...(material.blendImage ? { blendImage: deserializeImage(material.blendImage, "blendImage", table) } : {}),
    ...(material.reliefImage ? { reliefImage: deserializeImage(material.reliefImage, "reliefImage", table) } : {}),
    ...(Array.isArray(material.graphImages) && material.graphImages.length > 0 ? { graphImages: material.graphImages.slice(0, 8).map((image, i) => deserializeImage(image, `graphImage${i}`, table)) } : {}),
    ...readSurfaceEffects(material),
    ...readMaterialLayers(material),
    ...readMaterialExtensions(material),
    ...(readSmartStack((material as { smartStack?: unknown }).smartStack) ? { smartStack: readSmartStack((material as { smartStack?: unknown }).smartStack)! } : {}),
  });
}

/**
 * A material's generator (P1c) put to work: its maps baked (memoised) into
 * every slot it fills that holds nothing else — or, with `replace`, into every
 * one of them (the editor, when a creator picks a new recipe).
 */
export function withGeneratedMaps(material: MeshMaterial, replace = false): MeshMaterial {
  const g = material.generator;
  if (!g) return material;
  const maps = generateTextures(g);
  const pick = (current: EncodedImage | null | undefined, made: EncodedImage) => (replace || !current ? made : current);
  return {
    ...material,
    baseColorImage: pick(material.baseColorImage, maps.albedo),
    normalImage: pick(material.normalImage, maps.normal),
    metallicRoughnessImage: pick(material.metallicRoughnessImage, maps.metallicRoughness),
    reliefImage: pick(material.reliefImage, maps.relief),
  };
}

/**
 * Parse a serialized mesh, rejecting anything malformed or oversized — the bytes
 * are untrusted (another user's cart, or an arbitrary file). Every attribute
 * stream is length-checked against the others so a consumer can index it without
 * its own bounds checks, and every triangle index is verified in range.
 */
export function deserializeMeshAsset(json: string): MeshAsset {
  const raw = JSON.parse(json) as Partial<SerializedMesh>;
  if (raw.version !== MESH_ASSET_VERSION) throw new Error(`Unsupported mesh asset version: ${String(raw.version)}`);
  if (!Array.isArray(raw.primitives)) throw new Error(MALFORMED);

  let totalVertices = 0;
  let totalIndices = 0;
  const images = newImageTable();
  const skin = raw.skin ? deserializeSkin(raw.skin) : null;
  const primitives: MeshPrimitive[] = raw.primitives.map((entry, index) => {
    const positions = base64ToF32(entry.positions);
    if (positions.length === 0 || positions.length % 3 !== 0) throw new Error(MALFORMED);
    const vertexCount = positions.length / 3;

    const normals = entry.normals ? base64ToF32(entry.normals) : null;
    if (normals && normals.length !== vertexCount * 3) throw new Error(MALFORMED);
    const uvs = entry.uvs ? base64ToF32(entry.uvs) : null;
    if (uvs && uvs.length !== vertexCount * 2) throw new Error(MALFORMED);
    const uvs2 = typeof entry.uvs2 === "string" ? base64ToF32(entry.uvs2) : null;
    if (uvs2 && uvs2.length !== vertexCount * 2) throw new Error(MALFORMED);
    const blend = typeof entry.blend === "string" ? base64ToF32(entry.blend) : null;
    if (blend && (blend.length !== vertexCount || !blend.every((w) => w >= 0 && w <= 1))) throw new Error(MALFORMED);
    const tangents = typeof entry.tangents === "string" ? base64ToF32(entry.tangents) : null;
    if (tangents && (tangents.length !== vertexCount * 4 || !tangents.every(Number.isFinite))) throw new Error(MALFORMED);

    const indices = base64ToU32(entry.indices);
    if (indices.length === 0 || indices.length % 3 !== 0) throw new Error(MALFORMED);
    for (let i = 0; i < indices.length; i += 1) if (indices[i]! >= vertexCount) throw new Error(MALFORMED);

    totalVertices += vertexCount;
    totalIndices += indices.length;
    if (totalVertices > MAX_MESH_VERTICES || totalIndices > MAX_MESH_INDICES) throw new Error(MALFORMED);

    // Skin bindings: four joints (each in range) and four weights per vertex.
    let joints: Uint16Array | null = null;
    let weights: Float32Array | null = null;
    if (skin && typeof entry.bone === "number") {
      // Bound wholly to one joint (a rigid part): stored as just the joint.
      const bone = entry.bone;
      if (!Number.isInteger(bone) || bone < 0 || bone >= skin.joints.length) throw new Error(MALFORMED);
      joints = new Uint16Array(vertexCount * 4);
      weights = new Float32Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v += 1) {
        joints[v * 4] = bone;
        weights[v * 4] = 1;
      }
    } else if (skin && typeof entry.bones === "string") {
      const each = base64ToBytes(entry.bones);
      if (each.length !== vertexCount) throw new Error(MALFORMED);
      joints = new Uint16Array(vertexCount * 4);
      weights = new Float32Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v += 1) {
        if (each[v]! >= skin.joints.length) throw new Error(MALFORMED);
        joints[v * 4] = each[v]!;
        weights[v * 4] = 1;
      }
    } else if (skin && typeof entry.joints === "string" && typeof entry.weights === "string") {
      joints = base64ToU16(entry.joints);
      weights = base64ToF32(entry.weights);
      if (joints.length !== vertexCount * 4 || weights.length !== vertexCount * 4) throw new Error(MALFORMED);
      for (let i = 0; i < joints.length; i += 1) if (joints[i]! >= skin.joints.length) throw new Error(MALFORMED);
      if (!weights.every(Number.isFinite)) throw new Error(MALFORMED);
    }

    return {
      positions,
      normals,
      uvs,
      indices,
      material: deserializeMaterial(entry.material, Object.assign(images, { primitive: index })),
      ...(uvs2 ? { uvs2 } : {}),
      ...(blend ? { blend } : {}),
      ...(tangents ? { tangents } : {}),
      ...(joints && weights ? { joints, weights } : {}),
      ...readMorphTargets(entry.morphTargets, vertexCount, skin?.joints.length ?? 0),
    };
  });

  if (primitives.length === 0) throw new Error(MALFORMED);
  const clips = skin ? deserializeClips(raw.clips, skin.joints.length) : [];
  const trails = readMeshTrails(raw.trails, skin?.joints.length ?? 0);
  const variants: MeshVariant[] = [];
  if (raw.variants !== undefined) {
    if (!Array.isArray(raw.variants) || raw.variants.length > MAX_MESH_VARIANTS) throw new Error(MALFORMED);
    raw.variants.forEach((v, k) => {
      if (!v || typeof v.name !== "string" || !Array.isArray(v.materials) || v.materials.length !== primitives.length) throw new Error(MALFORMED);
      variants.push({
        name: v.name.slice(0, 64),
        materials: v.materials.map((m, i) => (m ? deserializeMaterial(m, Object.assign(images, { primitive: `v${k}.${i}` })) : null)),
      });
    });
  }
  return {
    name: typeof raw.name === "string" ? raw.name : "mesh",
    primitives,
    ...(skin ? { skin } : {}),
    ...(clips.length > 0 ? { clips } : {}),
    ...(trails.length > 0 ? { trails } : {}),
    ...(variants.length > 0 ? { variants } : {}),
    ...(Array.isArray(raw.morphWeights) && raw.morphWeights.every((w) => typeof w === "number" && Number.isFinite(w)) ? { morphWeights: raw.morphWeights.slice(0, MAX_MORPH_TARGETS) } : {}),
    ...(raw.dualQuaternion === true ? { dualQuaternion: true } : {}),
  };
}

/** A stored primitive's morph targets (F7a), each the primitive's length; a malformed one throws. */
function readMorphTargets(raw: unknown, vertexCount: number, jointCount: number): { morphTargets?: MorphTarget[] } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || raw.length > MAX_MORPH_TARGETS) throw new Error("Malformed mesh asset");
  const targets = raw.map((t: unknown): MorphTarget => {
    const r = t as { name?: unknown; positions?: unknown; normals?: unknown; driver?: { joint?: unknown; angles?: unknown } };
    if (typeof r.positions !== "string") throw new Error("Malformed mesh asset");
    const positions = base64ToF32(r.positions);
    const normals = typeof r.normals === "string" ? base64ToF32(r.normals) : null;
    if (positions.length !== vertexCount * 3 || (normals && normals.length !== vertexCount * 3) || !positions.every(Number.isFinite)) throw new Error("Malformed mesh asset");
    const d = r.driver;
    const driver =
      d && Number.isInteger(d.joint) && (d.joint as number) >= 0 && (d.joint as number) < jointCount && Array.isArray(d.angles) && d.angles.length === 2 && d.angles.every((a) => typeof a === "number" && Number.isFinite(a))
        ? { joint: d.joint as number, angles: [d.angles[0] as number, d.angles[1] as number] as [number, number] }
        : undefined;
    return { name: typeof r.name === "string" ? r.name.slice(0, 64) : "", positions, ...(normals ? { normals } : {}), ...(driver ? { driver } : {}) };
  });
  return targets.length > 0 ? { morphTargets: targets } : {};
}
