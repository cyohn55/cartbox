/*
 * cbx shim — the stable C boundary between @cartbox/player and the TIC-80 core.
 *
 * The player's engine adapter (packages/player/src/engine.ts) calls only the
 * `cbx_*` functions below. They wrap TIC-80's public API from <tic80.h> so that
 * struct-layout or signature changes in TIC-80 are absorbed here instead of
 * leaking into the TypeScript. Keep this file — and only this file — in sync
 * with the vendored TIC-80 version under ./tic80.
 *
 * Contract (mirrored in engine.ts):
 *   cbx_create(sampleRate)          -> console handle (0 on failure)
 *   cbx_load(handle, ptr, size)     -> 1 on success, 0 on failure
 *   cbx_tick(handle, gamepadMask)   -> advance one 60Hz frame + generate sound
 *   cbx_screen_ptr(handle)          -> ptr to a 240x136 RGBA framebuffer
 *   cbx_samples_ptr(handle)         -> ptr to this frame's Int16 PCM
 *   cbx_samples_count(handle)       -> sample count for this frame
 *   cbx_delete(handle)              -> free the console
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "tic80.h"
#include "api.h" /* tic_mem / tic_ram — for the pmem-backed event mailbox */
#include "cart.h" /* tic_cart_load/save + tic_cartridge — for the editor */
#include "tools.h" /* tic_tool_get/set_pattern_id — song arrangement packing */

/*
 * Canvas ImageData expects bytes in memory order R, G, B, A. On little-endian
 * WASM that matches TIC-80's ABGR8888 packing. If red and blue appear swapped
 * in the browser, switch this to TIC80_PIXEL_COLOR_RGBA8888.
 */
#define CBX_PIXEL_FORMAT TIC80_PIXEL_COLOR_RGBA8888

#define CBX_CLOCK_HZ 1000000ULL /* virtual clock frequency, in microseconds */

/*
 * One console plus a private, tightly-packed copy of just the visible screen and
 * its own virtual clock. TIC-80's framebuffer (tic->screen) spans
 * TIC80_FULLWIDTH x TIC80_FULLHEIGHT including the overscan border; the player
 * renders the inner 240x136 region, so we crop into this buffer once per tick.
 *
 * The clock is per-console (not global) so replays are deterministic: each
 * session's time() sequence starts at 0 and advances one 60Hz frame per tick,
 * independent of any other console that ran before it.
 */
/*
 * The material G-buffer: written by the core during tile blits when capture is
 * enabled, aligned 1:1 with the visible 240x136 framebuffer (no overscan border,
 * so no cropping). Two planes:
 *   material  - RGBA per pixel: R=normal index, G=height, B=specular, A=roughness
 *   emissive  - one byte per pixel of self-illumination (0=lit normally)
 * The host relights the framebuffer with `material` and folds `emissive` into the
 * albedo's alpha, which its shader reads. Material persists frame-to-frame like
 * VRAM (the core rematte-s per cls), so both planes live in the console struct.
 */
typedef struct {
  tic80 *core;
  uint64_t clock;
  int material_enabled;
  uint32_t screen[TIC80_WIDTH * TIC80_HEIGHT];
  uint8_t material[TIC80_WIDTH * TIC80_HEIGHT * 4];
  uint8_t emissive[TIC80_WIDTH * TIC80_HEIGHT];
} cbx_console;

/*
 * Install (or clear, with NULL) the material capture targets in the core.
 * Defined in the TIC-80 core (src/core/draw.c); declared here as the shim drives it.
 */
extern void tic_core_cbx_material_target(void *material, void *emissive);

/* Reset both planes to the flat-matte default: normal index 0 (facing the
 * camera), height/specular 0, roughness full, emissive 0 — matches
 * createFlatMaterial on the host so undrawn regions shade identically whether or
 * not capture is on. Done once when capture is enabled; thereafter the core
 * rematte-s per cls so material persists like VRAM between clears. */
static void cbx_material_reset(cbx_console *console) {
  for (int i = 0; i < TIC80_WIDTH * TIC80_HEIGHT; ++i) {
    console->material[i * 4 + 0] = 0;
    console->material[i * 4 + 1] = 0;
    console->material[i * 4 + 2] = 0;
    console->material[i * 4 + 3] = 255;
    console->emissive[i] = 0;
  }
}

