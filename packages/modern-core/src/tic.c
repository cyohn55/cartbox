/*
 * The dedicated Modern core's TIC-80 compatibility layer (see tic.h).
 *
 * Ported from TIC-80 (https://github.com/nesbox/TIC-80, MIT License,
 * Copyright (c) 2017 Vadim Grigoruk @nesbox, and contributors): its memory map
 * (src/tic.h) at the HD core's spec (8 bits a pixel, 8 sound channels), its
 * cartridge loader (src/cart.c), sync and vbanks (src/core/core.c), drawing
 * (src/core/draw.c, src/tilesheet.c), input (src/core/io.c), sound
 * (src/core/sound.c) and the Lua bindings' argument rules (src/api/luaapi.c).
 * The algorithms are TIC-80's, step for step, so a cart draws the same pixels
 * here as on the TIC-80–derived HD core; packages/engine/tic80 (fetched by
 * `npm run engine:prepare`) is the source they were ported from.
 *
 * One part is not TIC-80's: turning the sound registers into samples. TIC-80
 * mixes with blip_buf (LGPL), so here a small band-limiting mixer of our own
 * does that job. The registers, and so the notes, timing and volumes, are
 * TIC-80's; the samples differ from the HD core's by a little filtering.
 *
 * The layout follows from the console's size and where its persistent words
 * sit: at 1280×720 with pmem at 3068512 it is the HD core's, byte for byte.
 */

#include "tic.h"

#include <float.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "lauxlib.h"

#include "font.h"

typedef int32_t s32;
typedef uint32_t u32;
typedef uint8_t u8;
typedef int8_t s8;

#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define CLAMP(v, a, b) MIN(MAX(v, a), b)
#define COUNT_OF(x) ((s32)(sizeof(x) / sizeof((x)[0])))

/* ---- the spec ------------------------------------------------------------ */

enum {
  CHANNELS = 8,
  PALETTE_SIZE = 256,
  PAL_BYTES = PALETTE_SIZE * 3,
  TILE = 64, /* 8×8 at 8 bits */
  TILES = 256 * TILE,
  FLAGS = 512,
  FONT_DATA = 1016,
  FONT_STRIDE = 1024, /* data + 8 params */
  SAMPLE = 66,
  SFX_COUNT = 64,
  WAVES = 16 * 16,
  SFX_BYTES = WAVES + SFX_COUNT * SAMPLE,
  ROWS = 64,
  PATTERN = 3 * ROWS,
  PATTERNS = 60,
  FRAMES = 16,
  TRACK_PATTERNS_SIZE = 6 * CHANNELS / 8,
  TRACK = FRAMES * TRACK_PATTERNS_SIZE + 3,
  TRACKS = 8,
  MUSIC_BYTES = PATTERNS * PATTERN + TRACKS * TRACK,
  REGISTER = 18,
  KEYS = 95,
  KEY_BUFFER = 4,
  BANKS = 8,
  TRANSPARENT = 255,
  DEFAULT_COLOR = 15,
  MAX_VOLUME = 15,
  NOTES = 12,
  SFX_TICKS = 30,
  RINGBUF = 12,
  CLOCKRATE = 255 << 13,
  ENDTIME = CLOCKRATE / 60,
};

static const u8 SWEETIE16[] = {0x1a, 0x1c, 0x2c, 0x5d, 0x27, 0x5d, 0xb1, 0x3e, 0x53, 0xef, 0x7d, 0x57, 0xff, 0xcd, 0x75, 0xa7, 0xf0, 0x70, 0x38, 0xb7, 0x64, 0x25, 0x71, 0x79, 0x29, 0x36, 0x6f, 0x3b, 0x5d, 0xc9, 0x41, 0xa6, 0xf6, 0x73, 0xef, 0xf7, 0xf4, 0xf4, 0xf4, 0x94, 0xb0, 0xc2, 0x56, 0x6c, 0x86, 0x33, 0x3c, 0x57};
static const u8 WAVEFORMS[] = {0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe};
static const u8 DB16[] = {0x14, 0x0c, 0x1c, 0x44, 0x24, 0x34, 0x30, 0x34, 0x6d, 0x4e, 0x4a, 0x4e, 0x85, 0x4c, 0x30, 0x34, 0x65, 0x24, 0xd0, 0x46, 0x48, 0x75, 0x71, 0x61, 0x59, 0x7d, 0xce, 0xd2, 0x7d, 0x2c, 0x85, 0x95, 0xa1, 0x6d, 0xaa, 0x2c, 0xd2, 0xaa, 0x99, 0x6d, 0xc2, 0xca, 0xda, 0xd4, 0x5e, 0xde, 0xee, 0xd6};

/* The memory map: offsets into RAM (and into a cartridge bank). */
static struct {
  s32 width, height, fullwidth, fullheight, margin_top;
  s32 screen, vram;                       /* the screen's bytes; the vram's (a vbank) */
  s32 palette, mapping, vars, blit;       /* in the vram */
  s32 tiles, sprites, map, input, sfxpos, registers, sfx, samples, music, tracks, music_state, stereo, persistent, flags, font,
      gpmapping, pcm, end;
  s32 map_w, map_h;
  s32 bank, b_tiles, b_sprites, b_map, b_sfx, b_music, b_flags, b_palette; /* a cartridge bank */
} M;

typedef struct { s32 time, phase, amp; } RegData;
typedef struct { s32 tick; s8 *pos; s32 index, note; u8 left, right; s32 speed, duration; } Channel;
typedef struct {
  struct { s32 tick; u8 note1, note2; } chord;
  struct { s32 tick; u8 period, depth; } vibrato;
  struct { s32 tick; u8 note; s32 duration; } slide;
  struct { s32 value; } finepitch;
  struct { const u8 *row; s32 ticks; } delay;
} Command;

static struct {
  u8 *ram;
  s32 ram_size;
  u8 *vbank; /* the other vbank's vram */
  s32 vbank_id;
  u32 *frame;
  u8 *banks[BANKS];
  struct { s32 l, t, r, b; } clip;
  u32 synced;
  u32 frames;
  s32 reset;
  u8 flag_stub;
  struct { u32 previous, now, holds[32]; } gamepads;
  struct { u32 previous, now, holds[KEYS]; } keyboard;
  /* sound */
  struct { RegData data[CHANNELS], pcm; } regs[2];
  struct { u8 registers[CHANNELS * REGISTER]; u8 stereo[8]; u8 pcm[128]; } ring[RINGBUF];
  u32 ring_head, ring_tail;
  Channel sfx[CHANNELS];
  struct { s32 ticks; Channel channels[CHANNELS]; Command commands[CHANNELS]; s8 sfxpos[CHANNELS][4]; struct { s32 active, frame, beat; } jump; s32 tempo, speed; } music;
  s32 sample_rate, sample_frames;
  int16_t *samples;
  float *mix[2];
  float level[2];
  /* drawing */
  double *zbuffer;
  int16_t *side_l, *side_r;
  s32 *side_u, *side_v;
} T;

static u8 *R; /* T.ram */

/* ---- small tools (TIC-80's src/tools.h) ------------------------------------ */

static inline u8 peek4(const void *p, u32 i) { return (((const u8 *)p)[i >> 1] >> ((i & 1) << 2)) & 15; }
static inline void poke4(void *p, u32 i, u8 v) { u8 *b = (u8 *)p + (i >> 1); u8 s = (i & 1) << 2; *b = (u8)((*b & ~(15 << s)) | ((v & 15) << s)); }
static inline u8 peek2(const void *p, u32 i) { return (((const u8 *)p)[i >> 2] >> ((i & 3) << 1)) & 3; }
static inline void poke2(void *p, u32 i, u8 v) { u8 *b = (u8 *)p + (i >> 2); u8 s = (i & 3) << 1; *b = (u8)((*b & ~(3 << s)) | ((v & 3) << s)); }
static inline u8 peek1(const void *p, u32 i) { return (((const u8 *)p)[i >> 3] >> (i & 7)) & 1; }
static inline void poke1(void *p, u32 i, u8 v) { u8 *b = (u8 *)p + (i >> 3); u8 s = i & 7; *b = (u8)((*b & ~(1 << s)) | ((v & 1) << s)); }
static inline u8 peek8(const void *p, u32 i) { return ((const u8 *)p)[i]; }
static inline s32 modulo(s32 x, s32 m) { s32 r = x % m; return r < 0 ? r + m : r; }
static int empty(const u8 *p, s32 n) { for (s32 i = 0; i < n; i++) if (p[i]) return 0; return 1; }

/* (s32)lua_tonumber, as TIC-80's bindings read numbers. */
static inline s32 num(lua_State *L, int i) { return (s32)lua_tonumber(L, i); }

/* ---- the layout ----------------------------------------------------------- */

static int layout(s32 width, s32 height, s32 ram_size, s32 pmem) {
  memset(&M, 0, sizeof M);
  M.width = width;
  M.height = height;
  s32 bits = 1;
  while ((1 << bits) < width || (1 << bits) * 9 / 16 < height) bits++;
  M.fullwidth = 1 << bits;
  M.fullheight = M.fullwidth * 9 / 16;
  M.margin_top = (M.fullheight - height) / 2;
  M.map_w = width / 8 * 8;
  M.map_h = height / 8 * 8;
  M.screen = width * height;
  M.palette = M.screen;
  M.mapping = M.palette + PAL_BYTES;
  M.vars = M.mapping + PALETTE_SIZE;
  M.blit = M.vars + 4;
  /* The vram is what's left before the rest, which is fixed-size and ends at the persistent words. */
  s32 rest = 2 * TILES + M.map_w * M.map_h + 12 + CHANNELS * 4 + CHANNELS * REGISTER + SFX_BYTES + MUSIC_BYTES + 4;
  if (pmem % 8) return 0;
  M.vram = pmem - 8 - rest;
  if (M.vram < M.blit + 4) return 0;
  M.tiles = M.vram;
  M.sprites = M.tiles + TILES;
  M.map = M.sprites + TILES;
  M.input = M.map + M.map_w * M.map_h;
  M.sfxpos = M.input + 12;
  M.registers = M.sfxpos + CHANNELS * 4;
  M.sfx = M.registers + CHANNELS * REGISTER;
  M.samples = M.sfx + WAVES;
  M.music = M.sfx + SFX_BYTES;
  M.tracks = M.music + PATTERNS * PATTERN;
  M.music_state = M.music + MUSIC_BYTES;
  M.stereo = (M.music_state + 4 + 7) & ~7;
  M.persistent = M.stereo + 8;
  M.flags = M.persistent + 1024;
  M.font = M.flags + FLAGS;
  M.gpmapping = M.font + 2 * FONT_STRIDE;
  M.pcm = M.gpmapping + 32;
  M.end = M.pcm + 128;
  if (M.persistent != pmem || M.end > ram_size) return 0;
  M.b_tiles = M.screen;
  M.b_sprites = M.b_tiles + TILES;
  M.b_map = M.b_sprites + TILES;
  M.b_sfx = M.b_map + M.map_w * M.map_h;
  M.b_music = M.b_sfx + SFX_BYTES;
  M.b_flags = M.b_music + MUSIC_BYTES;
  M.b_palette = M.b_flags + FLAGS;
  M.bank = M.b_palette + 2 * PAL_BYTES;
  return 1;
}

static u8 *bank(s32 i) {
  if (!T.banks[i]) T.banks[i] = calloc((size_t)M.bank, 1);
  return T.banks[i];
}

/* ---- vbanks ---------------------------------------------------------------- */

static u8 *vbank0(void) { return T.vbank_id ? T.vbank : R; }
static u8 *vbank1(void) { return T.vbank_id ? R : T.vbank; }

static void swap_vram(void) {
  /* Swap in chunks: the vram can be megabytes. */
  enum { CHUNK = 4096 };
  static u8 tmp[CHUNK];
  for (s32 at = 0; at < M.vram; at += CHUNK) {
    s32 n = MIN(CHUNK, M.vram - at);
    memcpy(tmp, R + at, (size_t)n);
    memcpy(R + at, T.vbank + at, (size_t)n);
    memcpy(T.vbank + at, tmp, (size_t)n);
  }
}

static s32 api_vbank(s32 id) {
  s32 prev = T.vbank_id;
  if ((id == 0 || id == 1) && T.vbank_id != id) {
    swap_vram();
    T.vbank_id = id;
  }
  return prev;
}

/* ---- sync: cartridge banks <-> RAM ------------------------------------------ */

static void api_sync(u32 mask, s32 b, int to_cart) {
  static const u32 SECTIONS = 8, ALL = (1 << 8) - 1;
  if (mask == 0) mask = ALL;
  mask &= ~T.synced & ALL;
  u8 *cart = bank(b);
  if (!cart) return;
  for (u32 i = 0; i < SECTIONS; i++) {
    if (!(mask & (1u << i))) continue;
    s32 ram = 0, at = 0, size = 0;
    switch (i) {
      case 0: ram = M.tiles; at = M.b_tiles; size = TILES; break;
      case 1: ram = M.sprites; at = M.b_sprites; size = TILES; break;
      case 2: ram = M.map; at = M.b_map; size = M.map_w * M.map_h; break;
      case 3: ram = M.sfx; at = M.b_sfx; size = SFX_BYTES; break;
      case 4: ram = M.music; at = M.b_music; size = MUSIC_BYTES; break;
      case 5: {
        /* The palette syncs both vbanks' (the second only if the bank has one). */
        u8 *p0 = vbank0() + M.palette, *p1 = vbank1() + M.palette;
        u8 *c0 = cart + M.b_palette, *c1 = cart + M.b_palette + PAL_BYTES;
        int has1 = !empty(c1, PAL_BYTES);
        if (to_cart) memcpy(c0, p0, PAL_BYTES); else memcpy(p0, c0, PAL_BYTES);
        if (has1) { if (to_cart) memcpy(c1, p1, PAL_BYTES); else memcpy(p1, c1, PAL_BYTES); }
        continue;
      }
      case 6: ram = M.flags; at = M.b_flags; size = FLAGS; break;
      case 7: ram = 0; at = 0; size = M.screen; break;
    }
    if (to_cart) memcpy(cart + at, R + ram, (size_t)size);
    else memcpy(R + ram, cart + at, (size_t)size);
  }
  T.synced |= mask;
}

