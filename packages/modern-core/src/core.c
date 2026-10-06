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
 * So that carts and the Lua SDK written for the other tiers run unchanged, the
 * core carries TIC-80 itself as far as a cart can see it (tic.c, ported from
 * TIC-80): its RAM in the HD core's layout, the cartridge's banks, the whole 2D
 * API (drawing, sprites, the map, text), input, sound, vbanks, and the
 * BOOT/TIC/OVR/SCN/BDR callbacks, with the HD core's tick order.
 *
 * Sandboxed: only Lua's base, coroutine, table, string, math and utf8
 * libraries, with file access (dofile, loadfile) removed. Deterministic:
 * math.random is Lua 5.3's on the C library's generator, as the HD core's, so
 * a seed gives the same numbers on both; the clock (time) is the HD core's
 * virtual one.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "lauxlib.h"
#include "lua.h"
#include "lualib.h"

#include "tic.h"

/* Host functions (host.js): the direct API and traces. */
extern void cbx_host_command(int op, int a, double v1, double v2, double v3, double v4, double v5, double v6);
extern int cbx_host_query(int op, int a, double v1, double v2, double v3, double v4, double v5, double v6);
extern void cbx_host_trace(const char *s, int len);

#define MAX_RETURNS 32
#define MAX_CHUNKS 16

static struct {
  lua_State *L;
  int booted;
  int failed; /* a callback (BOOT, SCN, BDR, OVR) failed this tick */
  /* What has been run, in order, so reset() can run it again. */
  char *chunks[MAX_CHUNKS];
  int lengths[MAX_CHUNKS];
  int count;
  char error[1024];
} core;

/* Values a query hands back: the host writes them here before returning their count. */
static double returns[MAX_RETURNS];

static void set_error(const char *msg) {
  strncpy(core.error, msg ? msg : "unknown error", sizeof core.error - 1);
  core.error[sizeof core.error - 1] = 0;
}

void cbx_core_callback_error(const char *message) {
  set_error(message);
  core.failed = 1;
}

void cbx_core_trace(const char *s, int len) { cbx_host_trace(s, len); }

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

/* ---- random numbers, as the HD core's Lua 5.3 makes them ----------------- */

/*
 * TIC-80 runs Lua 5.3, whose math.random draws from the C library's rand(),
 * where Lua 5.4's has its own generator. Both cores are built on Emscripten's
 * C library, so with Lua 5.3's two functions (lmathlib.c, MIT) a seeded cart
 * rolls the same numbers here as on the HD core.
 */
static int l_random(lua_State *L) {
  lua_Integer low, up;
  double r = (double)rand() * (1.0 / ((double)RAND_MAX + 1.0));
  switch (lua_gettop(L)) {
    case 0: lua_pushnumber(L, (lua_Number)r); return 1;
    case 1: low = 1; up = luaL_checkinteger(L, 1); break;
    case 2: low = luaL_checkinteger(L, 1); up = luaL_checkinteger(L, 2); break;
    default: return luaL_error(L, "wrong number of arguments");
  }
  luaL_argcheck(L, low <= up, 1, "interval is empty");
  luaL_argcheck(L, low >= 0 || up <= LUA_MAXINTEGER + low, 1, "interval too large");
  r *= (double)(up - low) + 1.0;
  lua_pushinteger(L, (lua_Integer)r + low);
  return 1;
}

static int l_randomseed(lua_State *L) {
  srand((unsigned int)(lua_Integer)luaL_checknumber(L, 1));
  (void)rand(); /* Lua 5.3 discards the first value */
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
  set_error(lua_tostring(core.L, -1));
  lua_pop(core.L, 1);
  return 0;
}

static lua_State *open_state(void) {
  lua_State *L = luaL_newstate();
  if (!L) return NULL;
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
  tic_open(L);
  lua_pushcfunction(L, l_cmd); lua_setglobal(L, "_cbx_cmd");
  lua_pushcfunction(L, l_query); lua_setglobal(L, "_cbx_query");
  lua_getglobal(L, "math");
  lua_pushcfunction(L, l_random);
  lua_setfield(L, -2, "random");
  lua_pushcfunction(L, l_randomseed);
  lua_setfield(L, -2, "randomseed");
  lua_pop(L, 1);
  return L;
}