/*
 * The console currently ticking. tic80_tick's timer callbacks receive the tic80
 * core pointer as context (not our wrapper), so we track the active console here
 * to read its clock. Safe because only one console ticks at a time (single
 * threaded) in both the player and the worker.
 *
 * The callbacks receive a void* context (CounterCallback / FreqCallback in
 * src/api.h). tic80.h writes them as `u64(*)()`, but the VM calls them with one
 * argument, so the parameter must be present or the indirect call mismatches.
 */
static cbx_console *cbx_active = NULL;

static uint64_t cbx_counter(void *context) {
  (void)context;
  return cbx_active ? cbx_active->clock : 0;
}

static uint64_t cbx_frequency(void *context) {
  (void)context;
  return CBX_CLOCK_HZ;
}

/* No-op VM callbacks so trace/error/exit are never a null call. */
static void cbx_trace(const char *text, uint8_t color) { (void)text; (void)color; }
static void cbx_error(const char *info) { (void)info; }
static void cbx_exit(void) {}

EMSCRIPTEN_KEEPALIVE
cbx_console *cbx_create(int sample_rate) {
  cbx_console *console = calloc(1, sizeof(cbx_console));
  if (!console) {
    return NULL;
  }

  console->core = tic80_create(sample_rate, CBX_PIXEL_FORMAT);
  if (!console->core) {
    free(console);
    return NULL;
  }

  /* Install no-op callbacks so the VM never calls through a null pointer. */
  console->core->callback.trace = cbx_trace;
  console->core->callback.error = cbx_error;
  console->core->callback.exit = cbx_exit;
  return console;
}

EMSCRIPTEN_KEEPALIVE
int cbx_load(cbx_console *console, void *cart, int size) {
  if (!console || !console->core || !cart || size <= 0) {
    return 0;
  }
  /* tic80_load returns void, so success cannot be probed here; the player also
   * guards against a black first frame at a higher level. */
  tic80_load(console->core, cart, size);
  return 1;
}

EMSCRIPTEN_KEEPALIVE
void cbx_tick(cbx_console *console, int gamepad_mask) {
  if (!console || !console->core) {
    return;
  }

  /* Map the player's gamepad bitmask (bit positions from ConsoleButton) onto
   * player one. Explicit per-field assignment avoids depending on the C
   * bitfield memory layout matching our bit order. */
  tic80_input input;
  memset(&input, 0, sizeof(input));
  input.gamepads.first.up = (gamepad_mask >> 0) & 1;
  input.gamepads.first.down = (gamepad_mask >> 1) & 1;
  input.gamepads.first.left = (gamepad_mask >> 2) & 1;
  input.gamepads.first.right = (gamepad_mask >> 3) & 1;
  input.gamepads.first.a = (gamepad_mask >> 4) & 1;
  input.gamepads.first.b = (gamepad_mask >> 5) & 1;
  input.gamepads.first.x = (gamepad_mask >> 6) & 1;
  input.gamepads.first.y = (gamepad_mask >> 7) & 1;

  /* Advance this console's virtual clock one frame, then tick + generate sound.
   * When material capture is on, install the planes as the core's targets for the
   * duration of the tick; the core rematte-s cleared regions itself (per cls), so
   * we do NOT wipe them here — material persists like VRAM. Clear the targets
   * afterwards so a stale pointer can never be written between ticks. */
  cbx_active = console;
  console->clock += CBX_CLOCK_HZ / TIC80_FRAMERATE;
  if (console->material_enabled) {
    tic_core_cbx_material_target(console->material, console->emissive);
  }
  tic80_tick(console->core, input, cbx_counter, cbx_frequency);
  tic_core_cbx_material_target(NULL, NULL);
  tic80_sound(console->core);

  /*
   * Crop the full framebuffer (with border) down to the visible 240x136 and
   * force opaque alpha. TIC-80's ABGR8888 output leaves the alpha byte clear;
   * in memory order R,G,B,A that is the high byte of the word, so OR 0xFF000000
   * to make every pixel opaque for canvas/PNG consumers.
   */
  const uint32_t *full = console->core->screen;
  for (int row = 0; row < TIC80_HEIGHT; ++row) {
    const uint32_t *source =
        full + (row + TIC80_MARGIN_TOP) * TIC80_FULLWIDTH + TIC80_MARGIN_LEFT;
    uint32_t *dest = &console->screen[row * TIC80_WIDTH];
    for (int col = 0; col < TIC80_WIDTH; ++col) {
      dest[col] = source[col] | 0xFF000000u;
    }
  }
}