/* ---- the cartridge ----------------------------------------------------------- */

void tic_cart(const uint8_t *bytes, int len) {
  for (s32 i = 0; i < BANKS; i++) if (T.banks[i]) memset(T.banks[i], 0, (size_t)M.bank);
  const u8 *end = bytes + len;
  /* Two passes, as TIC-80's loader: the palette first, then everything else. */
  for (int pass = 0; pass < 2; pass++) {
    const u8 *p = bytes;
    while (p + 4 <= end) {
      s32 type = p[0] & 31, b = p[0] >> 5;
      s32 size = p[1] | (p[2] << 8);
      s32 length = size == 0 && (type == 5 || type == 19) ? 65536 : size;
      const u8 *data = p + 4;
      s32 avail = (s32)(end - data);
      s32 n = MIN(size ? size : 65536, avail);
      u8 *cart = bank(b);
#define LOAD(at, max) memcpy(cart + (at), data, (size_t)MIN((max), n))
      if (pass == 0) {
        if (type == 12) LOAD(M.b_palette, 2 * PAL_BYTES);
        else if (type == 17) {
          memcpy(cart + M.b_palette, SWEETIE16, sizeof SWEETIE16);
          memcpy(cart + M.b_sfx, WAVEFORMS, sizeof WAVEFORMS);
        }
      } else {
        switch (type) {
          case 1: LOAD(M.b_tiles, TILES); break;
          case 2: LOAD(M.b_sprites, TILES); break;
          case 4: LOAD(M.b_map, M.map_w * M.map_h); break;
          case 9: LOAD(M.b_sfx + WAVES, SFX_COUNT * SAMPLE); break;
          case 10: LOAD(M.b_sfx, WAVES); break;
          case 14: LOAD(M.b_music + PATTERNS * PATTERN, TRACKS * TRACK); break;
          case 15: LOAD(M.b_music, PATTERNS * PATTERN); break;
          case 6: LOAD(M.b_flags, FLAGS); break;
          case 18: LOAD(0, M.screen); break;
          default: break;
        }
      }
#undef LOAD
      p = data + length;
    }
    /* Ancient carts without a palette get DB16. */
    if (pass == 0 && empty(bank(0) + M.b_palette, PAL_BYTES)) memcpy(bank(0) + M.b_palette, DB16, sizeof DB16);
  }
}

/* ---- reset and boot (TIC-80's tic_api_reset, cart2ram) -------------------------- */

static void sound_clear(void);
static void api_music(s32 index, s32 frame, s32 row, int loop, int sustain, s32 tempo, s32 speed);

static void reset_vbank(void) {
  memset(R + M.vars, 0, 4);
  for (s32 i = 0; i < PALETTE_SIZE; i++) R[M.mapping + i] = (u8)i;
  memcpy(R + M.palette, bank(0) + M.b_palette, PAL_BYTES);
  R[M.blit] = (u8)((R[M.blit] & 0xf0) | 2);
}

static void font2ram(void) {
  u8 *f = R + M.font;
  memcpy(f, FONT_REGULAR, FONT_DATA);
  memset(f + FONT_DATA, 0, 8);
  f[FONT_DATA] = 6;
  f[FONT_DATA + 1] = 6;
  memcpy(f + FONT_STRIDE, FONT_SMALL, FONT_DATA);
  memset(f + FONT_STRIDE + FONT_DATA, 0, 8);
  f[FONT_STRIDE + FONT_DATA] = 4;
  f[FONT_STRIDE + FONT_DATA + 1] = 6;
}

void tic_reset(void) {
  /* tic_api_reset: input survives; everything else of the console's state starts again. */
  u32 kb = T.keyboard.now, gp = T.gamepads.now;
  memset(&T.gamepads, 0, sizeof T.gamepads);
  memset(&T.keyboard, 0, sizeof T.keyboard);
  T.keyboard.now = kb;
  T.gamepads.now = gp;
  memset(T.regs, 0, sizeof T.regs);
  memset(T.ring, 0, sizeof T.ring);
  T.ring_head = T.ring_tail = 0;
  memset(&T.music, 0, sizeof T.music);
  memset(T.sfx, 0, sizeof T.sfx);
  T.synced = 0;
  T.vbank_id = 0;
  memset(T.vbank, 0, (size_t)M.vram);
  T.clip.l = 0; T.clip.t = 0; T.clip.r = M.width; T.clip.b = M.height;
  reset_vbank();
  api_vbank(1);
  reset_vbank();
  api_vbank(0);
  R[M.vars + 3] = 0x80; /* cursor: the arrow, system */
  R[M.input + 6] &= 0x7f; /* mouse: absolute */
  sound_clear();
  font2ram();
  T.frames = 0;
  T.reset = 0;
}

void tic_cart2ram(void) {
  /* The font, then bank 0 (its screen only if it has one). */
  font2ram();
  T.synced = 0;
  api_sync(empty(bank(0), M.screen) ? 0x7f : 0xff, 0, 0);
  T.synced = 0;
  T.reset = 0;
}

void tic_boot(void) {
  tic_reset();
  tic_cart2ram();
}

int tic_init(int width, int height, int ram_size, int pmem_address, int sample_rate) {
  free(T.ram);
  free(T.vbank);
  free(T.frame);
  for (s32 i = 0; i < BANKS; i++) free(T.banks[i]);
  free(T.samples);
  free(T.mix[0]);
  free(T.mix[1]);
  free(T.zbuffer);
  free(T.side_l);
  free(T.side_r);
  free(T.side_u);
  free(T.side_v);
  memset(&T, 0, sizeof T);
  if (!layout(width, height, ram_size, pmem_address)) return 0;
  T.ram = calloc((size_t)ram_size, 1);
  T.ram_size = ram_size;
  T.vbank = calloc((size_t)M.vram, 1);
  T.frame = calloc((size_t)width * height, 4);
  T.sample_rate = sample_rate > 0 ? sample_rate : 44100;
  T.sample_frames = T.sample_rate / 60;
  T.samples = calloc((size_t)T.sample_frames * 2, sizeof(int16_t));
  T.mix[0] = calloc((size_t)T.sample_frames + 2, sizeof(float));
  T.mix[1] = calloc((size_t)T.sample_frames + 2, sizeof(float));
  T.side_l = calloc((size_t)height, sizeof(int16_t));
  T.side_r = calloc((size_t)height, sizeof(int16_t));
  T.side_u = calloc((size_t)height, sizeof(s32));
  T.side_v = calloc((size_t)height, sizeof(s32));
  if (!T.ram || !T.vbank || !T.frame || !T.samples || !T.mix[0] || !T.mix[1] || !T.side_l || !T.side_r || !T.side_u || !T.side_v || !bank(0)) return 0;
  R = T.ram;
  /* Until a cartridge says otherwise: a new cart's defaults, Sweetie 16 and the default waveforms. */
  memcpy(bank(0) + M.b_palette, SWEETIE16, sizeof SWEETIE16);
  memcpy(bank(0) + M.b_sfx, WAVEFORMS, sizeof WAVEFORMS);
  tic_boot();
  return 1;
}

uint8_t *tic_ram(void) { return T.ram; }
uint32_t *tic_frame(void) { return T.frame; }
int16_t *tic_samples(void) { return T.samples; }
int tic_sample_count(void) { return T.sample_frames * 2; }

/* ---- drawing (TIC-80's src/core/draw.c) ------------------------------------------- */

typedef struct {
  u32 page_orig, bank_orig, nb_pages, bank_size, sheet_width, tile_width, ptr_size;
  u8 (*peek)(const void *, u32);
} Segment;

static const Segment SEGMENTS[] = {
  {0, 0, 1, 256, 16, 8, 8, peek1},     /* system gfx */
  {0, 0, 1, 256, 16, 8, 8, peek1},     /* system font */
  {0, 0, 1, 256, 16, 8, TILE, peek8},  /* default p0 bg */
  {0, 1, 1, 256, 16, 8, TILE, peek8},  /* default p0 fg */
  {0, 0, 2, 512, 32, 16, TILE, peek2}, /* 2bpp p0 bg */
  {1, 0, 2, 512, 32, 16, TILE, peek2}, /* 2bpp p1 bg */
  {0, 1, 2, 512, 32, 16, TILE, peek2}, /* 2bpp p0 fg */
  {1, 1, 2, 512, 32, 16, TILE, peek2}, /* 2bpp p1 fg */
  {0, 0, 4, 1024, 64, 32, TILE, peek1}, /* 1bpp p0 bg */
  {1, 0, 4, 1024, 64, 32, TILE, peek1}, /* 1bpp p1 bg */
  {2, 0, 4, 1024, 64, 32, TILE, peek1}, /* 1bpp p2 bg */
  {3, 0, 4, 1024, 64, 32, TILE, peek1}, /* 1bpp p3 bg */
  {0, 1, 4, 1024, 64, 32, TILE, peek1}, /* 1bpp p0 fg */
  {1, 1, 4, 1024, 64, 32, TILE, peek1}, /* 1bpp p1 fg */
  {2, 1, 4, 1024, 64, 32, TILE, peek1}, /* 1bpp p2 fg */
  {3, 1, 4, 1024, 64, 32, TILE, peek1}, /* 1bpp p3 fg */
};

typedef struct { const Segment *segment; u8 *ptr; } Sheet;
typedef struct { const Segment *segment; u32 offset; u8 *ptr; } TilePtr;

static Sheet sheet_for(u8 segment) {
  segment &= 15;
  return (Sheet){&SEGMENTS[segment], R + (segment < 2 ? M.font : M.tiles)};
}

static TilePtr gettile(const Sheet *sheet, s32 index, int local) {
  enum { Cols = 16, Size = 8 };
  const Segment *s = sheet->segment;
  s32 bank_, page, iy, ix;
  if (local) {
    index &= 255;
    bank_ = (s32)s->bank_orig;
    page = (s32)s->page_orig;
    iy = index / Cols;
    ix = index % Cols;
  } else {
    div_t ia = div(index, (int)s->bank_size);
    div_t ib = div(ia.rem, (int)s->sheet_width);
    div_t ic = div(ib.rem, Cols);
    bank_ = (ia.quot + (s32)s->bank_orig) % 2;
    page = (ic.quot + (s32)s->page_orig) % (s32)s->nb_pages;
    iy = ib.quot % Cols;
    ix = ic.rem;
  }
  div_t xdiv = div(ix, (int)s->nb_pages);
  u32 ptr_offset = (u32)((bank_ * Cols + iy) * Cols + page * Cols / (s32)s->nb_pages + xdiv.quot);
  return (TilePtr){s, (u32)(xdiv.rem * Size), sheet->ptr + s->ptr_size * ptr_offset};
}

static inline u8 tilepix(const TilePtr *t, s32 x, s32 y) { return t->segment->peek(t->ptr, t->offset + (u32)x + (u32)y * t->segment->tile_width); }

static inline u8 sheetpix(const Sheet *sheet, s32 x, s32 y) {
  const Segment *s = sheet->segment;
  u32 bank_offset = (u32)((((y >> 7) + (s32)s->bank_orig) & 1) << 8);
  u32 page_offset = ((((u32)(x >> 7) + s->page_orig) % s->nb_pages) << 4) / s->nb_pages;
  u32 tile_index = bank_offset + (u32)(((y & 127) >> 3) << 4) + page_offset + (u32)(x & 127) / s->tile_width;
  u32 pix_addr = ((u32)x & (s->tile_width - 1)) + (u32)(y & 7) * s->tile_width;
  return s->peek(sheet->ptr + tile_index * s->ptr_size, pix_addr);
}

static u8 *palette_map(const u8 *colors, s32 count) {
  static u8 mapping[PALETTE_SIZE];
  memcpy(mapping, R + M.mapping, PALETTE_SIZE);
  for (s32 i = 0; i < count; i++) mapping[colors[i]] = TRANSPARENT;
  return mapping;
}

static inline u8 map_color(u8 color) { return R[M.mapping + color]; }

static inline void set_pixel(s32 x, s32 y, u8 color) {
  if (x < T.clip.l || y < T.clip.t || x >= T.clip.r || y >= T.clip.b) return;
  R[y * M.width + x] = color;
}

static inline u8 get_pixel(s32 x, s32 y) { return x < 0 || y < 0 || x >= M.width || y >= M.height ? 0 : R[y * M.width + x]; }

#define EARLY_CLIP(x, y, w, h) ((((y) + (h)-1) < T.clip.t) || (((x) + (w)-1) < T.clip.l) || ((y) >= T.clip.b) || ((x) >= T.clip.r))

static void hline(s32 x, s32 y, s32 width, u8 color) {
  if (y < T.clip.t || T.clip.b <= y) return;
  s32 xl = MAX(x, T.clip.l), xr = MIN(x + width, T.clip.r);
  if (xl < xr) memset(R + y * M.width + xl, color, (size_t)(xr - xl));
}

static void vline(s32 x, s32 y, s32 height, u8 color) {
  if (x < T.clip.l || T.clip.r <= x) return;
  s32 yl = y < 0 ? 0 : y, yr = y + height >= M.height ? M.height : y + height;
  for (s32 i = yl; i < yr; ++i) set_pixel(x, i, color);
}

static void draw_rect(s32 x, s32 y, s32 w, s32 h, u8 color) {
  for (s32 i = y; i < y + h; ++i) hline(x, i, w, color);
}

static void draw_rectb(s32 x, s32 y, s32 w, s32 h, u8 color) {
  hline(x, y, w, color);
  hline(x, y + h - 1, w, color);
  vline(x, y, h, color);
  vline(x + w - 1, y, h, color);
}

