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
  VoxelGrid,
  voxelGridToModel,
  scaleGridAxis,
  serializeVoxelGrid,
  deserializeVoxelGrid,
  MAX_VOXEL_GRID_DIM,
  VOXEL_GRID_VERSION,
  type VoxelCell,
  type GridVoxelModel,
  type GridAxis,
} from "./model/VoxelGrid";
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
  type ModelLight,
  type RenderModelOptions,
  type VoxelRender,
} from "./render/voxelModelRenderer";
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
} from "./model/palette";
export { parsePaletteFile, type ParsedPalette, type PaletteFormat } from "./model/paletteImport";
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