EMSCRIPTEN_KEEPALIVE
void *cbx_screen_ptr(cbx_console *console) {
  return console ? console->screen : NULL;
}

/*
 * Material G-buffer (Phase 1). Off by default so unlit carts pay nothing; the
 * host enables it when it mounts with lighting. cbx_material_ptr returns a
 * TIC80_WIDTH*TIC80_HEIGHT*4 RGBA plane valid until the next tick.
 */
EMSCRIPTEN_KEEPALIVE
void cbx_set_material_capture(cbx_console *console, int enabled) {
  if (console) {
    console->material_enabled = enabled ? 1 : 0;
    /* Seed the flat-matte default when turning capture on, so pixels never
     * drawn or cleared still shade as matte rather than as zeroed roughness. */
    if (console->material_enabled) {
      cbx_material_reset(console);
    }
  }
}

EMSCRIPTEN_KEEPALIVE
void *cbx_material_ptr(cbx_console *console) {
  return console ? console->material : NULL;
}

EMSCRIPTEN_KEEPALIVE
void *cbx_emissive_ptr(cbx_console *console) {
  return console ? console->emissive : NULL;
}

EMSCRIPTEN_KEEPALIVE
void *cbx_samples_ptr(cbx_console *console) {
  return (console && console->core) ? console->core->samples.buffer : NULL;
}

EMSCRIPTEN_KEEPALIVE
int cbx_samples_count(cbx_console *console) {
  return (console && console->core) ? console->core->samples.count : 0;
}

EMSCRIPTEN_KEEPALIVE
void cbx_delete(cbx_console *console) {
  if (!console) {
    return;
  }
  if (console->core) {
    tic80_delete(console->core);
  }
  free(console);
}

/*
 * Event mailbox (Platform P2). Carts emit platform events (achievements, scores)
 * by writing to a reserved slice of persistent memory (pmem) via the cartbox
 * SDK; the host reads that slice each frame. We reserve the top 64 of pmem's 256
 * words (indices 192..255 = 256 bytes), leaving 0..191 for the cart's own save
 * data. Word 192 is a monotonic sequence counter; the rest is a ring of 3-word
 * event records {type, id, value}.
 */
#define CBX_MAILBOX_PMEM_START 192
#define CBX_MAILBOX_WORDS 64

EMSCRIPTEN_KEEPALIVE
void *cbx_mailbox_ptr(cbx_console *console) {
  if (!console || !console->core) {
    return NULL;
  }
  tic_mem *mem = (tic_mem *)console->core; /* tic80 is the first member of tic_mem */
  return &mem->ram->persistent.data[CBX_MAILBOX_PMEM_START];
}

EMSCRIPTEN_KEEPALIVE
int cbx_mailbox_words(cbx_console *console) {
  (void)console;
  return CBX_MAILBOX_WORDS;
}

/*
 * Cartridge editing (the custom Cartbox editor). A standalone tic_cartridge is
 * mutated in place through raw pointers into its banks, then serialised to .tic
 * bytes for the player and the marketplace. This is the memory the WASM-backed
 * CartEngine (packages/editor) reads and writes; the editors never see the
 * on-disk layout — pixels are 4bpp-packed in tiles/sprites, the palette is RGB
 * triplets, the map is one byte per cell, and code is a NUL-terminated buffer.
 *
 * Only bank 0 is exposed; multi-bank editing is additive. We surface tiles and
 * sprites (the two 256-tile pages), the map, the primary (vbank0) palette, and
 * the code + language id (lua=10, js=12, python=20).
 */

EMSCRIPTEN_KEEPALIVE
tic_cartridge *cbx_cart_create(void) {
  return calloc(1, sizeof(tic_cartridge));
}

EMSCRIPTEN_KEEPALIVE
void cbx_cart_delete(tic_cartridge *cart) {
  if (cart) {
    free(cart);
  }
}