#define REVERT(X) (7 - (X))
#define TILE_BODY(X, Y)                                                                 \
  do {                                                                                  \
    for (s32 py = sy; py < ey; py++, y++) {                                             \
      s32 xx = x;                                                                       \
      for (s32 px = sx; px < ex; px++, xx++) {                                          \
        u8 c = mapping[tilepix(tile, (X), (Y))];                                        \
        if (c != TRANSPARENT) R[y * M.width + xx] = c;                                  \
      }                                                                                 \
    }                                                                                   \
  } while (0)

static void draw_tile(const TilePtr *tile, s32 x, s32 y, const u8 *colors, s32 count, s32 scale, s32 flip, s32 rotate) {
  u8 *mapping = palette_map(colors, count);
  rotate &= 3;
  u32 orientation = (u32)flip & 3;
  if (rotate == 1) orientation ^= 1;
  else if (rotate == 2) orientation ^= 3;
  else if (rotate == 3) orientation ^= 2;
  if (rotate == 1 || rotate == 3) orientation |= 4;
  if (scale == 1) {
    s32 sx = T.clip.l - x; if (sx < 0) sx = 0;
    s32 sy = T.clip.t - y; if (sy < 0) sy = 0;
    s32 ex = T.clip.r - x; if (ex > 8) ex = 8;
    s32 ey = T.clip.b - y; if (ey > 8) ey = 8;
    y += sy;
    x += sx;
    switch (orientation) {
      case 4: TILE_BODY(py, px); break;
      case 6: TILE_BODY(REVERT(py), px); break;
      case 5: TILE_BODY(py, REVERT(px)); break;
      case 7: TILE_BODY(REVERT(py), REVERT(px)); break;
      case 0: TILE_BODY(px, py); break;
      case 2: TILE_BODY(px, REVERT(py)); break;
      case 1: TILE_BODY(REVERT(px), py); break;
      case 3: TILE_BODY(REVERT(px), REVERT(py)); break;
    }
    return;
  }
  if (EARLY_CLIP(x, y, 8 * scale, 8 * scale)) return;
  for (s32 py = 0; py < 8; py++, y += scale) {
    s32 xx = x;
    for (s32 px = 0; px < 8; px++, xx += scale) {
      s32 ix = orientation & 1 ? 8 - px - 1 : px;
      s32 iy = orientation & 2 ? 8 - py - 1 : py;
      if (orientation & 4) { s32 t = ix; ix = iy; iy = t; }
      u8 c = mapping[tilepix(tile, ix, iy)];
      if (c != TRANSPARENT) draw_rect(xx, y, scale, scale, c);
    }
  }
}

static void draw_sprite(s32 index, s32 x, s32 y, s32 w, s32 h, const u8 *colors, s32 count, s32 scale, s32 flip, s32 rotate) {
  if (index < 0) return;
  rotate &= 3;
  flip &= 3;
  Sheet sheet = sheet_for(R[M.blit]);
  if (w == 1 && h == 1) {
    TilePtr tile = gettile(&sheet, index, 0);
    draw_tile(&tile, x, y, colors, count, scale, flip, rotate);
    return;
  }
  s32 step = 8 * scale, cols = (s32)sheet.segment->sheet_width;
  if (EARLY_CLIP(x, y, w * step, h * step)) return;
  for (s32 i = 0; i < w; i++)
    for (s32 j = 0; j < h; j++) {
      s32 mx = i, my = j;
      if (flip == 1 || flip == 3) mx = w - 1 - i;
      if (flip == 2 || flip == 3) my = h - 1 - j;
      if (rotate == 2) { mx = w - 1 - mx; my = h - 1 - my; }
      else if (rotate == 1) { if (flip == 0 || flip == 3) my = h - 1 - my; else mx = w - 1 - mx; }
      else if (rotate == 3) { if (flip == 0 || flip == 3) mx = w - 1 - mx; else my = h - 1 - my; }
      TilePtr tile = gettile(&sheet, index + mx + my * cols, 0);
      if (rotate == 0 || rotate == 2) draw_tile(&tile, x + i * step, y + j * step, colors, count, scale, flip, rotate);
      else draw_tile(&tile, x + j * step, y + i * step, colors, count, scale, flip, rotate);
    }
}

typedef struct { s32 index, flip, rotate; } Retile;
typedef void (*RemapFn)(void *data, s32 x, s32 y, Retile *r);

static void draw_map(s32 x, s32 y, s32 width, s32 height, s32 sx, s32 sy, const u8 *colors, s32 count, s32 scale, RemapFn remap, void *data) {
  const s32 size = 8 * scale;
  Sheet sheet = sheet_for(R[M.blit]);
  for (s32 j = y, jj = sy; j < y + height; j++, jj += size)
    for (s32 i = x, ii = sx; i < x + width; i++, ii += size) {
      s32 mi = modulo(i, M.map_w), mj = modulo(j, M.map_h);
      Retile r = {R[M.map + mi + mj * M.map_w], 0, 0};
      if (remap) remap(data, mi, mj, &r);
      TilePtr tile = gettile(&sheet, r.index, 1);
      draw_tile(&tile, ii, jj, colors, count, scale, r.flip, r.rotate);
    }
}

static s32 draw_char(const TilePtr *ch, s32 x, s32 y, s32 scale, int fixed, const u8 *mapping) {
  s32 j = 0, start = 0, end = 8;
  if (!fixed) {
    for (s32 i = 0; i < 8; i++) {
      for (j = 0; j < 8; j++) if (mapping[tilepix(ch, i, j)] != TRANSPARENT) break;
      if (j < 8) break; else start++;
    }
    for (s32 i = 7; i >= start; i--) {
      for (j = 0; j < 8; j++) if (mapping[tilepix(ch, i, j)] != TRANSPARENT) break;
      if (j < 8) break; else end--;
    }
  }
  s32 width = end - start;
  if (EARLY_CLIP(x, y, 8 * scale, 8 * scale)) return width;
  for (s32 i = 0, col = start, xs = x; i < width; i++, col++, xs += scale)
    for (s32 r = 0, ys = y; r < 8; r++, ys += scale) {
      u8 c = tilepix(ch, col, r);
      if (mapping[c] != TRANSPARENT) draw_rect(xs, ys, scale, scale, mapping[c]);
    }
  return width;
}

static s32 draw_text(const Sheet *face, const char *text, s32 x, s32 y, s32 width, s32 height, int fixed, const u8 *mapping, s32 scale, int alt) {
  s32 pos = x, max = x;
  char sym;
  while ((sym = *text++)) {
    if (sym == '\n') {
      if (pos > max) max = pos;
      pos = x;
      y += height * scale;
    } else {
      TilePtr ch = gettile(face, alt * 128 + sym, 1);
      s32 size = draw_char(&ch, pos, y, scale, fixed, mapping);
      pos += ((!fixed && size) ? size + 1 : width) * scale;
    }
  }
  return pos > max ? pos - x : max - x;
}

static void api_clip(s32 x, s32 y, s32 w, s32 h) {
  T.clip.l = x; T.clip.t = y; T.clip.r = x + w; T.clip.b = y + h;
  if (T.clip.l < 0) T.clip.l = 0;
  if (T.clip.t < 0) T.clip.t = 0;
  if (T.clip.r > M.width) T.clip.r = M.width;
  if (T.clip.b > M.height) T.clip.b = M.height;
}

static void api_cls(u8 color) {
  color = map_color(color);
  if (T.clip.l == 0 && T.clip.t == 0 && T.clip.r == M.width && T.clip.b == M.height) {
    memset(R, color, (size_t)M.screen);
    if (T.zbuffer) memset(T.zbuffer, 0, (size_t)M.screen * sizeof(double));
  } else {
    for (s32 y = T.clip.t; y < T.clip.b; ++y)
      for (s32 x = T.clip.l; x < T.clip.r; ++x) {
        R[y * M.width + x] = color;
        if (T.zbuffer) T.zbuffer[y * M.width + x] = 0;
      }
  }
}

/* Ellipses and circles: an outline into a sides buffer, then filled between them. */
static void side_init(void) { for (s32 i = 0; i < M.height; i++) T.side_l[i] = (int16_t)M.width, T.side_r[i] = -1; }
static void side_pixel(s32 x, s32 y, u8 c) {
  (void)c;
  if (y >= 0 && y < M.height) {
    if (x < T.side_l[y]) T.side_l[y] = (int16_t)x;
    if (x > T.side_r[y]) T.side_r[y] = (int16_t)x;
  }
}

static void ellipse(s32 x0, s32 y0, s32 x1, s32 y1, u8 color, void (*pix)(s32, s32, u8)) {
  if (x0 > x1 || y0 > y1) return;
  int64_t a = abs(x1 - x0), b = abs(y1 - y0), b1 = b & 1;
  int64_t dx = 4 * (1 - a) * b * b, dy = 4 * (b1 + 1) * a * a;
  int64_t err = dx + dy + b1 * a * a, e2;
  if (x0 > x1) { x0 = x1; x1 += (s32)a; }
  if (y0 > y1) y0 = y1;
  y0 += (s32)((b + 1) / 2);
  y1 = y0 - (s32)b1;
  a *= 8 * a;
  b1 = 8 * b * b;
  do {
    pix(x1, y0, color);
    pix(x0, y0, color);
    pix(x0, y1, color);
    pix(x1, y1, color);
    e2 = 2 * err;
    if (e2 <= dy) { y0++; y1--; err += dy += a; }
    if (e2 >= dx || 2 * err > dy) { x0++; x1--; err += dx += b1; }
  } while (x0 <= x1);
  while (y0 - y1 < b) {
    pix(x0 - 1, y0, color);
    pix(x1 + 1, y0++, color);
    pix(x0 - 1, y1, color);
    pix(x1 + 1, y1--, color);
  }
}

static void side_fill(s32 y0, s32 y1, u8 color) {
  s32 yt = MAX(T.clip.t, y0), yb = MIN(T.clip.b, y1 + 1);
  for (s32 y = yt; y < yb; y++) {
    s32 xl = MAX(T.side_l[y], T.clip.l), xr = MIN(T.side_r[y] + 1, T.clip.r);
    if (xl < xr) memset(R + y * M.width + xl, color, (size_t)(xr - xl));
  }
}

static void elli(s32 x, s32 y, s32 a, s32 b, u8 color) {
  side_init();
  ellipse(x - a, y - b, x + a, y + b, 0, side_pixel);
  side_fill(y - b, y + b + 1, map_color(color));
}

static void ellib(s32 x, s32 y, s32 a, s32 b, u8 color) { ellipse(x - a, y - b, x + a, y + b, map_color(color), set_pixel); }

static float init_line(float *x0, float *x1, float *y0, float *y1) {
  if (*y0 > *y1) {
    float t = *x0; *x0 = *x1; *x1 = t;
    t = *y0; *y0 = *y1; *y1 = t;
  }
  float t = (*x1 - *x0) / (*y1 - *y0);
  if (*y0 < 0) *x0 -= *y0 * t, *y0 = 0;
  if (*y1 > M.width) *x1 += (M.width - *y0) * t, *y1 = (float)M.width;
  return t;
}

static void draw_line(float x0, float y0, float x1, float y1, u8 color) {
  if (fabsf(x0 - x1) < fabsf(y0 - y1))
    for (float t = init_line(&x0, &x1, &y0, &y1); y0 < y1; y0++, x0 += t) set_pixel((s32)x0, (s32)y0, color);
  else
    for (float t = init_line(&y0, &y1, &x0, &x1); x0 < x1; x0++, y0 += t) set_pixel((s32)x0, (s32)y0, color);
  set_pixel((s32)x1, (s32)y1, color);
}

/* paint: Heckbert's seed fill, as TIC-80. */
typedef struct { s32 y, xl, xr, dy; } FillSeg;
enum { FILLQ = 400 };
static struct { FillSeg seg[FILLQ]; size_t ini, outi; } fillq;

static void fill_push(s32 y, s32 xl, s32 xr, s32 dy) {
  size_t next = (fillq.ini + 1) % FILLQ;
  if (next == fillq.outi) return;
  if (y + dy < T.clip.t || y + dy >= T.clip.b) return;
  fillq.seg[fillq.ini] = (FillSeg){y, xl, xr, dy};
  fillq.ini = next;
}

static int fill_pop(s32 *y, s32 *xl, s32 *xr, s32 *dy) {
  if (fillq.ini == fillq.outi) return 0;
  FillSeg *s = &fillq.seg[fillq.outi];
  *y = s->y + s->dy; *xl = s->xl; *xr = s->xr; *dy = s->dy;
  fillq.outi = (fillq.outi + 1) % FILLQ;
  return 1;
}

static inline int fill_inside(u8 pix, u8 paint, u8 border, u8 original) { return border == 255 ? pix == original : pix != paint && pix != border; }

static void flood_fill(s32 x, s32 y, u8 color, u8 border) {
  if (x < T.clip.l || y < T.clip.t || x >= T.clip.r || y >= T.clip.b) return;
  u8 ov = get_pixel(x, y);
  if (ov == color || ov == border) return;
  fillq.ini = fillq.outi = 0;
  fill_push(y, x, x, 1);
  fill_push(y + 1, x, x, -1);
  s32 l, x1, x2, dy;
  while (fill_pop(&y, &x1, &x2, &dy)) {
    for (x = x1; x >= T.clip.l && fill_inside(get_pixel(x, y), color, border, ov); x--) R[y * M.width + x] = color;
    if (x >= x1) goto skip;
    l = x + 1;
    if (l < x1) fill_push(y, l, x1 - 1, -dy);
    x = x1 + 1;
    do {
      for (; x < T.clip.r && fill_inside(get_pixel(x, y), color, border, ov); x++) R[y * M.width + x] = color;
      fill_push(y, l, x - 1, dy);
      if (x > x2 + 1) fill_push(y, x2 + 1, x - 1, -dy);
    skip:
      for (x++; x <= x2 && !fill_inside(get_pixel(x, y), color, border, ov); x++);
      l = x;
    } while (x <= x2);
  }
}

