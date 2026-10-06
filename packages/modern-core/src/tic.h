/*
 * The dedicated Modern core's TIC-80 compatibility layer (tic.c): TIC-80's RAM
 * in the HD core's layout, its cartridge banks, its 2D API (drawing, sprites,
 * the map, text), input, and sound, ported from TIC-80 so a cart sees exactly
 * what it would see on the TIC-80–derived HD core.
 */

#pragma once

#include <stdint.h>

#include "lua.h"

/* Start a console of width × height, its RAM `ram_size` bytes with the persistent words at `pmem_address`. */
int tic_init(int width, int height, int ram_size, int pmem_address, int sample_rate);
/* Read a cartridge's banks (TIC-80's chunk format); its code is the caller's to run. */
void tic_cart(const uint8_t *bytes, int len);
/* What TIC-80 does before running a cart: reset the console (tic_reset), then copy bank 0 into RAM (tic_cart2ram). */
void tic_boot(void);
void tic_reset(void);
void tic_cart2ram(void);
/* Register the TIC-80 API in a Lua state. */
void tic_open(lua_State *L);

/* One frame, around the cart's TIC: input and sound first; afterwards OVR, sound, then the frame (with SCN/BDR). */
void tic_tick_start(uint32_t buttons);
void tic_tick_end(lua_State *L);
void tic_blit(lua_State *L);
void tic_synth(void);

uint8_t *tic_ram(void);
uint32_t *tic_frame(void);
int16_t *tic_samples(void);
int tic_sample_count(void);

/* Whether the cart called reset(): the core then starts it again. */
int tic_reset_requested(void);

/* What the layer needs of the core (core.c): a callback's error, and trace. */
void cbx_core_callback_error(const char *message);
void cbx_core_trace(const char *s, int len);
