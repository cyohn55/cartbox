/**
 * @cartbox/editor — framework-agnostic cart data model and the engine boundary
 * the WASM shim implements. The React editor UI (apps/web) builds on top of
 * these; nothing here touches the DOM.
 */

export * from "./engine/CartEngine";
export {
  type ConsoleModelSpec,
  type ConsoleModelId,
  type RasterKind,
  CLASSIC_MODEL,
  PRO_MODEL,
  VOXEL_MODEL,
  CONSOLE_MODELS,
} from "./engine/consoleModel";
export { StubCartEngine } from "./engine/StubCartEngine";
export {
  WasmCartEngine,
  createWasmCartEngine,
  loadWasmCartEngine,
} from "./engine/WasmCartEngine";
export { type EditorModule, loadEditorModule } from "./engine/wasmModule";
export { EditHistory, type EditHistoryOptions } from "./model/EditHistory";
export { observeEngine } from "./model/observeEngine";
export { seedDemoCart, DEMO_CODE } from "./model/seed";
export {
  seedParallaxDemoCart,
  buildParallaxCode,
  PARALLAX_CODE,
  PARALLAX_LAYERS,
  silhouetteHeight,
  bandTopRow,
  type ParallaxLayer,
} from "./model/parallaxSeed";
export {
  CART_STARTERS,
  DEFAULT_STARTER_ID,
  STARTER_IDS,
  resolveStarter,
  applyStarter,
  type CartStarter,
} from "./model/starters";
export { SpriteSheet, type SheetImage, type IndexedImage } from "./model/SpriteSheet";
export { TileMap } from "./model/TileMap";
export {
  CollisionMap,
  isCollisionData,
  COLLISION_MAP_VERSION,
  type CollisionData,
} from "./model/CollisionMap";
export {
  TileFlags,
  isFlagData,
  TILE_FLAGS_VERSION,
  FLAG_COUNT,
  FLAG_LABELS,
  type FlagData,
} from "./model/TileFlags";
export { SoundBank, SFX_CHANNEL, type SfxLoop } from "./model/SoundBank";
export { NormalMap } from "./model/NormalMap";
export { MaterialMap } from "./model/MaterialMap";
export {
  MATERIAL_PROFILE_CHANNELS,
  defaultMaterialProfile,
  defaultMaterialSwatches,
  normalizeMaterialProfile,
  materialProfileAt,
  isMaterialSwatchEnabled,
  setMaterialProfile,
  type MaterialProfile,
  type MaterialProfileChannel,
  type MaterialSwatches,
} from "./model/MaterialSwatches";
export {
  NORMAL_VECTORS,
  NORMAL_DIRECTION_COUNT,
  normalVector,
  nearestDirection,
  normalColorHex,
  type Vec3,
} from "./model/normals";
export { shade, type Rgb } from "./model/lighting";
export { renderLitRgba, type Light, type FogOptions, type LitOptions } from "./render/litRenderer";
export {
  renderVoxelRgba,
  type VoxelLight,
  type VoxelOptions,
  type VoxelImage,
} from "./render/voxelRenderer";
export {
  extrudeSprite,
  modelDiagonal,
  CUBE_FACES,
  type VoxelModel,
  type ExtrudeOptions,
  type PixelSource,
} from "./render/voxelModel";
export {
  CUBE_GEOMETRY,
  HEXEL_GEOMETRY,
  geometryFor,
  isValidSite,
  type CellShape,
  type CellGeometry,
  type CellFace,
} from "./render/cellGeometry";
export {
  VoxelGrid,
  voxelGridToModel,
  scaleGridAxis,
  serializeVoxelGrid,
  deserializeVoxelGrid,
  deserializeCellShape,
  MAX_VOXEL_GRID_DIM,
  VOXEL_GRID_VERSION,
  MATERIAL_NONE,
  type VoxelCell,
  type GridVoxelModel,
  type GridAxis,
} from "./model/VoxelGrid";
export { parseVox, encodeVox, DEFAULT_VOX_PALETTE } from "./model/voxCodec";
export {
  serializeMeshAsset,
  deserializeMeshAsset,
  defaultMaterial,
  meshVertexCount,
  meshTriangleCount,
  meshBounds,
  computeSmoothNormals,
  MESH_ASSET_VERSION,
  MAX_MESH_VERTICES,
  MAX_MESH_INDICES,
  type MeshAsset,
  type MeshPrimitive,
  type MeshMaterial,
  type EncodedImage,
  type MeshBounds,
} from "./model/MeshAsset";
export { parseObj, encodeObj, type ParseObjOptions, type ObjFiles } from "./model/objCodec";
export { parseGlb, parseGltf, parseGltfText, encodeGlb } from "./model/gltfCodec";
export {
  renderMesh,
  renderMeshScene,
  composeModelMatrix,
  multiplyMat4,
  viewMatrix,
  projectionMatrix,
  type Mat4,
  type MeshSceneInstance,
  type RenderMeshSceneOptions,
  type DecodedTexture,
  type OrbitCamera,
  type RenderMeshOptions,
} from "./render/meshRasterizer";
export {
  MapVoxelLayer,
  mapLayerToVoxelGrid,
  serializeMapVoxelLayer,
  deserializeMapVoxelLayer,
  MAX_MAP_COLUMN_HEIGHT,
  MAP_VOXEL_LAYER_VERSION,
  COLUMN_MATERIAL_NONE,
  type MapColumn,
  type MapLayerGridOptions,
  type PaletteLookup,
} from "./model/MapVoxelLayer";
export {
  MapVoxelSpace,
  mapColumnTarget,
  mapSpaceFromColumns,
  mapSpaceToColumns,
  serializeMapVoxelSpace,
  deserializeMapVoxelSpace,
  loadMapVoxelSpace,
  isPlaneKind,
  planeAxisOf,
  MAP_CELL_KINDS,
  MAP_VOXEL_SPACE_VERSION,
  MAX_MAP_VOXEL_HEIGHT,
  MAX_MAP_CELL_MATERIAL,
  type MapCellKind,
  type MapVoxelCell,
} from "./model/MapVoxelSpace";
export {
  renderMapFirstPerson,
  castMapRay,
  cellContaining,
  firstPersonBasis,
  walkAxes,
  type FirstPersonBasis,
  type FirstPersonCamera,
  type FirstPersonOptions,
  type FirstPersonRender,
  type MapRayHit,
  type MapWindow,
} from "./render/mapRaycaster";
export {
  mapSpaceToModel,
  planeFaceIndices,
  isPlaneVoxel,
  type MapSpaceModelOptions,
  type MapViewFocus,
} from "./model/mapSpaceModel";
export * from "./procgen/index";
export {
  VOXEL_FONT,
  FONT_WIDTH,
  FONT_HEIGHT,
  buildGlyphModel,
  buildVoxelText,
  layoutVoxelText,
  type GlyphColor,
  type VoxelTextOptions,
  type VoxelLetter,
  type VoxelTextLayout,
} from "./model/voxelText";
export {
  shapeOffsets,
  solidOffsets,
  type VoxelShapeKind,
  type VoxelSolidKind,
  type VoxelShapeStyle,
  type ShapeOffset,
  type SolidOffset,
} from "./model/voxelShapes";
export {
  floodRegion,
  cellCoords,
  type FloodOptions,
} from "./model/voxelSelect";
export {
  renderVoxelModel,
  voxelCanvasSize,
  DEFAULT_MODEL_LIGHT,
  drawModelInto,
  makeDrawContext,
  normalizeTriple,
  type DrawContext,
  type ModelLight,
  type RenderModelOptions,
  type VoxelRender,
} from "./render/voxelModelRenderer";
export {
  renderScene,
  drawParticlesInto,
  type PlacedModel,
  type Particle,
  type SceneCamera,
  type RenderSceneOptions,
  type SceneRender,
} from "./render/sceneRenderer";
export {
  tileAt,
  faceTile,
  spriteToFaceTexture,
  MATERIAL_TOP_THRESHOLD,
  type FaceTexture,
  type TextureAtlas,
  type FaceMaterial,
} from "./render/faceTexture";
export {
  withDerivedSurface,
  heightFromArt,
  normalsFromHeight,
  luminance,
  MATTE_FINISH,
  type SurfaceFinish,
} from "./render/faceRelief";
export {
  packAtlasTexture,
  buildFaceLayers,
  commonTileSize,
  faceGroupOf,
  FACE_GROUPS,
  type AtlasTexture,
  type AtlasTextureLevel,
  type FaceGroup,
  type PackAtlasOptions,
} from "./render/tileAtlasTexture";
export {
  voxelModelToMesh,
  VOXEL_MESH_STRIDE,
  type VoxelMesh,
  type VoxelMeshOptions,
} from "./render/voxelMesh";
export {
  orbitBasis,
  orthographicProjection,
  perspectiveProjection,
  projectToScreen,
  screenRay,
  type CameraBasis,
  type OrthographicOptions,
  type PerspectiveOptions,
  type Projection,
  type WorldRay,
} from "./render/mapCamera";
export {
  LIGHTING_PRESETS,
  DEFAULT_LIGHTING_PRESET_ID,
  lightingPresetConditions,
  directionFromConditions,
  type LightingConditions,
  type LightingPreset,
} from "./render/lightingConditions";
export {
  renderLayeredScene,
  projectPlane,
  type ScenePlane,
  type Camera,
  type ProjectedPlane,
  type RenderedFrame,
} from "./render/layeredScene";
export {
  buildRigPlanes,
  findRigPart,
  demoCharacterRig,
  type CharacterRig,
  type RigPart,
} from "./model/characterRig";
export {
  readBlockRgba,
  spriteRigToPlanes,
  emptySpriteRig,
  upsertRigPart,
  removeRigPart,
  findSpriteRigPart,
  RIG_PART_TEMPLATES,
  DEFAULT_RIG_PIVOT_DEPTH,
  DEFAULT_RIG_UNITS_PER_PIXEL,
  type SpriteRig,
  type SpriteRigPart,
  type BlockImage,
  type RigPartTemplate,
} from "./model/spriteRig";
export {
  MusicTracker,
  NOTE_NAMES,
  MUSIC_COMMANDS,
  type MusicCell,
  type MusicCellKind,
  type MusicEffect,
} from "./model/MusicTracker";
export { CodeDocument, type CursorPosition } from "./model/CodeDocument";
export {
  tokenize,
  LANGUAGES,
  languageById,
  type Token,
  type TokenType,
  type LanguageConfig,
} from "./model/highlight";
export {
  SWEETIE_16,
  hexToRgb,
  rgbToHex,
  defaultPaletteBytes,
  proPaletteHex,
  paletteForModel,
  PRO_PALETTE_SIZE,
  relativeLuminance,
  contrastRatio,
  ensureContrast,
} from "./model/palette";
export { parsePaletteFile, type ParsedPalette, type PaletteFormat } from "./model/paletteImport";
export {
  MATERIAL_DERIVE_PARAMS,
  DERIVABLE_CHANNELS,
  defaultMaterialDeriveParams,
  normalizeMaterialDeriveParams,
  deriveMaterials,
  deriveHeight,
  deriveNormal,
  deriveOcclusion,
  deriveRoughness,
  deriveSpecular,
  deriveEmissive,
  applyDerivedMaterials,
  quantizeLevel,
  boxBlur,
  sobelGradient,
  type DerivedChannel,
  type DerivedMaterials,
  type LevelWriter,
  type MaterialDeriveParams,
  type MaterialTarget,
  type MaterialWriters,
  type NormalWriter,
  type ScalarField,
} from "./model/materialDerive";
export {
  DITHER_MODES,
  DEFAULT_QUANTIZE_OPTIONS,
  DEFAULT_PIXELATE_OPTIONS,
  ditherOffset,
  downscaleImage,
  quantizeToPalette,
  pixelateImage,
  type DitherMode,
  type PixelateOptions,
  type QuantizeOptions,
} from "./model/imageQuantize";
export {
  CubeLutError,
  parseCubeLut,
  applyLut01,
  applyLutRgb,
  gradePalette,
  lutToBytes,
  type CubeLut,
} from "./model/cubeLut";
export {
  parseAseprite,
  parseAsepriteLayers,
  type AsepriteDocument,
  type AsepriteFrame,
  type AsepriteLayer,
  type AsepriteLayers,
} from "./model/asepriteImport";
export {
  encodeAseprite,
  encodeAsepriteRgba,
  encodeAsepriteRgbaFrames,
  type AsepriteExportImage,
  type AsepriteRgbaLayer,
  type AsepriteFrameInput,
} from "./model/asepriteExport";
export {
  HANDHELD_REGIONS,
  HANDHELD_PRESETS,
  DEFAULT_HANDHELD_PRESET_ID,
  makeScheme,
  twoTone,
  renderHandheld,
  renderHandheldWithBackground,
  extractScheme,
  extractSchemeFromLayers,
  extractHandheldTemplate,
  handheldPreset,
  normalizeScheme,
  type HandheldRegion,
  type HandheldRegionId,
  type HandheldScheme,
  type HandheldPreset,
  type HandheldTemplate,
  type HandheldBackground,
} from "./model/handheldSkin";
export {
  HANDHELD_ANIMATED_PRESETS,
  handheldAnimatedPreset,
  renderAnimatedFrame,
  renderAnimatedFrames,
  type HandheldGameId,
  type HandheldAnimatedPreset,
} from "./model/handheldAnimation";
export {
  MAX_PAINT_LAYERS,
  createLayer,
  docFromRgba,
  docFromLayers,
  activeLayer,
  cloneDoc,
  compositeDoc,
  addLayer,
  removeLayer,
  reorderLayer,
  setLayerProps,
  setActiveLayer,
  setLayerPixel,
  getLayerPixel,
  reflectX,
  floodFillRgba,
  clampRect,
  snapshotRect,
  blitRect,
  serializeDoc,
  deserializeDoc,
  type PaintLayer,
  type PaintDoc,
  type LayerInput,
  type Rgba,
  type PixelRect,
} from "./model/handheldPaintDoc";
export { gradientSortOrder } from "./model/paletteSort";