/* Triangles: edge functions over the bounding box, as TIC-80 (tri, ttri). */
typedef struct { double x, y; } Vec2;
typedef struct { double d[3]; } Vec3;
typedef struct { Vec2 p; Vec3 t; } TexVert; /* x, y; then u, v, z */
typedef struct { void *data; const Vec2 *v[3]; Vec3 w; } ShaderAttr;
typedef u8 (*Shader)(const ShaderAttr *a, s32 pixel);

static inline double edge(const Vec2 *a, const Vec2 *b, const Vec2 *c) { return (b->x - a->x) * (c->y - a->y) - (b->y - a->y) * (c->x - a->x); }

static void draw_tri(const Vec2 *v0, const Vec2 *v1, const Vec2 *v2, Shader shader, void *data) {
  ShaderAttr a = {data, {v0, v1, v2}, {{0, 0, 0}}};
  s32 minx = (s32)floor(MIN(MIN(v0->x, v1->x), v2->x)), miny = (s32)floor(MIN(MIN(v0->y, v1->y), v2->y));
  s32 maxx = (s32)ceil(MAX(MAX(v0->x, v1->x), v2->x)), maxy = (s32)ceil(MAX(MAX(v0->y, v1->y), v2->y));
  minx = MAX(minx, T.clip.l);
  miny = MAX(miny, T.clip.t);
  maxx = MIN(maxx, T.clip.r);
  maxy = MIN(maxy, T.clip.b);
  if (minx >= maxx || miny >= maxy) return;
  double area = edge(a.v[0], a.v[1], a.v[2]);
  if ((s32)floor(area) == 0) return;
  if (area < 0.0) {
    const Vec2 *t = a.v[1]; a.v[1] = a.v[2]; a.v[2] = t;
    area = -area;
  }
  Vec2 d[3];
  Vec3 s;
  for (s32 i = 0; i != 3; ++i) {
    const double center = 0.5 - FLT_EPSILON;
    Vec2 p = {minx + center, miny + center};
    s32 c = (i + 1) % 3, n = (i + 2) % 3;
    d[i].x = (a.v[c]->y - a.v[n]->y) / area;
    d[i].y = (a.v[n]->x - a.v[c]->x) / area;
    s.d[i] = edge(a.v[c], a.v[n], &p) / area;
  }
  for (s32 y = miny, start = miny * M.width + minx; y < maxy; ++y, start += M.width) {
    for (s32 i = 0; i != 3; ++i) a.w.d[i] = s.d[i];
    for (s32 x = minx, pixel = start; x < maxx; ++x, ++pixel) {
      if (a.w.d[0] > -DBL_EPSILON && a.w.d[1] > -DBL_EPSILON && a.w.d[2] > -DBL_EPSILON) {
        u8 c = shader(&a, pixel);
        if (c != TRANSPARENT) R[pixel] = c;
      }
      for (s32 i = 0; i != 3; ++i) a.w.d[i] += d[i].x;
    }
    for (s32 i = 0; i != 3; ++i) s.d[i] += d[i].y;
  }
}

static u8 color_shader(const ShaderAttr *a, s32 pixel) { (void)pixel; return *(u8 *)a->data; }

typedef struct { Sheet sheet; u8 *mapping; const u8 *map; const u8 *vram; int depth; } TexData;

static inline int shader_start(const ShaderAttr *a, Vec3 *vars, s32 pixel) {
  TexData *data = a->data;
  if (data->depth) {
    vars->d[2] = 0;
    for (s32 i = 0; i != 3; ++i) vars->d[2] += a->w.d[i] * ((const TexVert *)a->v[i])->t.d[2];
    if (!(T.zbuffer[pixel] < vars->d[2])) return 0;
  }
  vars->d[0] = vars->d[1] = 0;
  for (s32 i = 0; i != 3; ++i) {
    const TexVert *t = (const TexVert *)a->v[i];
    vars->d[0] += a->w.d[i] * t->t.d[0];
    vars->d[1] += a->w.d[i] * t->t.d[1];
  }
  if (data->depth) vars->d[0] /= vars->d[2], vars->d[1] /= vars->d[2];
  return 1;
}

static inline u8 shader_end(const ShaderAttr *a, const Vec3 *vars, s32 pixel, u8 color) {
  TexData *data = a->data;
  if (data->depth && color != TRANSPARENT) T.zbuffer[pixel] = vars->d[2];
  return color;
}

static u8 tex_map_shader(const ShaderAttr *a, s32 pixel) {
  TexData *data = a->data;
  Vec3 vars;
  if (!shader_start(a, &vars, pixel)) return TRANSPARENT;
  s32 iu = modulo((s32)floor(vars.d[0]), M.map_w * 8), iv = modulo((s32)floor(vars.d[1]), M.map_h * 8);
  u8 idx = data->map[(iv >> 3) * M.map_w + (iu >> 3)];
  TilePtr tile = gettile(&data->sheet, idx, 1);
  return shader_end(a, &vars, pixel, data->mapping[tilepix(&tile, iu & 7, iv & 7)]);
}

static u8 tex_tile_shader(const ShaderAttr *a, s32 pixel) {
  TexData *data = a->data;
  Vec3 vars;
  if (!shader_start(a, &vars, pixel)) return TRANSPARENT;
  s32 sx = (s32)floor(vars.d[0]) & (s32)(128 * data->sheet.segment->nb_pages - 1);
  s32 sy = (s32)floor(vars.d[1]) & (128 * 2 - 1);
  return shader_end(a, &vars, pixel, data->mapping[sheetpix(&data->sheet, sx, sy)]);
}

static u8 tex_vbank_shader(const ShaderAttr *a, s32 pixel) {
  TexData *data = a->data;
  Vec3 vars;
  if (!shader_start(a, &vars, pixel)) return TRANSPARENT;
  s32 iu = modulo((s32)floor(vars.d[0]), M.width), iv = modulo((s32)floor(vars.d[1]), M.height);
  return shader_end(a, &vars, pixel, data->mapping[data->vram[iv * M.width + iu]]);
}

static void ttri(float x1, float y1, float x2, float y2, float x3, float y3, float u1, float v1, float u2, float v2, float u3, float v3, s32 src,
                 const u8 *colors, s32 count, float z1, float z2, float z3, int depth) {
  if (z1 < FLT_EPSILON || z2 < FLT_EPSILON || z3 < FLT_EPSILON) depth = 0;
  if (depth && !T.zbuffer) {
    T.zbuffer = calloc((size_t)M.screen, sizeof(double));
    if (!T.zbuffer) depth = 0;
  }
  TexData data = {sheet_for(R[M.blit]), palette_map(colors, count), R + M.map, T.vbank_id ? R : T.vbank, depth};
  TexVert t[3] = {{{x1, y1}, {{u1, v1, z1}}}, {{x2, y2}, {{u2, v2, z2}}}, {{x3, y3}, {{u3, v3, z3}}}};
  if (depth)
    for (s32 i = 0; i != 3; ++i) t[i].t.d[0] /= t[i].t.d[2], t[i].t.d[1] /= t[i].t.d[2], t[i].t.d[2] = 1.0 / t[i].t.d[2];
  /* The vbank texture is the other vbank as TIC-80 keeps it: the one not in RAM. */
  data.vram = T.vbank;
  static const Shader SHADERS[] = {tex_tile_shader, tex_map_shader, tex_vbank_shader};
  if (src >= 0 && src < 3) draw_tri(&t[0].p, &t[1].p, &t[2].p, SHADERS[src], &data);
}

/* textri: TIC-80's deprecated textured triangle (src/core/draw_dep.c). */
static void tex_line(float x0, float y0, float u0, float v0, float x1, float y1, float u1, float v1) {
  if (y1 < y0) {
    float t;
    t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t;
    t = u0; u0 = u1; u1 = t; t = v0; v0 = v1; v1 = t;
  }
  float dy = y1 - y0, step_x = x1 - x0, step_u = u1 - u0, step_v = v1 - v0;
  if ((s32)dy != 0) { step_x /= dy; step_u /= dy; step_v /= dy; }
  float x = x0, y = y0, u = u0, v = v0;
  if (y < .0f) {
    y = .0f - y;
    x += step_x * y; u += step_u * y; v += step_v * y;
    y = .0f;
  }
  s32 bot = (s32)y1;
  if (bot > M.height) bot = M.height;
  for (; y < bot; ++y) {
    s32 xx = (s32)x, yy = (s32)y;
    if (yy >= 0 && yy < M.height) {
      if (xx < T.side_l[yy]) { T.side_l[yy] = (int16_t)xx; T.side_u[yy] = (s32)(u * 65536.0f); T.side_v[yy] = (s32)(v * 65536.0f); }
      if (xx > T.side_r[yy]) T.side_r[yy] = (int16_t)xx;
    }
    x += step_x; u += step_u; v += step_v;
  }
}