EMSCRIPTEN_KEEPALIVE
int cbx_cart_bytesize(void) {
  return (int)sizeof(tic_cartridge);
}

EMSCRIPTEN_KEEPALIVE
void cbx_cart_load(tic_cartridge *cart, void *buffer, int size) {
  if (!cart || !buffer || size <= 0) {
    return;
  }
  memset(cart, 0, sizeof(tic_cartridge));
  tic_cart_load(cart, (const u8 *)buffer, size);
}

/* Serialise to .tic bytes in `out` (allocate cbx_cart_bytesize()). Returns the
 * number of bytes written. */
EMSCRIPTEN_KEEPALIVE
int cbx_cart_save(tic_cartridge *cart, void *out) {
  if (!cart || !out) {
    return 0;
  }
  return tic_cart_save(cart, (u8 *)out);
}

/* Bounds-checked bank accessor. TIC-80 carts carry TIC_BANKS banks, each with
 * its own tiles/sprites/map/sfx/music/palette; the editor edits one at a time. */
static tic_bank *cbx_bank(tic_cartridge *cart, int bank) {
  if (!cart || bank < 0 || bank >= TIC_BANKS) {
    return NULL;
  }
  return &cart->banks[bank];
}

EMSCRIPTEN_KEEPALIVE
int cbx_cart_banks(void) {
  return TIC_BANKS;
}

EMSCRIPTEN_KEEPALIVE
void *cbx_cart_tiles_ptr(tic_cartridge *cart, int bank) {
  tic_bank *b = cbx_bank(cart, bank);
  return b ? b->tiles.data : NULL;
}

EMSCRIPTEN_KEEPALIVE
void *cbx_cart_sprites_ptr(tic_cartridge *cart, int bank) {
  tic_bank *b = cbx_bank(cart, bank);
  return b ? b->sprites.data : NULL;
}

EMSCRIPTEN_KEEPALIVE
void *cbx_cart_map_ptr(tic_cartridge *cart, int bank) {
  tic_bank *b = cbx_bank(cart, bank);
  return b ? b->map.data : NULL;
}

EMSCRIPTEN_KEEPALIVE
void *cbx_cart_palette_ptr(tic_cartridge *cart, int bank) {
  tic_bank *b = cbx_bank(cart, bank);
  return b ? b->palette.vbank0.data : NULL;
}

EMSCRIPTEN_KEEPALIVE
char *cbx_cart_code_ptr(tic_cartridge *cart) {
  return cart ? cart->code.data : NULL;
}

EMSCRIPTEN_KEEPALIVE
int cbx_cart_code_capacity(void) {
  return TIC_CODE_SIZE;
}

EMSCRIPTEN_KEEPALIVE
int cbx_cart_get_lang(tic_cartridge *cart) {
  return cart ? cart->lang : 0;
}

EMSCRIPTEN_KEEPALIVE
void cbx_cart_set_lang(tic_cartridge *cart, int lang) {
  if (cart) {
    cart->lang = (u8)lang;
  }
}

/*
 * Sound data. SFX samples and music tracks/patterns are exposed as per-bank raw
 * pointers plus their element strides, so the WASM-backed engine can index and
 * decode them (4bpp-packed envelopes for SFX, packed bitfield rows for music)
 * exactly as it does tiles.
 */

EMSCRIPTEN_KEEPALIVE
void *cbx_cart_sfx_ptr(tic_cartridge *cart, int bank) {
  tic_bank *b = cbx_bank(cart, bank);
  return b ? b->sfx.samples.data : NULL;
}

EMSCRIPTEN_KEEPALIVE
int cbx_cart_sfx_stride(void) {
  return (int)sizeof(tic_sample);
}

/* The 16 shared custom waveforms the SFX "wave" index points at; each is
 * WAVE_VALUES steps at 4 bits, packed two per byte like the SFX envelopes. */
EMSCRIPTEN_KEEPALIVE
void *cbx_cart_waveforms_ptr(tic_cartridge *cart, int bank) {
  tic_bank *b = cbx_bank(cart, bank);
  return b ? b->sfx.waveforms.items : NULL;
}

EMSCRIPTEN_KEEPALIVE
int cbx_cart_waveform_stride(void) {
  return (int)sizeof(tic_waveform);
}

