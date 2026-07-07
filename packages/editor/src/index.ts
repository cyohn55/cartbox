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
export { SpriteSheet, type SheetImage } from "./model/SpriteSheet";
export { TileMap } from "./model/TileMap";
export { SoundBank, SFX_CHANNEL, type SfxLoop } from "./model/SoundBank";
export { NormalMap } from "./model/NormalMap";
export { MaterialMap } from "./model/MaterialMap";
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
export { gradientSortOrder } from "./model/paletteSort";