static void textri(float x1, float y1, float x2, float y2, float x3, float y3, float u1, float v1, float u2, float v2, float u3, float v3, int use_map,
                   const u8 *colors, s32 count) {
  u8 *mapping = palette_map(colors, count);
  const u8 *map = R + M.map;
  Sheet sheet = sheet_for(R[M.blit]);
  float denom = (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  if (denom == 0.0) return;
  float id = 1.0f / denom;
  float dudx = ((u1 - u3) * (y2 - y3) - (u2 - u3) * (y1 - y3)) * id;
  float dvdx = ((v1 - v3) * (y2 - y3) - (v2 - v3) * (y1 - y3)) * id;
  s32 dudxs = (s32)(dudx * 65536.0f), dvdxs = (s32)(dvdx * 65536.0f);
  side_init();
  tex_line(x1, y1, u1, v1, x2, y2, u2, v2);
  tex_line(x2, y2, u2, v2, x3, y3, u3, v3);
  tex_line(x3, y3, u3, v3, x1, y1, u1, v1);
  for (s32 y = 0; y < M.height; y++) {
    s32 width = T.side_r[y] - T.side_l[y];
    if (y < T.clip.t || y > T.clip.b) width = 0;
    if (width <= 0) continue;
    s32 u = T.side_u[y], v = T.side_v[y], left = T.side_l[y], right = T.side_r[y];
    if (right > T.clip.r) right = T.clip.r;
    if (left < T.clip.l) {
      s32 dist = T.clip.l - T.side_l[y];
      u += dudxs * dist; v += dvdxs * dist;
      left = T.clip.l;
    }
    for (s32 x = left; x < right; ++x) {
      u8 c;
      if (use_map) {
        s32 mw = M.map_w * 8, mh = M.map_h * 8;
        s32 iu = (u >> 16) % mw, iv = (v >> 16) % mh;
        while (iu < 0) iu += mw;
        while (iv < 0) iv += mh;
        TilePtr tile = gettile(&sheet, map[(iv >> 3) * M.map_w + (iu >> 3)], 1);
        c = mapping[tilepix(&tile, iu & 7, iv & 7)];
      } else {
        c = mapping[sheetpix(&sheet, (u >> 16) & 127, (v >> 16) & 255)];
      }
      if (c != TRANSPARENT) set_pixel(x, y, c);
      u += dudxs; v += dvdxs;
    }
  }
}

/* ---- the frame (TIC-80's tic_core_blit) ---------------------------------------------- */

static void blitpal(const u8 *vram, u32 *pal) {
  const u8 *p = vram + M.palette;
  for (s32 i = 0; i < PALETTE_SIZE; i++, p += 3) pal[i] = 0xff000000u | ((u32)p[2] << 16) | ((u32)p[1] << 8) | p[0];
}

static int has_function(lua_State *L, const char *name) {
  lua_getglobal(L, name);
  int yes = lua_isfunction(L, -1);
  lua_pop(L, 1);
  return yes;
}

static int msgh(lua_State *L) {
  const char *msg = lua_tostring(L, 1);
  luaL_traceback(L, L, msg ? msg : "(error object is not a string)", 1);
  return 1;
}

static void int_callback(lua_State *L, const char *name, s32 value) {
  lua_pushcfunction(L, msgh);
  lua_getglobal(L, name);
  if (lua_isfunction(L, -1)) {
    lua_pushinteger(L, value);
    if (lua_pcall(L, 1, 0, -3) != LUA_OK) {
      cbx_core_callback_error(lua_tostring(L, -1));
      lua_pop(L, 1);
    }
  } else lua_pop(L, 1);
  lua_pop(L, 1);
}

void tic_blit(lua_State *L) {
  int scn = L && (has_function(L, "SCN") || has_function(L, "scanline")), bdr = L && has_function(L, "BDR");
  static u32 pal0[PALETTE_SIZE], pal1[PALETTE_SIZE];
  blitpal(vbank0(), pal0);
  blitpal(vbank1(), pal1);
  s32 top = M.margin_top;
  for (s32 row = 0; row < M.fullheight; row++) {
    if (bdr) int_callback(L, "BDR", row);
    if (scn) {
      s32 line = row == 0 ? 0 : (row > top && row < M.height + top) ? row - top : -1;
      if (line >= 0) { int_callback(L, "SCN", line); int_callback(L, "scanline", line); }
    }
    if (bdr || scn) { blitpal(vbank0(), pal0); blitpal(vbank1(), pal1); }
    if (row < top || row >= top + M.height) continue;
    s32 vr = row - top;
    u32 *out = T.frame + vr * M.width;
    const u8 *b0 = vbank0(), *b1 = vbank1();
    u8 clear = b1[M.vars];
    s8 ox0 = (s8)b0[M.vars + 1], oy0 = (s8)b0[M.vars + 2], ox1 = (s8)b1[M.vars + 1], oy1 = (s8)b1[M.vars + 2];
    if (!ox0 && !oy0 && !ox1 && !oy1) {
      const u8 *s0 = b0 + vr * M.width, *s1 = b1 + vr * M.width;
      for (s32 x = 0; x < M.width; x++) out[x] = s1[x] != clear ? pal1[s1[x]] : pal0[s0[x]];
    } else {
      s32 offset_y = M.height - top;
      s32 start0 = (row + oy0 + offset_y) % M.height * M.width, start1 = (row + oy1 + offset_y) % M.height * M.width;
      for (s32 x = M.width; x != 2 * M.width; ++x) {
        u8 p1 = b1[(x + ox1) % M.width + start1];
        out[x - M.width] = p1 != clear ? pal1[p1] : pal0[b0[(x + ox0) % M.width + start0]];
      }
    }
  }
}

/* ---- input (TIC-80's src/core/io.c) ------------------------------------------------- */

static u32 gamepads(void) { const u8 *p = R + M.input; return (u32)p[0] | ((u32)p[1] << 8) | ((u32)p[2] << 16) | ((u32)p[3] << 24); }
static u32 keyboard(void) { const u8 *p = R + M.input + 8; return (u32)p[0] | ((u32)p[1] << 8) | ((u32)p[2] << 16) | ((u32)p[3] << 24); }
static int key_in(u32 keys, s32 key) { for (s32 i = 0; i < KEY_BUFFER; i++) if (((keys >> (i * 8)) & 0xff) == (u32)key) return 1; return 0; }

static int api_key(s32 key) { return key > 0 ? key_in(keyboard(), key) : keyboard() != 0; }

static void tick_io(void) {
  u8 *codes = R + M.gpmapping;
  u32 pads = gamepads();
  for (s32 i = 0; i < 32; ++i) if (codes[i] && api_key(codes[i])) pads |= 1u << i;
  memcpy(R + M.input, (u8[4]){pads & 0xff, (pads >> 8) & 0xff, (pads >> 16) & 0xff, pads >> 24}, 4);
  for (s32 i = 0; i < 32; i++) {
    u32 mask = 1u << i, prev = T.gamepads.previous & mask, down = pads & mask;
    if (prev && prev == down) T.gamepads.holds[i]++;
    else T.gamepads.holds[i] = 0;
  }
  for (s32 i = 0; i < KEYS; i++) {
    if (key_in(T.keyboard.previous, i) && key_in(keyboard(), i)) T.keyboard.holds[i]++;
    else T.keyboard.holds[i] = 0;
  }
}

/* ---- sound (TIC-80's src/core/sound.c) --------------------------------------------------- */

static const uint16_t NOTE_FREQS[] = {0x10, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x18, 0x1a, 0x1c, 0x1d, 0x1f, 0x21, 0x23, 0x25, 0x27, 0x29, 0x2c, 0x2e, 0x31, 0x34, 0x37, 0x3a, 0x3e, 0x41, 0x45, 0x49, 0x4e, 0x52, 0x57, 0x5c, 0x62, 0x68, 0x6e, 0x75, 0x7b, 0x83, 0x8b, 0x93, 0x9c, 0xa5, 0xaf, 0xb9, 0xc4, 0xd0, 0xdc, 0xe9, 0xf7, 0x106, 0x115, 0x126, 0x137, 0x14a, 0x15d, 0x172, 0x188, 0x19f, 0x1b8, 0x1d2, 0x1ee, 0x20b, 0x22a, 0x24b, 0x26e, 0x293, 0x2ba, 0x2e4, 0x310, 0x33f, 0x370, 0x3a4, 0x3dc, 0x417, 0x455, 0x497, 0x4dd, 0x527, 0x575, 0x5c8, 0x620, 0x67d, 0x6e0, 0x749, 0x7b8, 0x82d, 0x8a9, 0x92d, 0x9b9, 0xa4d, 0xaea, 0xb90, 0xc40, 0xcfa, 0xdc0, 0xe91, 0xf6f, 0x105a, 0x1153, 0x125b, 0x1372, 0x149a, 0x15d4, 0x1720, 0x1880};

/* A sample's fields (tic_sample: 30 ticks of 2 bytes, then 2 bytes of settings, then 4 loops). */
static const u8 *sample_at(s32 i) { return R + M.samples + i * SAMPLE; }
static inline s32 s_volume(const u8 *s, s32 t) { return s[t * 2] & 15; }
static inline s32 s_wave(const u8 *s, s32 t) { return s[t * 2] >> 4; }
static inline s32 s_chord(const u8 *s, s32 t) { return s[t * 2 + 1] & 15; }
static inline s32 s_pitch(const u8 *s, s32 t) { return ((s8)s[t * 2 + 1]) >> 4; }
static inline s32 s_octave(const u8 *s) { return s[60] & 7; }
static inline s32 s_pitch16x(const u8 *s) { return (s[60] >> 3) & 1; }
static inline s32 s_speed(const u8 *s) { return ((s8)(s[60] << 1)) >> 5; }
static inline s32 s_reverse(const u8 *s) { return s[60] >> 7; }
static inline s32 s_note(const u8 *s) { return s[61] & 15; }
static inline s32 s_stereo_left(const u8 *s) { return (s[61] >> 4) & 1; }
static inline s32 s_stereo_right(const u8 *s) { return (s[61] >> 5) & 1; }
static inline s32 s_loop_start(const u8 *s, s32 i) { return s[62 + i] & 15; }
static inline s32 s_loop_size(const u8 *s, s32 i) { return s[62 + i] >> 4; }

static inline s32 speed3(s32 v) { return ((s8)(v << 5)) >> 5; } /* a signed 3-bit field */

static s8 *music_status_byte(void) { return (s8 *)(R + M.music_state); }
static inline s32 ms_track(void) { return ((s8 *)(R + M.music_state))[0]; }
static inline s32 ms_status(void) { return (R[M.music_state + 3] >> 1) & 3; }
static inline s32 ms_loop(void) { return R[M.music_state + 3] & 1; }
static inline s32 ms_sustain(void) { return (R[M.music_state + 3] >> 3) & 1; }
static void ms_set_status(s32 v) { R[M.music_state + 3] = (u8)((R[M.music_state + 3] & ~6) | ((v & 3) << 1)); }

static const u8 *track_at(s32 i) { return R + M.tracks + i * TRACK; }
static inline s32 tr_tempo(const u8 *t) { return (s8)t[FRAMES * TRACK_PATTERNS_SIZE]; }
static inline s32 tr_rows(const u8 *t) { return t[FRAMES * TRACK_PATTERNS_SIZE + 1]; }
static inline s32 tr_speed(const u8 *t) { return (s8)t[FRAMES * TRACK_PATTERNS_SIZE + 2]; }

static s32 pattern_id(const u8 *track, s32 frame, s32 channel) {
  uint64_t data = 0;
  for (s32 b = 0; b < TRACK_PATTERNS_SIZE; b++) data |= (uint64_t)track[frame * TRACK_PATTERNS_SIZE + b] << (8 * b);
  return (s32)((data >> (channel * 6)) & 63);
}

/* A track row (tic_track_row, 3 bytes). */
static inline s32 row_note(const u8 *r) { return r[0] & 15; }
static inline s32 row_param1(const u8 *r) { return r[0] >> 4; }
static inline s32 row_param2(const u8 *r) { return r[1] & 15; }
static inline s32 row_command(const u8 *r) { return (r[1] >> 4) & 7; }
static inline s32 row_sfx(const u8 *r) { return ((r[1] >> 7) << 5) | (r[2] & 31); }
static inline s32 row_octave(const u8 *r) { return r[2] >> 5; }
static inline s32 param2val(const u8 *r) { return (row_param1(r) << 4) | row_param2(r); }

enum { CMD_EMPTY, CMD_VOLUME, CMD_CHORD, CMD_JUMP, CMD_SLIDE, CMD_PITCH, CMD_VIBRATO, CMD_DELAY };
enum { MUSIC_STOP, MUSIC_PLAY_FRAME, MUSIC_PLAY };

static s32 get_tempo(const u8 *track) { return T.music.tempo < 0 ? tr_tempo(track) + 150 : T.music.tempo; }
static s32 get_speed(const u8 *track) { return T.music.speed < 0 ? tr_speed(track) + 6 : T.music.speed; }
#define NOTES_PER_MINUTE (60 / 4 * 60)
static s32 tick2row(const u8 *track, s32 tick) { s32 speed = get_speed(track); return speed ? tick * get_tempo(track) * 6 / speed / NOTES_PER_MINUTE : 0; }
static s32 row2tick(const u8 *track, s32 row) { s32 tempo = get_tempo(track); return tempo ? row * get_speed(track) * NOTES_PER_MINUTE / tempo / 6 : 0; }

static s32 calc_loop_pos(const u8 *s, s32 loop, s32 pos) {
  s32 offset = 0, start = s_loop_start(s, loop), size = s_loop_size(s, loop);
  if (size > 0) {
    for (s32 i = 0; i < pos; i++) {
      if (offset < (start + size - 1)) offset++;
      else offset = start;
    }
  } else offset = pos >= SFX_TICKS ? SFX_TICKS - 1 : pos;
  return offset;
}

static void reset_sfx_pos(Channel *c) {
  memset(c->pos, -1, 4);
  c->tick = -1;
}

static void stereo_poke(s32 index, u8 v) { poke4(R + M.stereo, (u32)index, v); }

static void sfx(s32 index, s32 note, s32 pitch, Channel *c, u8 *reg, s32 channel) {
  if (c->duration > 0) c->duration--;
  if (index < 0 || c->duration == 0) { reset_sfx_pos(c); return; }
  const u8 *e = sample_at(index);
  c->tick++;
  s32 pos = c->speed > 0 ? c->tick * (1 + c->speed) : c->tick / (1 - c->speed);
  for (s32 i = 0; i < 4; i++) c->pos[i] = (s8)calc_loop_pos(e, i, pos);
  u8 volume = (u8)(MAX_VOLUME - s_volume(e, c->pos[1]));
  if (volume > 0) {
    s8 arp = (s8)(s_chord(e, c->pos[2]) * (s_reverse(e) ? -1 : 1));
    if (arp) note += arp;
    note = CLAMP(note, 0, COUNT_OF(NOTE_FREQS) - 1);
    uint16_t freq = (uint16_t)(NOTE_FREQS[note] + s_pitch(e, c->pos[3]) * (s_pitch16x(e) ? 16 : 1) + pitch);
    reg[0] = freq & 0xff;
    reg[1] = (u8)(((freq >> 8) & 15) | ((volume & 15) << 4));
    memcpy(reg + 2, R + M.sfx + s_wave(e, c->pos[0]) * 16, 16);
    stereo_poke(channel * 2, (u8)(c->left * !s_stereo_left(e)));
    stereo_poke(channel * 2 + 1, (u8)(c->right * !s_stereo_right(e)));
  }
}

static void set_channel(s32 index, s32 note, s32 octave, s32 duration, Channel *c, s32 left, s32 right, s32 speed) {
  c->left = (u8)(left & 15);
  c->right = (u8)(right & 15);
  if (index >= 0) c->speed = speed3(speed == speed3(speed) ? speed : s_speed(sample_at(index)));
  c->note = note + octave * NOTES;
  c->duration = duration;
  c->index = index;
  reset_sfx_pos(c);
}

static void set_music_channel(s32 index, s32 note, s32 octave, s32 left, s32 right, s32 ch) {
  set_channel(index, note, octave, -1, &T.music.channels[ch], left, right, 1 << 3);
}

static void reset_music_channels(void) {
  for (s32 c = 0; c < CHANNELS; c++) set_music_channel(-1, 0, 0, 0, 0, c);
  memset(T.music.commands, 0, sizeof T.music.commands);
  memset(&T.music.jump, 0, sizeof T.music.jump);
}

static void stop_music(void) { api_music(-1, 0, 0, 0, 0, -1, -1); }

static void process_music(void) {
  s8 *st = music_status_byte();
  if (ms_status() == MUSIC_STOP) return;
  const u8 *track = track_at(ms_track());
  s32 row = tick2row(track, T.music.ticks);
  if (row != st[2] && T.music.jump.active) {
    st[1] = (s8)T.music.jump.frame;
    row = T.music.jump.beat * 4;
    T.music.ticks = row2tick(track, row);
    memset(&T.music.jump, 0, sizeof T.music.jump);
  }
  s32 rows = ROWS - tr_rows(track);
  if (row >= rows) {
    row = 0;
    T.music.ticks = 0;
    if (ms_status() == MUSIC_STOP || !ms_sustain()) {
      reset_music_channels();
      for (s32 c = 0; c < CHANNELS; c++) set_music_channel(-1, 0, 0, MAX_VOLUME, MAX_VOLUME, c);
    }
    if (ms_status() == MUSIC_PLAY) {
      st[1]++;
      if (st[1] >= FRAMES) {
        if (ms_loop()) st[1] = 0;
        else { stop_music(); return; }
      } else {
        s32 val = 0;
        for (s32 c = 0; c < CHANNELS; c++) val += pattern_id(track, st[1], c);
        if (!val) {
          if (ms_loop()) st[1] = 0;
          else { stop_music(); return; }
        }
      }
    } else if (ms_status() == MUSIC_PLAY_FRAME) {
      if (!ms_loop()) { stop_music(); return; }
    }
  }
  if (row != st[2]) {
    st[2] = (s8)row;
    for (s32 c = 0; c < CHANNELS; c++) {
      s32 id = pattern_id(track, st[1], c);
      if (!id) continue;
      const u8 *trow = R + M.music + (id - 1) * PATTERN + st[2] * 3;
      Channel *ch = &T.music.channels[c];
      Command *cmd = &T.music.commands[c];
      if (row_command(trow) == CMD_DELAY) {
        cmd->delay.row = trow;
        cmd->delay.ticks = param2val(trow);
        trow = NULL;
      }
      if (cmd->delay.row && cmd->delay.ticks == 0) {
        trow = cmd->delay.row;
        cmd->delay.row = NULL;
      }
      if (!trow) continue;
      if (row_note(trow)) {
        cmd->slide.tick = 0;
        cmd->slide.note = (u8)ch->note;
      }
      if (row_note(trow) == 1) set_music_channel(-1, 0, 0, ch->left, ch->right, c);
      else if (row_note(trow) >= 4) set_music_channel(row_sfx(trow), row_note(trow) - 4, row_octave(trow), ch->left, ch->right, c);
      switch (row_command(trow)) {
        case CMD_VOLUME: ch->left = (u8)row_param1(trow); ch->right = (u8)row_param2(trow); break;
        case CMD_CHORD: cmd->chord.tick = 0; cmd->chord.note1 = (u8)row_param1(trow); cmd->chord.note2 = (u8)row_param2(trow); break;
        case CMD_JUMP: T.music.jump.active = 1; T.music.jump.frame = row_param1(trow); T.music.jump.beat = row_param2(trow); break;
        case CMD_VIBRATO: cmd->vibrato.tick = 0; cmd->vibrato.period = (u8)row_param1(trow); cmd->vibrato.depth = (u8)row_param2(trow); break;
        case CMD_SLIDE: cmd->slide.duration = param2val(trow); break;
        case CMD_PITCH: cmd->finepitch.value = param2val(trow) - 128; break;
        default: break;
      }
    }
  }
  for (s32 i = 0; i < CHANNELS; ++i) {
    Channel *ch = &T.music.channels[i];
    Command *cmd = &T.music.commands[i];
    if (ch->index >= 0) {
      s32 note = ch->note, pitch = 0;
      s32 chord[] = {0, cmd->chord.note1, cmd->chord.note2};
      note += chord[cmd->chord.tick % (cmd->chord.note2 == 0 ? 2 : 3)];
      if (cmd->vibrato.period && cmd->vibrato.depth) {
        static const s32 VIB[] = {0x0, 0x31f1, 0x61f8, 0x8e3a, 0xb505, 0xd4db, 0xec83, 0xfb15, 0x10000, 0xfb15, 0xec83, 0xd4db, 0xb505, 0x8e3a, 0x61f8, 0x31f1,
                                  0x0, (s32)0xffffce0f, (s32)0xffff9e08, (s32)0xffff71c6, (s32)0xffff4afb, (s32)0xffff2b25, (s32)0xffff137d, (s32)0xffff04eb,
                                  (s32)0xffff0000, (s32)0xffff04eb, (s32)0xffff137d, (s32)0xffff2b25, (s32)0xffff4afb, (s32)0xffff71c6, (s32)0xffff9e08, (s32)0xffffce0f};
        s32 p = cmd->vibrato.period << 1;
        pitch += (VIB[(cmd->vibrato.tick % p) * 32 / p] * cmd->vibrato.depth) >> 16;
      }
      if (cmd->slide.tick < cmd->slide.duration) pitch += (NOTE_FREQS[ch->note] - NOTE_FREQS[note = cmd->slide.note]) * cmd->slide.tick / cmd->slide.duration;
      pitch += cmd->finepitch.value;
      sfx(ch->index, note, pitch, ch, R + M.registers + i * REGISTER, i);
    }
    ++cmd->chord.tick;
    ++cmd->vibrato.tick;
    ++cmd->slide.tick;
    if (cmd->delay.ticks) cmd->delay.ticks--;
  }
  T.music.ticks++;
}

static void api_music(s32 index, s32 frame, s32 row, int loop, int sustain, s32 tempo, s32 speed) {
  s8 *st = music_status_byte();
  st[0] = (s8)index;
  if (index < 0) {
    ms_set_status(MUSIC_STOP);
    reset_music_channels();
  } else {
    for (s32 c = 0; c < CHANNELS; c++) set_music_channel(-1, 0, 0, MAX_VOLUME, MAX_VOLUME, c);
    st[2] = -1;
    st[1] = (s8)(frame < 0 ? 0 : frame);
    R[M.music_state + 3] = (u8)((R[M.music_state + 3] & ~9) | (loop ? 1 : 0) | (sustain ? 8 : 0));
    ms_set_status(MUSIC_PLAY);
    const u8 *track = track_at(index);
    T.music.tempo = tempo;
    T.music.speed = speed;
    T.music.ticks = row >= 0 ? row2tick(track, row) : 0;
  }
  if (index >= 0) ms_set_status(MUSIC_PLAY);
}

static void api_sfx(s32 index, s32 note, s32 octave, s32 duration, s32 channel, s32 left, s32 right, s32 speed) {
  set_channel(index, note, octave, duration, &T.sfx[channel], left, right, speed);
}

static void sound_clear(void) {
  for (s32 i = 0; i < CHANNELS; i++) {
    Channel empty_ = {-1, NULL, -1, 0, 0, 0, 0, -1};
    T.music.channels[i] = empty_;
    T.sfx[i] = empty_;
    T.sfx[i].pos = (s8 *)(R + M.sfxpos + i * 4);
    T.music.channels[i].pos = T.music.sfxpos[i];
    memset(T.sfx[i].pos, -1, 4);
    memset(T.music.channels[i].pos, -1, 4);
  }
  memset(R + M.registers, 0, CHANNELS * REGISTER);
  memset(R + M.pcm, 0, 128);
  memset(T.samples, 0, (size_t)T.sample_frames * 2 * sizeof(int16_t));
  api_music(-1, 0, 0, 0, 0, -1, -1);
}

static void sound_tick_start(void) {
  memset(R + M.registers, 0, CHANNELS * REGISTER);
  memset(R + M.pcm, 0, 128);
  memset(R + M.stereo, 0xff, 8);
  process_music();
  for (s32 i = 0; i < CHANNELS; ++i) {
    Channel *c = &T.sfx[i];
    if (c->index >= 0) sfx(c->index, c->note, 0, c, R + M.registers + i * REGISTER, i);
  }
}

static void sound_tick_end(void) {
  /* Push the registers onto a ring, and synthesize from its tail: TIC-80's one-frame lag. */
  memcpy(T.ring[T.ring_head].registers, R + M.registers, sizeof T.ring[0].registers);
  memcpy(T.ring[T.ring_head].stereo, R + M.stereo, 8);
  memcpy(T.ring[T.ring_head].pcm, R + M.pcm, 128);
  if (T.ring_head != (T.ring_tail + RINGBUF - 2) % RINGBUF) T.ring_head = (T.ring_head + 1) % RINGBUF;
}

/* The mixer: amplitude steps at clock times, spread over two samples, integrated with a gentle high-pass. */
static void add_delta(s32 side, s32 time, s32 delta) {
  double pos = (double)time * T.sample_frames / ENDTIME;
  s32 i = (s32)pos;
  float f = (float)(pos - i);
  if (i < 0) i = 0;
  if (i > T.sample_frames) i = T.sample_frames;
  T.mix[side][i] += delta * (1 - f);
  T.mix[side][i + 1] += delta * f;
}

static void update_amp(s32 side, RegData *d, s32 amp) {
  s32 delta = amp - d->amp;
  d->amp += delta;
  if (delta) add_delta(side, d->time, delta);
}

static inline s32 freq2period(s32 freq) {
  enum { MinPeriod = 10, MaxPeriod = 4096, Rate = CLOCKRATE * 2 / 32 };
  if (freq == 0) return MaxPeriod;
  return CLAMP(Rate / freq - 1, MinPeriod, MaxPeriod);
}

static inline s32 get_amp(s32 volume, s32 amp) { return amp * volume / MAX_VOLUME / (CHANNELS + 1); }

static int is_noise(const u8 *wave) {
  u8 first = wave[0] & 15;
  first |= (u8)(first << 4);
  for (s32 i = 0; i < 16; i++) if (wave[i] != first) return 0;
  return wave[0] % 0xff == 0;
}

static void synth_side(s32 side) {
  const u8 *ring = (const u8 *)&T.ring[(T.ring_tail + RINGBUF - 1) % RINGBUF];
  const u8 *stereo = T.ring[(T.ring_tail + RINGBUF - 1) % RINGBUF].stereo;
  const u8 *pcm = T.ring[(T.ring_tail + RINGBUF - 1) % RINGBUF].pcm;
  for (s32 i = 0; i < CHANNELS; ++i) {
    u8 sv = peek4(stereo, (u32)(side + i * 2));
    const u8 *reg = ring + i * REGISTER;
    s32 freq = ((reg[1] & 15) << 8) | reg[0], volume = reg[1] >> 4;
    const u8 *wave = reg + 2;
    RegData *d = &T.regs[side].data[i];
    if (is_noise(wave)) {
      if (d->phase == 0) d->phase = 1;
      s32 period = freq2period(freq), fb = *wave ? 0x14 : 0x12000;
      for (; d->time < ENDTIME; d->time += period, d->phase = ((d->phase & 1) * fb) ^ (d->phase >> 1))
        update_amp(side, d, get_amp(volume, (d->phase & 1) ? sv * 32767 / MAX_VOLUME : 0));
    } else {
      s32 period = freq2period(freq * 2);
      for (; d->time < ENDTIME; d->time += period, d->phase = (d->phase + 1) % 32)
        update_amp(side, d, get_amp(volume, peek4(wave, (u32)d->phase) * 32767 / MAX_VOLUME * sv / MAX_VOLUME));
    }
    d->time -= ENDTIME;
  }
  RegData *d = &T.regs[side].pcm;
  for (d->time = 0; d->time < ENDTIME; d->time += ENDTIME / 128, d->phase = (d->phase + 1) % 128) update_amp(side, d, get_amp(MAX_VOLUME, pcm[d->phase] * 32767 / 255));
  /* Integrate this frame's steps into samples. */
  float *mix = T.mix[side], level = T.level[side];
  for (s32 n = 0; n < T.sample_frames; n++) {
    level += mix[n];
    float v = level;
    level -= level / 512.0f;
    T.samples[n * 2 + side] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
  }
  T.level[side] = level;
  float carry = mix[T.sample_frames] + mix[T.sample_frames + 1];
  memset(mix, 0, (size_t)(T.sample_frames + 2) * sizeof(float));
  mix[0] = carry;
}

void tic_synth(void) {
  synth_side(0);
  synth_side(1);
  if (T.ring_tail != T.ring_head) T.ring_tail = (T.ring_tail + 1) % RINGBUF;
}

/* ---- the tick ----------------------------------------------------------------------- */

void tic_tick_start(uint32_t buttons) {
  /* The host's input: the first gamepad's eight buttons (as the TIC-80–derived cores take them). */
  memset(R + M.input, 0, 12);
  R[M.input] = (u8)(buttons & 0xff);
  T.frames++;
  sound_tick_start();
  tick_io();
  T.keyboard.now = keyboard();
  T.gamepads.now = gamepads();
  T.synced = 0;
}

void tic_tick_end(lua_State *L) {
  /* OVR (deprecated, still called): drawn on vbank 1, cleared first. */
  if (L && has_function(L, "OVR")) {
    s32 prev = T.vbank_id;
    api_vbank(1);
    R[M.vars + 3] = T.vbank[M.vars + 3];
    api_cls(0);
    lua_pushcfunction(L, msgh);
    lua_getglobal(L, "OVR");
    if (lua_pcall(L, 0, 0, -2) != LUA_OK) {
      cbx_core_callback_error(lua_tostring(L, -1));
      lua_pop(L, 1);
    }
    lua_pop(L, 1);
    api_vbank(prev);
    R[M.vars + 3] = T.vbank[M.vars + 3];
  }
  T.gamepads.previous = gamepads();
  T.keyboard.previous = T.keyboard.now;
  T.gamepads.previous = T.gamepads.now;
  sound_tick_end();
}

int tic_reset_requested(void) { return T.reset; }

/* ---- the Lua API (TIC-80's src/api/luaapi.c) -------------------------------------------- */

static int l_peek(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top < 1) return luaL_error(L, "invalid parameters, peek(addr,bits)\n");
  s32 address = num(L, 1), bits = top == 2 ? num(L, 2) : 8;
  int64_t total = (int64_t)T.ram_size * 8;
  u8 v = 0;
  if (address >= 0) switch (bits) {
      case 1: if (address < total) { v = peek1(R, (u32)address); break; } /* fall through */
      case 2: if (address < total / 2) { v = peek2(R, (u32)address); break; } /* fall through */
      case 4: if (address < total / 4) { v = peek4(R, (u32)address); break; } /* fall through */
      case 8: if (address < total / 8) { v = R[address]; break; } /* fall through */
      default: break;
    }
  lua_pushinteger(L, v);
  return 1;
}