static int run(const char *code, int len) {
  lua_State *L = core.L;
  lua_pushcfunction(L, traceback);
  int status = luaL_loadbuffer(L, code, (size_t)len, "=cart");
  if (status == LUA_OK) status = lua_pcall(L, 0, 0, -2);
  int ok = report(status);
  lua_pop(L, 1);
  return ok;
}

/* Call a global function (BOOT, TIC) if it's there; 0 on its error. */
static int call(const char *name, int required) {
  lua_State *L = core.L;
  lua_pushcfunction(L, traceback);
  lua_getglobal(L, name);
  int ok = 1;
  if (lua_isfunction(L, -1)) ok = report(lua_pcall(L, 0, 0, -2));
  else {
    lua_pop(L, 1);
    if (required) {
      set_error("'function TIC()...' isn't found :(");
      ok = 0;
    }
  }
  lua_pop(L, 1);
  return ok;
}

/* reset(): as TIC-80 does it, bank 0 back into RAM and the cart run again from the top in a new VM. */
static void restart(void) {
  lua_close(core.L);
  core.L = open_state();
  tic_cart2ram();
  for (int i = 0; i < core.count; i++) run(core.chunks[i], core.lengths[i]);
  core.booted = 0;
}

/*
 * Start a console of `width × height`, its random numbers seeded with `seed`,
 * with `ram_size` bytes of RAM whose persistent words start at `pmem_address`
 * (the TIC-80–derived core's layout, so the Lua SDK's blocks sit where it
 * expects them), its sound at `sample_rate`.
 */
EMSCRIPTEN_KEEPALIVE int cbx_core_init(int width, int height, int seed, int ram_size, int pmem_address, int sample_rate) {
  if (core.L) lua_close(core.L);
  for (int i = 0; i < core.count; i++) free(core.chunks[i]);
  memset(&core, 0, sizeof core);
  if (!tic_init(width, height, ram_size, pmem_address, sample_rate)) return 0;
  /* Seed 0 leaves the generator as a new HD core has it: unseeded. */
  if (seed) {
    srand((unsigned int)seed);
    (void)rand();
  }
  core.L = open_state();
  return core.L != NULL;
}

/* A cartridge's banks (TIC-80's chunks): its palette, tiles, sprites, map, flags, sound and music. */
EMSCRIPTEN_KEEPALIVE void cbx_core_cart(const uint8_t *bytes, int len) {
  tic_cart(bytes, len);
  tic_boot();
}

/* Run code (a cart's top level, or the SDK's); 0 with the error in cbx_core_error. */
EMSCRIPTEN_KEEPALIVE int cbx_core_load(const char *code, int len) {
  if (!core.L) return 0;
  if (core.count < MAX_CHUNKS) {
    char *copy = malloc((size_t)len);
    if (copy) {
      memcpy(copy, code, (size_t)len);
      core.chunks[core.count] = copy;
      core.lengths[core.count] = len;
      core.count++;
    }
  }
  return run(code, len);
}

/* One frame, in the HD core's order: input and sound, BOOT (once), TIC, OVR, then the frame and its sound. 0 on an error. */
EMSCRIPTEN_KEEPALIVE int cbx_core_tick(int buttons) {
  if (!core.L) return 0;
  if (tic_reset_requested()) restart();
  core.failed = 0;
  tic_tick_start((uint32_t)buttons);
  int ok = 1;
  if (!core.booted) {
    core.booted = 1;
    ok = call("BOOT", 0);
  }
  int ticked = call("TIC", 1);
  ok = ok && ticked;
  tic_tick_end(ticked ? core.L : NULL);
  tic_blit(core.L);
  tic_synth();
  return ok && !core.failed;
}

EMSCRIPTEN_KEEPALIVE uint32_t *cbx_core_framebuffer(void) { return tic_frame(); }
EMSCRIPTEN_KEEPALIVE uint8_t *cbx_core_ram(void) { return tic_ram(); }
EMSCRIPTEN_KEEPALIVE int16_t *cbx_core_samples(void) { return tic_samples(); }
EMSCRIPTEN_KEEPALIVE int cbx_core_sample_count(void) { return tic_sample_count(); }
EMSCRIPTEN_KEEPALIVE double *cbx_core_returns(void) { return returns; }
EMSCRIPTEN_KEEPALIVE const char *cbx_core_error(void) { return core.error; }
EMSCRIPTEN_KEEPALIVE int cbx_core_memory(void) { return core.L ? lua_gc(core.L, LUA_GCCOUNT, 0) : 0; }
