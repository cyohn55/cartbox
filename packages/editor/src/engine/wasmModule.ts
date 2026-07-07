/**
 * Loads the TIC-80 WASM glue (packages/engine/dist/tic80.js) and exposes the
 * cartridge-editing entry points added to shim.c. The same module also carries
 * the runtime (cbx_create/tick) used by the player; here we only type the parts
 * the editor needs. Everything WASM-specific lives in this file and
 * WasmCartEngine — the editor UI never sees it.
 */

/** The subset of the Emscripten module the editor calls. */
export interface EditorModule {
  /** Reassigned when WASM memory grows, so always read it fresh. */
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;

  _cbx_cart_create(): number;
  _cbx_cart_delete(cart: number): void;
  _cbx_cart_bytesize(): number;
  _cbx_cart_load(cart: number, buffer: number, size: number): void;
  _cbx_cart_save(cart: number, out: number): number;
  _cbx_cart_banks(): number;
  _cbx_cart_tiles_ptr(cart: number, bank: number): number;
  _cbx_cart_sprites_ptr(cart: number, bank: number): number;
  _cbx_cart_map_ptr(cart: number, bank: number): number;
  _cbx_cart_palette_ptr(cart: number, bank: number): number;
  _cbx_cart_code_ptr(cart: number): number;
  _cbx_cart_code_capacity(): number;
  _cbx_cart_get_lang(cart: number): number;
  _cbx_cart_set_lang(cart: number, lang: number): void;
  _cbx_cart_sfx_ptr(cart: number, bank: number): number;
  _cbx_cart_sfx_stride(): number;
  _cbx_cart_waveforms_ptr(cart: number, bank: number): number;
  _cbx_cart_waveform_stride(): number;
  _cbx_cart_sfx_loop_start(cart: number, bank: number, sample: number, channel: number): number;
  _cbx_cart_sfx_set_loop_start(cart: number, bank: number, sample: number, channel: number, value: number): void;
  _cbx_cart_sfx_loop_size(cart: number, bank: number, sample: number, channel: number): number;
  _cbx_cart_sfx_set_loop_size(cart: number, bank: number, sample: number, channel: number, value: number): void;
  _cbx_cart_music_patterns_ptr(cart: number, bank: number): number;
  _cbx_cart_music_pattern_stride(): number;
  _cbx_cart_music_pattern_id(cart: number, bank: number, track: number, frame: number, channel: number): number;
  _cbx_cart_music_set_pattern_id(
    cart: number,
    bank: number,
    track: number,
    frame: number,
    channel: number,
    id: number,
  ): void;
}

type EditorFactory = () => Promise<EditorModule>;

const moduleCache = new Map<string, Promise<EditorModule>>();

/** Loads and instantiates the engine module, caching one instance per URL. */
export function loadEditorModule(engineUrl: string): Promise<EditorModule> {
  const cached = moduleCache.get(engineUrl);
  if (cached) {
    return cached;
  }

  const pending = import(/* @vite-ignore */ /* webpackIgnore: true */ engineUrl)
    .then((glue: { default: EditorFactory }) => glue.default())
    .catch((error: unknown) => {
      moduleCache.delete(engineUrl);
      throw error;
    });

  moduleCache.set(engineUrl, pending);
  return pending;
}
