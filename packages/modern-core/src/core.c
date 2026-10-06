/*
 * The dedicated Modern core (ENGINE_PARITY_ROADMAP.md EP20b): a Lua 5.4 VM
 * with a direct scripting API, compiled to WebAssembly.
 *
 * The other tiers run carts in a TIC-80–derived core and reach the 3D engine
 * through a command channel in the core's RAM, read by the host after each
 * tick (64 commands a tick, 4159 with EP20's overflow ring). Here the cart's
 * calls into the engine are calls: _cbx_cmd and _cbx_query cross into the host
 * the moment the cart makes them (imported functions, see host.js), so there is
 * no cap and a query answers in the same call.
 *
 * Besides the bridge, the core keeps the cart's 2D layer: a 32-bit RGBA
 * framebuffer drawn with the familiar primitives (cls, pix, rect, rectb, line,
 * circ, circb, tri) in palette colours, and print, whose text the host draws
 * over the frame. Input is the console's buttons, given each tick (btn, btnp).
 *
 * Sandboxed: only Lua's base, coroutine, table, string, math and utf8
 * libraries, with file access (dofile, loadfile) removed. Deterministic: the
 * host seeds math.random; the clock (time) is the tick count.
 */

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "lauxlib.h"
#include "lua.h"
#include "lualib.h"

/* Host functions (host.js): the direct API, text and traces. */
extern void cbx_host_command(int op, int a, double v1, double v2, double v3, double v4, double v5, double v6);
extern int cbx_host_query(int op, int a, double v1, double v2, double v3, double v4, double v5, double v6);
extern void cbx_host_text(const char *s, int len, int x, int y, int color, int scale, int small);
extern void cbx_host_trace(const char *s, int len);

#define MAX_RETURNS 32

static struct {
  lua_State *L;
  int width, height;
  uint32_t *fb;
  uint32_t palette[256];
  uint32_t buttons, previous;
  int tick;
  int has_tic;
  char error[1024];
} core;

/* Values a query hands back: the host writes them here before returning their count. */
static double returns[MAX_RETURNS];

/* Sweetie 16, the TIC-80 default palette, then a grey ramp. */
static const uint32_t SWEETIE16[16] = {
  0x1a1c2c, 0x5d275d, 0xb13e53, 0xef7d57, 0xffcd75, 0xa7f070, 0x38b764, 0x257179,
  0x29366f, 0x3b5dc9, 0x41a6f6, 0x73eff7, 0xf4f4f4, 0x94b0c2, 0x566c86, 0x333c57,
};

static uint32_t rgba(uint32_t rgb) {
  /* Little-endian bytes R, G, B, A: what an ImageData reads. */
  return 0xff000000u | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
}

static void reset_palette(void) {
  for (int i = 0; i < 16; i++) core.palette[i] = rgba(SWEETIE16[i]);
  for (int i = 16; i < 256; i++) {
    uint32_t g = (uint32_t)((i - 16) * 255 / 239);
    core.palette[i] = rgba((g << 16) | (g << 8) | g);
  }
}

/* ---- 2D layer ----------------------------------------------------------- */

static inline void plot(int x, int y, int c) {
  if (x < 0 || y < 0 || x >= core.width || y >= core.height) return;
  core.fb[y * core.width + x] = core.palette[c & 0xff];
}

static void hspan(int x0, int x1, int y, int c) {
  if (y < 0 || y >= core.height) return;
  if (x0 > x1) { int t = x0; x0 = x1; x1 = t; }
  if (x0 < 0) x0 = 0;
  if (x1 >= core.width) x1 = core.width - 1;
  uint32_t color = core.palette[c & 0xff];
  uint32_t *row = core.fb + y * core.width;
  for (int x = x0; x <= x1; x++) row[x] = color;
}

static int color_arg(lua_State *L, int i) { return (int)luaL_optinteger(L, i, 0); }

static int l_cls(lua_State *L) {
  uint32_t color = core.palette[color_arg(L, 1) & 0xff];
  int n = core.width * core.height;
  for (int i = 0; i < n; i++) core.fb[i] = color;
  return 0;
}