static int l_poke(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top < 2) return luaL_error(L, "invalid parameters, poke(addr,val,bits)\n");
  s32 address = num(L, 1), bits = top == 3 ? num(L, 3) : 8;
  u8 value = (u8)num(L, 2);
  int64_t total = (int64_t)T.ram_size * 8;
  if (address < 0) return 0;
  switch (bits) {
    case 1: if (address < total) poke1(R, (u32)address, value); break;
    case 2: if (address < total / 2) poke2(R, (u32)address, value); break;
    case 4: if (address < total / 4) poke4(R, (u32)address, value); break;
    case 8: if (address < total / 8) R[address] = value; break;
    default: break;
  }
  return 0;
}

/* peek1/2/4 and poke1/2/4: exactly one (two) arguments. */
static int peekn(lua_State *L, s32 bits, const char *usage) {
  if (lua_gettop(L) != 1) return luaL_error(L, "%s", usage);
  lua_settop(L, 1);
  lua_pushinteger(L, bits);
  return l_peek(L);
}
static int poken(lua_State *L, s32 bits, const char *usage) {
  if (lua_gettop(L) != 2) return luaL_error(L, "%s", usage);
  lua_pushinteger(L, bits);
  return l_poke(L);
}
static int l_peek1(lua_State *L) { return peekn(L, 1, "invalid parameters, peek1(addr)\n"); }
static int l_peek2(lua_State *L) { return peekn(L, 2, "invalid parameters, peek2(addr)\n"); }
static int l_peek4(lua_State *L) { return peekn(L, 4, "invalid parameters, peek4(addr)\n"); }
static int l_poke1(lua_State *L) { return poken(L, 1, "invalid parameters, poke1(addr,val)\n"); }
static int l_poke2(lua_State *L) { return poken(L, 2, "invalid parameters, poke2(addr,val)\n"); }
static int l_poke4(lua_State *L) { return poken(L, 4, "invalid parameters, poke4(addr,val)\n"); }