/* SFX envelope loops. Each sample has four loops (channel 0=wave, 1=volume,
 * 2=chord, 3=pitch), each a 4-bit start + 4-bit size. Accessed directly in C so
 * the JS side never has to compute the loop's offset within the bitfield-packed
 * tic_sample. */
static tic_sample *cbx_sample(tic_cartridge *cart, int bank, int sample) {
  tic_bank *b = cbx_bank(cart, bank);
  if (!b || sample < 0 || sample >= SFX_COUNT) {
    return NULL;
  }
  return &b->sfx.samples.data[sample];
}

EMSCRIPTEN_KEEPALIVE
int cbx_cart_sfx_loop_start(tic_cartridge *cart, int bank, int sample, int channel) {
  tic_sample *s = cbx_sample(cart, bank, sample);
  return (s && channel >= 0 && channel < 4) ? s->loops[channel].start : 0;
}

EMSCRIPTEN_KEEPALIVE
void cbx_cart_sfx_set_loop_start(tic_cartridge *cart, int bank, int sample, int channel, int value) {
  tic_sample *s = cbx_sample(cart, bank, sample);
  if (s && channel >= 0 && channel < 4) {
    s->loops[channel].start = (u8)(value & 0xF);
  }
}

EMSCRIPTEN_KEEPALIVE
int cbx_cart_sfx_loop_size(tic_cartridge *cart, int bank, int sample, int channel) {
  tic_sample *s = cbx_sample(cart, bank, sample);
  return (s && channel >= 0 && channel < 4) ? s->loops[channel].size : 0;
}

EMSCRIPTEN_KEEPALIVE
void cbx_cart_sfx_set_loop_size(tic_cartridge *cart, int bank, int sample, int channel, int value) {
  tic_sample *s = cbx_sample(cart, bank, sample);
  if (s && channel >= 0 && channel < 4) {
    s->loops[channel].size = (u8)(value & 0xF);
  }
}

EMSCRIPTEN_KEEPALIVE
void *cbx_cart_music_patterns_ptr(tic_cartridge *cart, int bank) {
  tic_bank *b = cbx_bank(cart, bank);
  return b ? b->music.patterns.data : NULL;
}

EMSCRIPTEN_KEEPALIVE
int cbx_cart_music_pattern_stride(void) {
  return (int)sizeof(tic_track_pattern);
}

EMSCRIPTEN_KEEPALIVE
void *cbx_cart_music_tracks_ptr(tic_cartridge *cart, int bank) {
  tic_bank *b = cbx_bank(cart, bank);
  return b ? b->music.tracks.data : NULL;
}

/* Song arrangement: which pattern each of the 4 channels plays on each of a
 * track's MUSIC_FRAMES frames. The 6-bits-per-channel packing is handled by the
 * TIC-80 helpers, so the JS side never touches it. */
static tic_track *cbx_track(tic_cartridge *cart, int bank, int track, int frame, int channel) {
  tic_bank *b = cbx_bank(cart, bank);
  if (!b || track < 0 || track >= MUSIC_TRACKS || frame < 0 || frame >= MUSIC_FRAMES ||
      channel < 0 || channel >= TIC_SOUND_CHANNELS) {
    return NULL;
  }
  return &b->music.tracks.data[track];
}

EMSCRIPTEN_KEEPALIVE
int cbx_cart_music_pattern_id(tic_cartridge *cart, int bank, int track, int frame, int channel) {
  tic_track *t = cbx_track(cart, bank, track, frame, channel);
  return t ? tic_tool_get_pattern_id(t, frame, channel) : 0;
}

EMSCRIPTEN_KEEPALIVE
void cbx_cart_music_set_pattern_id(tic_cartridge *cart, int bank, int track, int frame, int channel, int id) {
  tic_track *t = cbx_track(cart, bank, track, frame, channel);
  if (t) {
    tic_tool_set_pattern_id(t, frame, channel, id & 0x3f);
  }
}

EMSCRIPTEN_KEEPALIVE
int cbx_cart_music_track_stride(void) {
  return (int)sizeof(tic_track);
}

/*
 * Emscripten links a `main`. This module is a library driven from JS (the
 * factory instantiates it and the runtime stays alive with EXIT_RUNTIME=0), so
 * main does nothing.
 */
int main(void) { return 0; }