static int l_pix(lua_State *L) {
  int x = (int)floor(luaL_checknumber(L, 1)), y = (int)floor(luaL_checknumber(L, 2));
  if (lua_isnoneornil(L, 3)) {
    /* Read: the palette index of the pixel (or 0 off screen). */
    if (x < 0 || y < 0 || x >= core.width || y >= core.height) { lua_pushinteger(L, 0); return 1; }
    uint32_t v = core.fb[y * core.width + x];
    for (int i = 0; i < 256; i++) if (core.palette[i] == v) { lua_pushinteger(L, i); return 1; }
    lua_pushinteger(L, 0);
    return 1;
  }
  plot(x, y, color_arg(L, 3));
  return 0;
}

static int l_rect(lua_State *L) {
  int x = (int)floor(luaL_checknumber(L, 1)), y = (int)floor(luaL_checknumber(L, 2));
  int w = (int)luaL_checknumber(L, 3), h = (int)luaL_checknumber(L, 4), c = color_arg(L, 5);
  for (int j = 0; j < h; j++) hspan(x, x + w - 1, y + j, c);
  return 0;
}

static int l_rectb(lua_State *L) {
  int x = (int)floor(luaL_checknumber(L, 1)), y = (int)floor(luaL_checknumber(L, 2));
  int w = (int)luaL_checknumber(L, 3), h = (int)luaL_checknumber(L, 4), c = color_arg(L, 5);
  if (w <= 0 || h <= 0) return 0;
  hspan(x, x + w - 1, y, c);
  hspan(x, x + w - 1, y + h - 1, c);
  for (int j = 1; j < h - 1; j++) { plot(x, y + j, c); plot(x + w - 1, y + j, c); }
  return 0;
}