static int l_cls(lua_State *L) {
  api_cls((u8)(lua_gettop(L) == 1 ? num(L, 1) : 0));
  return 0;
}

static int l_paint(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top < 3 || top > 4) return luaL_error(L, "invalid parameters, paint(x y color [bordercolor])\n");
  s32 x = num(L, 1), y = num(L, 2);
  u8 color = (u8)num(L, 3), border = (u8)(top >= 4 ? num(L, 4) : -1);
  border = border == 255 ? 255 : map_color(border);
  flood_fill(x, y, map_color(color), border);
  return 0;
}

static int l_pix(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top < 2) return luaL_error(L, "invalid parameters, pix(x y [color])\n");
  s32 x = num(L, 1), y = num(L, 2);
  if (top >= 3) {
    set_pixel(x, y, map_color((u8)num(L, 3)));
    return 0;
  }
  lua_pushinteger(L, get_pixel(x, y));
  return 1;
}

static int l_line(lua_State *L) {
  if (lua_gettop(L) != 5) return luaL_error(L, "invalid parameters, line(x0,y0,x1,y1,color)\n");
  draw_line((float)lua_tonumber(L, 1), (float)lua_tonumber(L, 2), (float)lua_tonumber(L, 3), (float)lua_tonumber(L, 4), map_color((u8)num(L, 5)));
  return 0;
}

static int l_rect(lua_State *L) {
  if (lua_gettop(L) != 5) return luaL_error(L, "invalid parameters, rect(x,y,w,h,color)\n");
  draw_rect(num(L, 1), num(L, 2), num(L, 3), num(L, 4), map_color((u8)num(L, 5)));
  return 0;
}

static int l_rectb(lua_State *L) {
  if (lua_gettop(L) != 5) return luaL_error(L, "invalid parameters, rectb(x,y,w,h,color)\n");
  draw_rectb(num(L, 1), num(L, 2), num(L, 3), num(L, 4), map_color((u8)num(L, 5)));
  return 0;
}

static int l_circ(lua_State *L) {
  if (lua_gettop(L) != 4) return luaL_error(L, "invalid parameters, circ(x,y,radius,color)\n");
  s32 r = num(L, 3);
  elli(num(L, 1), num(L, 2), r, r, (u8)num(L, 4));
  return 0;
}

static int l_circb(lua_State *L) {
  if (lua_gettop(L) != 4) return luaL_error(L, "invalid parameters, circb(x,y,radius,color)\n");
  s32 r = num(L, 3);
  ellib(num(L, 1), num(L, 2), r, r, (u8)num(L, 4));
  return 0;
}

static int l_elli(lua_State *L) {
  if (lua_gettop(L) != 5) return luaL_error(L, "invalid parameters, elli(x,y,a,b,color)\n");
  elli(num(L, 1), num(L, 2), num(L, 3), num(L, 4), (u8)num(L, 5));
  return 0;
}

static int l_ellib(lua_State *L) {
  if (lua_gettop(L) != 5) return luaL_error(L, "invalid parameters, ellib(x,y,a,b,color)\n");
  ellib(num(L, 1), num(L, 2), num(L, 3), num(L, 4), (u8)num(L, 5));
  return 0;
}

static int l_tri(lua_State *L) {
  if (lua_gettop(L) != 7) return luaL_error(L, "invalid parameters, tri(x1,y1,x2,y2,x3,y3,color)\n");
  float pt[6];
  for (s32 i = 0; i < 6; i++) pt[i] = (float)lua_tonumber(L, i + 1);
  u8 color = map_color((u8)num(L, 7));
  Vec2 a = {pt[0], pt[1]}, b = {pt[2], pt[3]}, c = {pt[4], pt[5]};
  draw_tri(&a, &b, &c, color_shader, &color);
  return 0;
}

static int l_trib(lua_State *L) {
  if (lua_gettop(L) != 7) return luaL_error(L, "invalid parameters, trib(x1,y1,x2,y2,x3,y3,color)\n");
  float pt[6];
  for (s32 i = 0; i < 6; i++) pt[i] = (float)lua_tonumber(L, i + 1);
  u8 color = map_color((u8)num(L, 7));
  draw_line(pt[0], pt[1], pt[2], pt[3], color);
  draw_line(pt[2], pt[3], pt[4], pt[5], color);
  draw_line(pt[4], pt[5], pt[0], pt[1], color);
  return 0;
}

/* A colour key: one colour, or a table of them. */
static s32 color_keys(lua_State *L, int i, u8 *colors) {
  s32 count = 0;
  if (lua_istable(L, i)) {
    for (s32 k = 1; k <= PALETTE_SIZE; k++) {
      lua_rawgeti(L, i, k);
      if (lua_isnumber(L, -1)) {
        colors[k - 1] = (u8)num(L, -1);
        count++;
        lua_pop(L, 1);
      } else {
        lua_pop(L, 1);
        break;
      }
    }
  } else {
    colors[0] = (u8)num(L, i);
    count = 1;
  }
  return count;
}

static int l_textri(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top < 12) return 0;
  float pt[12];
  for (s32 i = 0; i < 12; i++) pt[i] = (float)lua_tonumber(L, i + 1);
  static u8 colors[PALETTE_SIZE];
  s32 count = 0;
  int use_map = top >= 13 ? lua_toboolean(L, 13) : 0;
  if (top >= 14) count = color_keys(L, 14, colors);
  textri(pt[0], pt[1], pt[2], pt[3], pt[4], pt[5], pt[6], pt[7], pt[8], pt[9], pt[10], pt[11], use_map, colors, count);
  return 0;
}

static int l_ttri(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top < 12) return luaL_error(L, "invalid parameters, ttri(x1,y1,x2,y2,x3,y3,u1,v1,u2,v2,u3,v3,[src=0],[chroma=off],[z1=0],[z2=0],[z3=0])\n");
  float pt[12];
  for (s32 i = 0; i < 12; i++) pt[i] = (float)lua_tonumber(L, i + 1);
  static u8 colors[PALETTE_SIZE];
  s32 count = 0, src = 0;
  if (top >= 13) src = lua_isboolean(L, 13) ? (lua_toboolean(L, 13) ? 1 : 0) : (s32)lua_tointeger(L, 13);
  if (top >= 14) count = color_keys(L, 14, colors);
  float z[3] = {0, 0, 0};
  int depth = 0;
  if (top == 17) {
    for (s32 i = 0; i < 3; i++) z[i] = (float)lua_tonumber(L, i + 15);
    depth = 1;
  }
  ttri(pt[0], pt[1], pt[2], pt[3], pt[4], pt[5], pt[6], pt[7], pt[8], pt[9], pt[10], pt[11], src, colors, count, z[0], z[1], z[2], depth);
  return 0;
}

static int l_clip(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top == 0) api_clip(0, 0, M.width, M.height);
  else if (top == 4) api_clip(num(L, 1), num(L, 2), num(L, 3), num(L, 4));
  else return luaL_error(L, "invalid parameters, use clip(x,y,w,h) or clip()\n");
  return 0;
}

static u32 api_btnp(s32 index, s32 hold, s32 period) {
  u32 now = gamepads();
  if (index < 0) return (~T.gamepads.previous) & now;
  if (hold < 0 || period < 0) return ((~T.gamepads.previous) & now) & (1u << index);
  u32 previous = T.gamepads.holds[index] >= (u32)hold ? (period && T.gamepads.holds[index] % (u32)period ? T.gamepads.previous : 0) : T.gamepads.previous;
  return ((~previous) & now) & (1u << index);
}

static int l_btnp(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top == 0) lua_pushinteger(L, api_btnp(-1, -1, -1));
  else if (top == 1) lua_pushboolean(L, api_btnp(num(L, 1) & 0x1f, -1, -1) != 0);
  else if (top == 3) lua_pushboolean(L, api_btnp(num(L, 1) & 0x1f, (s32)(u32)num(L, 2), (s32)(u32)num(L, 3)) != 0);
  else return luaL_error(L, "invalid params, btnp [ id [ hold period ] ]\n");
  return 1;
}

static int l_btn(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top == 0) lua_pushinteger(L, gamepads());
  else if (top == 1) lua_pushboolean(L, (gamepads() & (1u << (num(L, 1) & 0x1f))) != 0);
  else return luaL_error(L, "invalid params, btn [ id ]\n");
  return 1;
}

static int l_spr(lua_State *L) {
  s32 top = lua_gettop(L);
  s32 index = 0, x = 0, y = 0, w = 1, h = 1, scale = 1, flip = 0, rotate = 0, count = 0;
  static u8 colors[PALETTE_SIZE];
  if (top >= 1) {
    index = num(L, 1);
    if (top >= 3) {
      x = num(L, 2);
      y = num(L, 3);
      if (top >= 4) {
        count = color_keys(L, 4, colors);
        if (top >= 5) {
          scale = num(L, 5);
          if (top >= 6) {
            flip = num(L, 6);
            if (top >= 7) {
              rotate = num(L, 7);
              if (top >= 9) { w = num(L, 8); h = num(L, 9); }
            }
          }
        }
      }
    }
  }
  draw_sprite(index, x, y, w, h, colors, count, scale, flip, rotate);
  return 0;
}

static int l_mget(lua_State *L) {
  if (lua_gettop(L) != 2) return luaL_error(L, "invalid params, mget(x,y)\n");
  s32 x = num(L, 1), y = num(L, 2);
  lua_pushinteger(L, x < 0 || x >= M.map_w || y < 0 || y >= M.map_h ? 0 : R[M.map + y * M.map_w + x]);
  return 1;
}

static int l_mset(lua_State *L) {
  if (lua_gettop(L) != 3) return luaL_error(L, "invalid params, mget(x,y)\n");
  s32 x = num(L, 1), y = num(L, 2);
  u8 v = (u8)num(L, 3);
  if (!(x < 0 || x >= M.map_w || y < 0 || y >= M.map_h)) R[M.map + y * M.map_w + x] = v;
  return 0;
}

typedef struct { lua_State *L; int ref; } RemapData;

static void remap_callback(void *data, s32 x, s32 y, Retile *r) {
  RemapData *rd = data;
  lua_State *L = rd->L;
  lua_rawgeti(L, LUA_REGISTRYINDEX, rd->ref);
  lua_pushinteger(L, r->index);
  lua_pushinteger(L, x);
  lua_pushinteger(L, y);
  lua_pcall(L, 3, 3, 0);
  r->index = num(L, -3);
  r->flip = num(L, -2);
  r->rotate = num(L, -1);
  lua_pop(L, 3);
}

static int l_map(lua_State *L) {
  s32 x = 0, y = 0, w = M.width / 8, h = M.height / 8, sx = 0, sy = 0, scale = 1, count = 0;
  static u8 colors[PALETTE_SIZE];
  s32 top = lua_gettop(L);
  if (top >= 2) {
    x = num(L, 1);
    y = num(L, 2);
    if (top >= 4) {
      w = num(L, 3);
      h = num(L, 4);
      if (top >= 6) {
        sx = num(L, 5);
        sy = num(L, 6);
        if (top >= 7) {
          count = color_keys(L, 7, colors);
          if (top >= 8) {
            scale = num(L, 8);
            if (top >= 9 && lua_isfunction(L, 9)) {
              lua_settop(L, 9);
              RemapData data = {L, luaL_ref(L, LUA_REGISTRYINDEX)};
              draw_map(x, y, w, h, sx, sy, colors, count, scale, remap_callback, &data);
              luaL_unref(L, LUA_REGISTRYINDEX, data.ref);
              return 0;
            }
          }
        }
      }
    }
  }
  draw_map(x, y, w, h, sx, sy, colors, count, scale, NULL, NULL);
  return 0;
}

static int l_music(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top == 0) {
    api_music(-1, 0, 0, 0, 0, -1, -1);
    return 0;
  }
  s32 track = num(L, 1);
  if (track > TRACKS - 1) return luaL_error(L, "invalid music track index");
  api_music(-1, 0, 0, 0, 0, -1, -1);
  s32 frame = -1, row = -1, tempo = -1, speed = -1;
  int loop = 1, sustain = 0;
  if (top >= 2) {
    frame = num(L, 2);
    if (top >= 3) {
      row = num(L, 3);
      if (top >= 4) {
        loop = lua_toboolean(L, 4);
        if (top >= 5) {
          sustain = lua_toboolean(L, 5);
          if (top >= 6) {
            tempo = num(L, 6);
            if (top >= 7) speed = num(L, 7);
          }
        }
      }
    }
  }
  api_music(track, frame, row, loop, sustain, tempo, speed);
  return 0;
}

static int parse_note(const char *s, s32 *note, s32 *octave) {
  static const char *NAMES[] = {"C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"};
  if (!s || strlen(s) != 3) return 0;
  for (s32 i = 0; i < 12; i++)
    if (memcmp(NAMES[i], s, 2) == 0) {
      *note = i;
      *octave = s[2] - '1';
      break;
    }
  return 1;
}