static void line(int x0, int y0, int x1, int y1, int c) {
  int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  int err = dx + dy;
  for (;;) {
    plot(x0, y0, c);
    if (x0 == x1 && y0 == y1) break;
    int e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

static int l_line(lua_State *L) {
  line((int)floor(luaL_checknumber(L, 1)), (int)floor(luaL_checknumber(L, 2)), (int)floor(luaL_checknumber(L, 3)),
       (int)floor(luaL_checknumber(L, 4)), color_arg(L, 5));
  return 0;
}

static void circle(int cx, int cy, int r, int c, int filled) {
  if (r < 0) return;
  int x = r, y = 0, err = 1 - r;
  while (x >= y) {
    if (filled) {
      hspan(cx - x, cx + x, cy + y, c); hspan(cx - x, cx + x, cy - y, c);
      hspan(cx - y, cx + y, cy + x, c); hspan(cx - y, cx + y, cy - x, c);
    } else {
      plot(cx + x, cy + y, c); plot(cx - x, cy + y, c); plot(cx + x, cy - y, c); plot(cx - x, cy - y, c);
      plot(cx + y, cy + x, c); plot(cx - y, cy + x, c); plot(cx + y, cy - x, c); plot(cx - y, cy - x, c);
    }
    y++;
    if (err < 0) err += 2 * y + 1;
    else { x--; err += 2 * (y - x) + 1; }
  }
}

static int l_circ(lua_State *L) {
  circle((int)floor(luaL_checknumber(L, 1)), (int)floor(luaL_checknumber(L, 2)), (int)luaL_checknumber(L, 3), color_arg(L, 4), 1);
  return 0;
}

static int l_circb(lua_State *L) {
  circle((int)floor(luaL_checknumber(L, 1)), (int)floor(luaL_checknumber(L, 2)), (int)luaL_checknumber(L, 3), color_arg(L, 4), 0);
  return 0;
}

static int l_tri(lua_State *L) {
  double x[3], y[3];
  for (int i = 0; i < 3; i++) { x[i] = luaL_checknumber(L, 1 + i * 2); y[i] = luaL_checknumber(L, 2 + i * 2); }
  int c = color_arg(L, 7);
  /* Sort by y, then fill scanlines between the edges. */
  for (int i = 0; i < 2; i++)
    for (int j = 0; j < 2 - i; j++)
      if (y[j] > y[j + 1]) { double t = y[j]; y[j] = y[j + 1]; y[j + 1] = t; t = x[j]; x[j] = x[j + 1]; x[j + 1] = t; }
  int y0 = (int)ceil(y[0]), y2 = (int)floor(y[2]);
  for (int yy = y0; yy <= y2; yy++) {
    double fy = yy;
    double xa = y[2] != y[0] ? x[0] + (x[2] - x[0]) * (fy - y[0]) / (y[2] - y[0]) : x[0];
    double xb;
    if (fy < y[1]) xb = y[1] != y[0] ? x[0] + (x[1] - x[0]) * (fy - y[0]) / (y[1] - y[0]) : x[0];
    else xb = y[2] != y[1] ? x[1] + (x[2] - x[1]) * (fy - y[1]) / (y[2] - y[1]) : x[1];
    hspan((int)floor(fmin(xa, xb) + 0.5), (int)floor(fmax(xa, xb) - 0.5), yy, c);
  }
  return 0;
}

/* print(text, x, y, color, fixed, scale, small) -> width: the host draws the text over the frame. */
static int l_print(lua_State *L) {
  /* Arguments first: luaL_tolstring pushes its result onto the stack. */
  int x = (int)luaL_optnumber(L, 2, 0), y = (int)luaL_optnumber(L, 3, 0), c = (int)luaL_optinteger(L, 4, 15);
  int scale = (int)luaL_optinteger(L, 6, 1), small = lua_toboolean(L, 7);
  if (scale < 1) scale = 1;
  size_t len;
  const char *s = luaL_tolstring(L, 1, &len);
  cbx_host_text(s, (int)len, x, y, c, scale, small);
  lua_pushinteger(L, (lua_Integer)len * (small ? 4 : 6) * scale);
  return 1;
}

static int l_trace(lua_State *L) {
  size_t len;
  const char *s = luaL_tolstring(L, 1, &len);
  cbx_host_trace(s, (int)len);
  return 0;
}

/* ---- input and time ----------------------------------------------------- */

static int l_btn(lua_State *L) {
  if (lua_isnoneornil(L, 1)) { lua_pushinteger(L, core.buttons); return 1; }
  int i = (int)luaL_checkinteger(L, 1);
  lua_pushboolean(L, i >= 0 && i < 32 && (core.buttons >> i) & 1);
  return 1;
}

static int l_btnp(lua_State *L) {
  uint32_t pressed = core.buttons & ~core.previous;
  if (lua_isnoneornil(L, 1)) { lua_pushinteger(L, pressed); return 1; }
  int i = (int)luaL_checkinteger(L, 1);
  lua_pushboolean(L, i >= 0 && i < 32 && (pressed >> i) & 1);
  return 1;
}

static int l_time(lua_State *L) {
  lua_pushnumber(L, core.tick * 1000.0 / 60.0);
  return 1;
}

/* ---- the direct API ----------------------------------------------------- */

/* _cbx_cmd(op, a, v1..v6): handed to the host now, in order, with no cap. */
static int l_cmd(lua_State *L) {
  cbx_host_command((int)luaL_checkinteger(L, 1), (int)luaL_optinteger(L, 2, 0), luaL_optnumber(L, 3, 0), luaL_optnumber(L, 4, 0),
                   luaL_optnumber(L, 5, 0), luaL_optnumber(L, 6, 0), luaL_optnumber(L, 7, 0), luaL_optnumber(L, 8, 0));
  lua_pushboolean(L, 1);
  return 1;
}

/* _cbx_query(op, a, v1..v6) -> the host's answer, now (nil when it has none). */
static int l_query(lua_State *L) {
  int n = cbx_host_query((int)luaL_checkinteger(L, 1), (int)luaL_optinteger(L, 2, 0), luaL_optnumber(L, 3, 0), luaL_optnumber(L, 4, 0),
                         luaL_optnumber(L, 5, 0), luaL_optnumber(L, 6, 0), luaL_optnumber(L, 7, 0), luaL_optnumber(L, 8, 0));
  if (n <= 0) { lua_pushnil(L); return 1; }
  if (n > MAX_RETURNS) n = MAX_RETURNS;
  luaL_checkstack(L, n, "query results");
  for (int i = 0; i < n; i++) lua_pushnumber(L, returns[i]);
  return n;
}

static int l_palette(lua_State *L) {
  int i = (int)luaL_checkinteger(L, 1) & 0xff;
  int r = (int)luaL_checkinteger(L, 2) & 0xff, g = (int)luaL_checkinteger(L, 3) & 0xff, b = (int)luaL_checkinteger(L, 4) & 0xff;
  core.palette[i] = rgba(((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b);
  return 0;
}

/* ---- running ------------------------------------------------------------ */

static int traceback(lua_State *L) {
  const char *msg = lua_tostring(L, 1);
  luaL_traceback(L, L, msg ? msg : "(error object is not a string)", 1);
  return 1;
}

static int report(int status) {
  if (status == LUA_OK) return 1;
  const char *msg = lua_tostring(core.L, -1);
  strncpy(core.error, msg ? msg : "unknown error", sizeof core.error - 1);
  core.error[sizeof core.error - 1] = 0;
  lua_pop(core.L, 1);
  return 0;
}

static void open_libs(lua_State *L) {
  static const luaL_Reg libs[] = {
    {LUA_GNAME, luaopen_base}, {LUA_COLIBNAME, luaopen_coroutine}, {LUA_TABLIBNAME, luaopen_table},
    {LUA_STRLIBNAME, luaopen_string}, {LUA_MATHLIBNAME, luaopen_math}, {LUA_UTF8LIBNAME, luaopen_utf8}, {NULL, NULL},
  };
  for (const luaL_Reg *lib = libs; lib->func; lib++) {
    luaL_requiref(L, lib->name, lib->func, 1);
    lua_pop(L, 1);
  }
  /* No file access. */
  lua_pushnil(L); lua_setglobal(L, "dofile");
  lua_pushnil(L); lua_setglobal(L, "loadfile");
  static const luaL_Reg api[] = {
    {"cls", l_cls}, {"pix", l_pix}, {"rect", l_rect}, {"rectb", l_rectb}, {"line", l_line}, {"circ", l_circ},
    {"circb", l_circb}, {"tri", l_tri}, {"print", l_print}, {"trace", l_trace}, {"btn", l_btn}, {"btnp", l_btnp},
    {"time", l_time}, {"_cbx_cmd", l_cmd}, {"_cbx_query", l_query}, {"_cbx_palette", l_palette}, {NULL, NULL},
  };
  for (const luaL_Reg *f = api; f->func; f++) {
    lua_pushcfunction(L, f->func);
    lua_setglobal(L, f->name);
  }
}

/* Start a console of `width × height`, its random numbers seeded with `seed`. */
EMSCRIPTEN_KEEPALIVE int cbx_core_init(int width, int height, int seed) {
  if (core.L) lua_close(core.L);
  free(core.fb);
  memset(&core, 0, sizeof core);
  core.width = width;
  core.height = height;
  core.fb = calloc((size_t)width * height, sizeof(uint32_t));
  if (!core.fb) return 0;
  reset_palette();
  core.L = luaL_newstate();
  if (!core.L) return 0;
  open_libs(core.L);
  lua_getglobal(core.L, "math");
  lua_getfield(core.L, -1, "randomseed");
  lua_pushinteger(core.L, seed);
  lua_call(core.L, 1, 0);
  lua_pop(core.L, 1);
  return 1;
}

/* Run the cart's code (its top level); 0 with the error in cbx_core_error. */
EMSCRIPTEN_KEEPALIVE int cbx_core_load(const char *code, int len) {
  lua_State *L = core.L;
  if (!L) return 0;
  lua_pushcfunction(L, traceback);
  int status = luaL_loadbuffer(L, code, (size_t)len, "=cart");
  if (status == LUA_OK) status = lua_pcall(L, 0, 0, -2);
  int ok = report(status);
  lua_pop(L, 1);
  lua_getglobal(L, "TIC");
  core.has_tic = lua_isfunction(L, -1);
  lua_pop(L, 1);
  return ok;
}

/* One frame: the buttons held, then the cart's TIC. 0 on an error (the cart keeps running next tick). */
EMSCRIPTEN_KEEPALIVE int cbx_core_tick(int buttons) {
  lua_State *L = core.L;
  if (!L) return 0;
  core.previous = core.buttons;
  core.buttons = (uint32_t)buttons;
  core.tick++;
  lua_pushcfunction(L, traceback);
  lua_getglobal(L, "TIC");
  int ok = 1;
  if (lua_isfunction(L, -1)) ok = report(lua_pcall(L, 0, 0, -2));
  else lua_pop(L, 1);
  lua_pop(L, 1);
  return ok;
}

EMSCRIPTEN_KEEPALIVE uint32_t *cbx_core_framebuffer(void) { return core.fb; }
EMSCRIPTEN_KEEPALIVE double *cbx_core_returns(void) { return returns; }
EMSCRIPTEN_KEEPALIVE const char *cbx_core_error(void) { return core.error; }
EMSCRIPTEN_KEEPALIVE int cbx_core_memory(void) { return core.L ? lua_gc(core.L, LUA_GCCOUNT, 0) : 0; }