static int l_sfx(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top < 1) return luaL_error(L, "invalid sfx params\n");
  s32 note = -1, octave = -1, duration = -1, channel = 0, speed = 1 << 3;
  s32 volumes[2] = {MAX_VOLUME, MAX_VOLUME};
  s32 index = num(L, 1);
  if (index >= SFX_COUNT) return luaL_error(L, "unknown sfx index\n");
  if (index >= 0) {
    const u8 *e = sample_at(index);
    note = s_note(e);
    octave = s_octave(e);
    speed = s_speed(e);
  }
  if (top >= 2) {
    if (lua_isinteger(L, 2)) {
      s32 id = num(L, 2);
      note = id % NOTES;
      octave = id / NOTES;
    } else if (lua_isstring(L, 2)) {
      if (!parse_note(lua_tostring(L, 2), &note, &octave)) return luaL_error(L, "invalid note, should be like C#4\n");
    }
    if (top >= 3) {
      duration = num(L, 3);
      if (top >= 4) {
        channel = num(L, 4);
        if (top >= 5) {
          if (lua_istable(L, 5)) {
            for (s32 i = 0; i < 2; i++) {
              volumes[i] = lua_rawgeti(L, 5, i + 1);
              lua_pop(L, 1);
            }
          } else volumes[0] = volumes[1] = num(L, 5);
          if (top >= 6) speed = num(L, 6);
        }
      }
    }
  }
  if (channel < 0 || channel >= CHANNELS) return luaL_error(L, "unknown channel\n");
  api_sfx(index, note, octave, duration, channel, volumes[0] & 15, volumes[1] & 15, speed);
  return 0;
}

static int l_vbank(lua_State *L) {
  s32 prev = T.vbank_id;
  if (lua_gettop(L) == 1) api_vbank(num(L, 1));
  lua_pushinteger(L, prev);
  return 1;
}

static int l_sync(lua_State *L) {
  s32 top = lua_gettop(L);
  u32 mask = 0;
  s32 b = 0;
  int to_cart = 0;
  if (top >= 1) {
    mask = (u32)num(L, 1);
    if (top >= 2) {
      b = num(L, 2);
      if (top >= 3) to_cart = lua_toboolean(L, 3);
    }
  }
  if (b < 0 || b >= BANKS) return luaL_error(L, "sync() error, invalid bank");
  api_sync(mask, b, to_cart);
  return 0;
}

static int l_reset(lua_State *L) {
  (void)L;
  T.reset = 1;
  return 0;
}

static int api_keyp(s32 key, s32 hold, s32 period) {
  if (key > 0) {
    int prev = hold >= 0 && period >= 0 && T.keyboard.holds[key] >= (u32)hold
                   ? (period && T.keyboard.holds[key] % (u32)period ? key_in(T.keyboard.previous, key) : 0)
                   : key_in(T.keyboard.previous, key);
    return !prev && key_in(keyboard(), key);
  }
  for (s32 i = 0; i < KEY_BUFFER; i++) {
    s32 k = (s32)((keyboard() >> (i * 8)) & 0xff);
    if (k && !key_in(T.keyboard.previous, k)) return 1;
  }
  return 0;
}

static int l_key(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top == 0) lua_pushboolean(L, api_key(0));
  else if (top == 1) {
    s32 key = (u8)num(L, 1);
    if (key >= KEYS) return luaL_error(L, "unknown keyboard code\n");
    lua_pushboolean(L, api_key(key));
  } else return luaL_error(L, "invalid params, key [code]\n");
  return 1;
}

static int l_keyp(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top == 0) {
    lua_pushboolean(L, api_keyp(0, -1, -1));
    return 1;
  }
  s32 key = (u8)num(L, 1);
  if (key >= KEYS) return luaL_error(L, "unknown keyboard code\n");
  if (top == 1) lua_pushboolean(L, api_keyp(key, -1, -1));
  else if (top == 3) lua_pushboolean(L, api_keyp(key, (s32)(u32)num(L, 2), (s32)(u32)num(L, 3)));
  else return luaL_error(L, "invalid params, keyp [ code [ hold period ] ]\n");
  return 1;
}

static int l_memcpy(lua_State *L) {
  if (lua_gettop(L) != 3) return luaL_error(L, "invalid params, memcpy(dest,src,size)\n");
  s32 dst = num(L, 1), src = num(L, 2), size = num(L, 3), bound = T.ram_size - size;
  if (size >= 0 && size <= T.ram_size && dst >= 0 && src >= 0 && dst <= bound && src <= bound) memmove(R + dst, R + src, (size_t)size);
  return 0;
}

static int l_memset(lua_State *L) {
  if (lua_gettop(L) != 3) return luaL_error(L, "invalid params, memset(dest,val,size)\n");
  s32 dst = num(L, 1), size = num(L, 3), bound = T.ram_size - size;
  u8 v = (u8)num(L, 2);
  if (size >= 0 && size <= T.ram_size && dst >= 0 && dst <= bound) memset(R + dst, v, (size_t)size);
  return 0;
}

/* tostring(value), left on the stack (TIC-80's printString). */
static const char *print_string(lua_State *L, int i) {
  lua_getglobal(L, "tostring");
  lua_pushvalue(L, i);
  lua_call(L, 1, 1);
  return lua_tostring(L, -1);
}

static int l_font(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top < 1) return 0;
  const char *text = print_string(L, 1);
  s32 x = 0, y = 0, width = 8, height = 8, scale = 1;
  u8 chromakey = 0;
  int fixed = 0, alt = 0;
  if (top >= 3) {
    x = num(L, 2);
    y = num(L, 3);
    if (top >= 4) {
      chromakey = (u8)num(L, 4);
      if (top >= 6) {
        width = num(L, 5);
        height = num(L, 6);
        if (top >= 7) {
          fixed = lua_toboolean(L, 7);
          if (top >= 8) {
            scale = num(L, 8);
            if (top >= 9) alt = lua_toboolean(L, 9);
          }
        }
      }
    }
  }
  if (scale == 0) {
    lua_pushinteger(L, 0);
    return 1;
  }
  u8 *mapping = palette_map(&chromakey, 1);
  /* Compatibility: font's default target is the other half of the sheet. */
  u8 segment = (u8)((R[M.blit] & 15) >> 1), flipmask = 1;
  while (segment >>= 1) flipmask <<= 1;
  Sheet face = sheet_for((u8)((R[M.blit] & 15) ^ flipmask));
  lua_pushinteger(L, draw_text(&face, text ? text : "nil", x, y, width, height, fixed, mapping, scale, alt));
  return 1;
}

static int l_print(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top < 1) return 0;
  s32 x = 0, y = 0, color = DEFAULT_COLOR, scale = 1;
  int fixed = 0, alt = 0;
  const char *text = print_string(L, 1);
  if (top >= 3) {
    x = num(L, 2);
    y = num(L, 3);
    if (top >= 4) {
      color = num(L, 4) % PALETTE_SIZE;
      if (top >= 5) {
        fixed = lua_toboolean(L, 5);
        if (top >= 6) {
          scale = num(L, 6);
          if (top >= 7) alt = lua_toboolean(L, 7);
        }
      }
    }
  }
  if (scale == 0) {
    lua_pushinteger(L, 0);
    return 1;
  }
  u8 mapping[256];
  memset(mapping, TRANSPARENT, sizeof mapping);
  mapping[1] = (u8)color;
  mapping[0] = 255;
  Sheet face = sheet_for(1);
  const u8 *font = R + M.font + (alt ? FONT_STRIDE : 0);
  s32 width = font[FONT_DATA];
  if (!fixed) width -= 2;
  lua_pushinteger(L, draw_text(&face, text ? text : "nil", x, y, width, font[FONT_DATA + 1], fixed, mapping, scale, alt));
  return 1;
}

static int l_trace(lua_State *L) {
  if (lua_gettop(L) < 1) return luaL_error(L, "invalid params, trace(text,[color])\n");
  size_t len;
  print_string(L, 1);
  const char *s = lua_tolstring(L, -1, &len);
  cbx_core_trace(s ? s : "nil", s ? (int)len : 3);
  return 0;
}

static int l_pmem(lua_State *L) {
  s32 top = lua_gettop(L);
  if (top < 1) return luaL_error(L, "invalid params, pmem(index [val]) -> val\n");
  u32 index = (u32)num(L, 1);
  if (index >= 256) return luaL_error(L, "invalid persistent tic index\n");
  u8 *w = R + M.persistent + index * 4;
  u32 old = (u32)w[0] | ((u32)w[1] << 8) | ((u32)w[2] << 16) | ((u32)w[3] << 24);
  if (top >= 2) {
    u32 v = (u32)lua_tointeger(L, 2);
    w[0] = v & 0xff; w[1] = (v >> 8) & 0xff; w[2] = (v >> 16) & 0xff; w[3] = v >> 24;
  }
  lua_pushinteger(L, old);
  return 1;
}

/*
 * time(): the HD core's virtual clock, 16,666 µs a frame. TIC-80 measures from
 * the start it records on the cart's first frame, but only keeps that start for
 * that frame (it lives in the frame's tick data), so the clock reads 0 then and
 * counts from the console's creation after: 0, 33.332, 49.998, ...
 */
static int l_time(lua_State *L) {
  uint64_t elapsed = T.frames <= 1 ? 0 : (uint64_t)T.frames * (1000000ULL / 60);
  lua_pushnumber(L, (double)elapsed * 1000.0 / 1000000.0);
  return 1;
}

static int l_tstamp(lua_State *L) {
  lua_pushnumber(L, (double)(s32)time(NULL));
  return 1;
}

static int l_exit(lua_State *L) { (void)L; return 0; }

static int l_mouse(lua_State *L) {
  const u8 *m = R + M.input + 4;
  uint16_t btns = (uint16_t)(m[2] | (m[3] << 8));
  int relative = (btns >> 15) & 1;
  s32 offset_left = (M.fullwidth - M.width) / 2, offset_top = (M.fullheight - M.height) / 2;
  lua_pushinteger(L, relative ? (s8)m[0] : m[0] - offset_left);
  lua_pushinteger(L, relative ? (s8)m[1] : m[1] - offset_top);
  lua_pushboolean(L, btns & 1);
  lua_pushboolean(L, (btns >> 1) & 1);
  lua_pushboolean(L, (btns >> 2) & 1);
  lua_pushinteger(L, ((int16_t)(btns << 7)) >> 10);
  lua_pushinteger(L, ((int16_t)(btns << 1)) >> 10);
  return 7;
}

static u8 *flag(u32 index, u32 bit) {
  if (index >= FLAGS || bit >= 8) return &T.flag_stub;
  return R + M.flags + index;
}

static int l_fget(lua_State *L) {
  if (lua_gettop(L) >= 2) {
    u32 index = (u32)num(L, 1);
    u8 bit = (u8)(u32)num(L, 2);
    lua_pushboolean(L, bit < 8 && ((*flag(index, bit) >> bit) & 1));
    return 1;
  }
  return luaL_error(L, "invalid params, fget(sprite,flag)\n");
}

static int l_fset(lua_State *L) {
  if (lua_gettop(L) >= 3) {
    u32 index = (u32)num(L, 1);
    u8 bit = (u8)(u32)num(L, 2);
    u8 *f = flag(index, bit);
    if (bit < 8) {
      if (lua_toboolean(L, 3)) *f = (u8)(*f | (1 << bit));
      else *f = (u8)(*f & ~(1 << bit));
    }
    return 0;
  }
  return luaL_error(L, "invalid params, fset(sprite,flag,value)\n");
}

static int l_fft(lua_State *L) {
  if (lua_gettop(L) < 1) return luaL_error(L, "invalid params, fft(start_freq, end_freq=-1)\n");
  lua_pushnumber(L, 0.0);
  return 1;
}

static int l_ffts(lua_State *L) {
  if (lua_gettop(L) < 1) return luaL_error(L, "invalid params, ffts(start_freq, end_freq=-1)\n");
  lua_pushnumber(L, 0.0);
  return 1;
}

/* _cbx_palette(i, r, g, b): set a colour of the current vbank's palette. */
static int l_palette(lua_State *L) {
  s32 i = (s32)luaL_checkinteger(L, 1) & 0xff;
  u8 *p = R + M.palette + i * 3;
  p[0] = (u8)luaL_checkinteger(L, 2);
  p[1] = (u8)luaL_checkinteger(L, 3);
  p[2] = (u8)luaL_checkinteger(L, 4);
  return 0;
}

void tic_open(lua_State *L) {
  static const luaL_Reg api[] = {
    {"print", l_print}, {"cls", l_cls}, {"pix", l_pix}, {"line", l_line}, {"rect", l_rect}, {"rectb", l_rectb}, {"spr", l_spr},
    {"btn", l_btn}, {"btnp", l_btnp}, {"sfx", l_sfx}, {"map", l_map}, {"mget", l_mget}, {"mset", l_mset}, {"peek", l_peek},
    {"poke", l_poke}, {"peek1", l_peek1}, {"poke1", l_poke1}, {"peek2", l_peek2}, {"poke2", l_poke2}, {"peek4", l_peek4},
    {"poke4", l_poke4}, {"memcpy", l_memcpy}, {"memset", l_memset}, {"trace", l_trace}, {"pmem", l_pmem}, {"time", l_time},
    {"tstamp", l_tstamp}, {"exit", l_exit}, {"font", l_font}, {"mouse", l_mouse}, {"circ", l_circ}, {"circb", l_circb},
    {"elli", l_elli}, {"ellib", l_ellib}, {"paint", l_paint}, {"tri", l_tri}, {"trib", l_trib}, {"ttri", l_ttri},
    {"textri", l_textri}, {"clip", l_clip}, {"music", l_music}, {"sync", l_sync}, {"vbank", l_vbank}, {"reset", l_reset},
    {"key", l_key}, {"keyp", l_keyp}, {"fget", l_fget}, {"fset", l_fset}, {"fft", l_fft}, {"ffts", l_ffts},
    {"_cbx_palette", l_palette}, {NULL, NULL},
  };
  for (const luaL_Reg *f = api; f->func; f++) {
    lua_pushcfunction(L, f->func);
    lua_setglobal(L, f->name);
  }
}
