/**
 * Doom (Freedoom) as a Cartbox Game ABI title — see games/README.md.
 *
 * doomgeneric already splits Doom's main loop into `doomgeneric_Create` (init)
 * and `doomgeneric_Tick` (exactly one frame), and asks a platform backend for
 * six functions. That is close enough to the ABI that this file is the whole
 * port: it is a doomgeneric backend on one side and the seven ABI exports on
 * the other. No engine source is modified, which keeps the vendored tree a
 * verbatim GPL-2 copy that can be diffed against upstream.
 *
 * Nothing here touches SDL. The host owns the canvas, the clock, input and
 * saves, so the backend only converts a framebuffer, answers "what time is it"
 * from a clock the host drives, and drains a key queue the host fills.
 */

#include <dirent.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "doomgeneric.h"
#include "doomkeys.h"
#include "doomstat.h"
#include "i_timer.h"

#include <emscripten.h>

/**
 * Where the build script mounts the IWAD. Freedoom's assets are BSD-3-Clause,
 * so unlike Doom's own shareware WAD they ship with the title rather than
 * being supplied by the player.
 */
#define IWAD_PATH "/freedoom1.wad"

/** Doom renders at 320x200; the build pins doomgeneric to the same size. */
#define DOOM_WIDTH DOOMGENERIC_RESX
#define DOOM_HEIGHT DOOMGENERIC_RESY

/* --- Button mask ------------------------------------------------------- */

/* Must match BUTTON_BITS in apps/web/src/lib/gameInput.ts. */
#define BUTTON_UP 0x001u
#define BUTTON_DOWN 0x002u
#define BUTTON_LEFT 0x004u
#define BUTTON_RIGHT 0x008u
#define BUTTON_A 0x010u
#define BUTTON_B 0x020u
#define BUTTON_START 0x040u
#define BUTTON_SELECT 0x080u
#define BUTTON_X 0x100u
#define BUTTON_Y 0x200u

/**
 * Console button to Doom key.
 *
 * Chosen so the menu is reachable with the same buttons that play the game:
 * Doom's menu is driven by the arrows plus Enter and Escape, which is why
 * start/select carry those two rather than a gameplay action.
 */
typedef struct {
  uint32_t button;
  unsigned char doom_key;
} ButtonBinding;

static const ButtonBinding BUTTON_BINDINGS[] = {
    {BUTTON_UP, KEY_UPARROW},
    {BUTTON_DOWN, KEY_DOWNARROW},
    {BUTTON_LEFT, KEY_LEFTARROW},
    {BUTTON_RIGHT, KEY_RIGHTARROW},
    {BUTTON_A, KEY_FIRE},
    {BUTTON_B, KEY_USE},
    {BUTTON_X, KEY_RSHIFT}, /* run */
    {BUTTON_Y, KEY_TAB},    /* automap */
    {BUTTON_START, KEY_ENTER},
    {BUTTON_SELECT, KEY_ESCAPE},
};

#define BUTTON_BINDING_COUNT (sizeof(BUTTON_BINDINGS) / sizeof(BUTTON_BINDINGS[0]))

/* --- Key queue --------------------------------------------------------- */

/*
 * Doom pulls key events one at a time via DG_GetKey, but the host pushes a
 * whole button mask at once. The queue bridges the two: a mask change becomes
 * press/release events that Doom drains at its own pace.
 *
 * Sized well above the ten buttons so a frame in which every button changes
 * state cannot overflow it.
 */
#define KEY_QUEUE_SIZE 32

static unsigned short key_queue[KEY_QUEUE_SIZE];
static unsigned int key_queue_write = 0;
static unsigned int key_queue_read = 0;

static void queue_key(int pressed, unsigned char key) {
  key_queue[key_queue_write] = (unsigned short)((pressed << 8) | key);
  key_queue_write = (key_queue_write + 1) % KEY_QUEUE_SIZE;
}

/* --- Backend state ----------------------------------------------------- */

static uint8_t *frame_rgba = NULL;
static int doom_started = 0;

static uint32_t previous_buttons = 0;

/*
 * Doom's clock. Driven by the host's frame deltas rather than by wall time, so
 * the engine's sense of time cannot drift from the number of frames actually
 * rendered — a backgrounded tab resumes where it left off instead of
 * fast-forwarding through the backlog.
 *
 * Counted in tics rather than milliseconds because I_GetTime floors
 * `ms * 35 / 1000`: advancing the clock by 1000/35ms per tic and truncating
 * would leave I_GetTime stuck on the same tic (28ms still floors to tic 0),
 * and Doom only runs a tic when its clock says a new one is due.
 */
static uint64_t tic_count = 0;

/*
 * Time granted by DG_SleepMs, which is the escape valve for Doom's wait loops.
 * TryRunTics spins on "has a new tic arrived yet", polling I_GetTime and
 * calling I_Sleep(1) between attempts, and it is entered before the first
 * cartbox_tick ever runs. With a clock that only moves between ticks, that
 * loop could never terminate — the port hung on boot, right after ST_Init.
 * Honouring the sleep by advancing the clock (rather than blocking, which the
 * ABI forbids) is what lets those loops make progress and exit.
 */
static double slept_ms = 0.0;

static double tick_accumulator_ms = 0.0;

/** Serialised save blob, built by cartbox_save_size and consumed by cartbox_save. */
static uint8_t *pending_save = NULL;
static int pending_save_size = 0;

/* --- doomgeneric platform backend -------------------------------------- */

void DG_Init(void) {
  /* The framebuffer is allocated in cartbox_init, before Doom can draw. */
}

/**
 * Converts Doom's frame into the ABI framebuffer.
 *
 * doomgeneric's "rgba8888" mode is a misnomer: it packs the colour as
 * `B | G<<8 | R<<16`, which on a little-endian target lands in memory as
 * B,G,R,A — and it never writes the alpha byte, leaving it zero. Copying that
 * buffer straight out would produce a fully transparent, red/blue-swapped
 * image, so the channels are reordered and alpha forced opaque here.
 */
void DG_DrawFrame(void) {
  const uint32_t *source = (const uint32_t *)DG_ScreenBuffer;
  uint8_t *destination = frame_rgba;
  if (source == NULL || destination == NULL) {
    return;
  }

  for (int pixel = 0; pixel < DOOM_WIDTH * DOOM_HEIGHT; pixel++) {
    const uint32_t packed = source[pixel];
    destination[0] = (uint8_t)((packed >> 16) & 0xFFu); /* red */
    destination[1] = (uint8_t)((packed >> 8) & 0xFFu);  /* green */
    destination[2] = (uint8_t)(packed & 0xFFu);         /* blue */
    destination[3] = 0xFFu;                             /* opaque */
    destination += 4;
  }
}

/**
 * Advances the clock instead of blocking, which the ABI forbids.
 *
 * Doom calls this only from wait loops that poll I_GetTime, so granting the
 * time it asked for is both the honest reading of "sleep" against a virtual
 * clock and the only thing that lets those loops terminate.
 */
void DG_SleepMs(uint32_t ms) { slept_ms += (double)ms; }

/**
 * Milliseconds landing squarely inside the current tic, plus any slept time.
 *
 * The rounding is up, not down: I_GetTime computes `ms * 35 / 1000` with
 * integer division, so the value has to clear the tic boundary rather than sit
 * just under it.
 */
uint32_t DG_GetTicksMs(void) {
  const uint64_t tic_ms = (tic_count * 1000ULL + (TICRATE - 1)) / (uint64_t)TICRATE;
  return (uint32_t)(tic_ms + (uint64_t)slept_ms);
}

int DG_GetKey(int *pressed, unsigned char *doom_key) {
  if (key_queue_read == key_queue_write) {
    return 0;
  }
  const unsigned short entry = key_queue[key_queue_read];
  key_queue_read = (key_queue_read + 1) % KEY_QUEUE_SIZE;

  *pressed = entry >> 8;
  *doom_key = (unsigned char)(entry & 0xFF);
  return 1;
}

void DG_SetWindowTitle(const char *title) { (void)title; }

/* --- Save serialisation ------------------------------------------------ */

/*
 * Doom saves through its own menu, writing files into `savegamedir` on the
 * Emscripten in-memory filesystem — which the host never sees and which does
 * not survive a reload. The ABI save is therefore an archive of that
 * directory: the player saves the way Doom has always worked, and the host
 * persists the result. Restoring copies the files back before Doom reads them.
 */

#define SAVE_MAGIC 0x4D444243u /* "CBDM" little-endian */
#define SAVE_VERSION 1u
#define MAX_SAVE_ENTRIES 64
#define MAX_SAVE_BYTES (16 * 1024 * 1024)

static void write_u32(uint8_t *out, uint32_t value) {
  out[0] = (uint8_t)(value & 0xFFu);
  out[1] = (uint8_t)((value >> 8) & 0xFFu);
  out[2] = (uint8_t)((value >> 16) & 0xFFu);
  out[3] = (uint8_t)((value >> 24) & 0xFFu);
}

static uint32_t read_u32(const uint8_t *in) {
  return (uint32_t)in[0] | ((uint32_t)in[1] << 8) | ((uint32_t)in[2] << 16) |
         ((uint32_t)in[3] << 24);
}

/** Joins savegamedir and a filename. Caller frees. */
static char *save_path(const char *name) {
  if (savegamedir == NULL) {
    return NULL;
  }
  const size_t length = strlen(savegamedir) + strlen(name) + 1;
  char *path = (char *)malloc(length);
  if (path != NULL) {
    snprintf(path, length, "%s%s", savegamedir, name);
  }
  return path;
}

static long file_size(const char *path) {
  FILE *handle = fopen(path, "rb");
  if (handle == NULL) {
    return -1;
  }
  fseek(handle, 0, SEEK_END);
  const long size = ftell(handle);
  fclose(handle);
  return size;
}

/** Frees any blob left over from a previous save_size call. */
static void discard_pending_save(void) {
  free(pending_save);
  pending_save = NULL;
  pending_save_size = 0;
}

/**
 * Builds the save archive. Returns its size, or 0 when there is nothing saved.
 *
 * Building here rather than in cartbox_save is what lets cartbox_save_size
 * report an exact size: the archive's length depends on which files Doom has
 * written, so it cannot be predicted without walking them.
 */
int EMSCRIPTEN_KEEPALIVE cartbox_save_size(void) {
  discard_pending_save();

  if (!doom_started || savegamedir == NULL) {
    return 0;
  }

  DIR *directory = opendir(savegamedir);
  if (directory == NULL) {
    return 0;
  }

  char *names[MAX_SAVE_ENTRIES];
  long sizes[MAX_SAVE_ENTRIES];
  int count = 0;
  size_t total = 12; /* magic + version + entry count */

  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL && count < MAX_SAVE_ENTRIES) {
    /* Doom's savegames are doomsav*.dsg; skip ., .. and the config files. */
    if (strstr(entry->d_name, ".dsg") == NULL) {
      continue;
    }
    char *path = save_path(entry->d_name);
    if (path == NULL) {
      continue;
    }
    const long size = file_size(path);
    free(path);
    if (size <= 0 || total + 8 + (size_t)size > MAX_SAVE_BYTES) {
      continue;
    }
    names[count] = strdup(entry->d_name);
    if (names[count] == NULL) {
      continue;
    }
    sizes[count] = size;
    total += 8 + strlen(entry->d_name) + (size_t)size;
    count++;
  }
  closedir(directory);

  if (count == 0) {
    return 0;
  }

  pending_save = (uint8_t *)malloc(total);
  if (pending_save == NULL) {
    for (int i = 0; i < count; i++) {
      free(names[i]);
    }
    return 0;
  }

  uint8_t *cursor = pending_save;
  write_u32(cursor, SAVE_MAGIC);
  write_u32(cursor + 4, SAVE_VERSION);
  write_u32(cursor + 8, (uint32_t)count);
  cursor += 12;

  for (int i = 0; i < count; i++) {
    const uint32_t name_length = (uint32_t)strlen(names[i]);
    write_u32(cursor, name_length);
    cursor += 4;
    memcpy(cursor, names[i], name_length);
    cursor += name_length;
    write_u32(cursor, (uint32_t)sizes[i]);
    cursor += 4;

    char *path = save_path(names[i]);
    FILE *handle = path != NULL ? fopen(path, "rb") : NULL;
    free(path);
    if (handle == NULL || fread(cursor, 1, (size_t)sizes[i], handle) != (size_t)sizes[i]) {
      /* A file that vanished mid-walk invalidates the whole archive. */
      if (handle != NULL) {
        fclose(handle);
      }
      for (int j = i; j < count; j++) {
        free(names[j]);
      }
      discard_pending_save();
      return 0;
    }
    fclose(handle);
    cursor += sizes[i];
    free(names[i]);
  }

  pending_save_size = (int)total;
  return pending_save_size;
}

int EMSCRIPTEN_KEEPALIVE cartbox_save(uint8_t *out) {
  if (pending_save == NULL || pending_save_size <= 0 || out == NULL) {
    return 0;
  }
  memcpy(out, pending_save, (size_t)pending_save_size);
  const int written = pending_save_size;
  discard_pending_save();
  return written;
}

/**
 * Restores a save archive, rejecting anything it does not recognise.
 *
 * Every length is checked against the remaining bytes before it is trusted, so
 * a truncated or hostile blob cannot walk off the end of the buffer.
 */
int EMSCRIPTEN_KEEPALIVE cartbox_load(const uint8_t *data, int size) {
  if (!doom_started || savegamedir == NULL || data == NULL || size < 12) {
    return 0;
  }
  if (read_u32(data) != SAVE_MAGIC || read_u32(data + 4) != SAVE_VERSION) {
    return 0;
  }

  const uint32_t count = read_u32(data + 8);
  if (count > MAX_SAVE_ENTRIES) {
    return 0;
  }

  int offset = 12;
  for (uint32_t i = 0; i < count; i++) {
    if (offset + 4 > size) {
      return 0;
    }
    const uint32_t name_length = read_u32(data + offset);
    offset += 4;
    if (name_length == 0 || name_length > 255 || (int64_t)offset + name_length + 4 > size) {
      return 0;
    }

    char name[256];
    memcpy(name, data + offset, name_length);
    name[name_length] = '\0';
    offset += (int)name_length;

    /* A name containing a path separator would escape the save directory. */
    if (strchr(name, '/') != NULL || strchr(name, '\\') != NULL) {
      return 0;
    }

    const uint32_t payload_size = read_u32(data + offset);
    offset += 4;
    if ((int64_t)offset + payload_size > size) {
      return 0;
    }

    char *path = save_path(name);
    if (path == NULL) {
      return 0;
    }
    FILE *handle = fopen(path, "wb");
    free(path);
    if (handle == NULL) {
      return 0;
    }
    const size_t written = fwrite(data + offset, 1, payload_size, handle);
    fclose(handle);
    if (written != payload_size) {
      return 0;
    }
    offset += (int)payload_size;
  }

  return 1;
}

/* --- Cartbox ABI ------------------------------------------------------- */

/**
 * Boots Doom and returns the framebuffer the host reads every frame.
 *
 * The dimensions are compiled into doomgeneric, so a host asking for anything
 * else is a configuration error rather than something to scale around:
 * returning NULL surfaces it immediately as an ABI error naming the game,
 * instead of a subtly torn image later.
 */
uint8_t *EMSCRIPTEN_KEEPALIVE cartbox_init(int width, int height) {
  if (width != DOOM_WIDTH || height != DOOM_HEIGHT) {
    return NULL;
  }
  if (doom_started) {
    return frame_rgba;
  }

  frame_rgba = (uint8_t *)calloc((size_t)(DOOM_WIDTH * DOOM_HEIGHT * 4), 1);
  if (frame_rgba == NULL) {
    return NULL;
  }

  /*
   * Doom keeps these pointers for the process lifetime (myargv), so they are
   * static rather than stack storage. -nosound because the ABI has no audio
   * channel at all; leaving it on would only initialise a driver that has
   * nowhere to play.
   */
  static char argument0[] = "doom";
  static char argument1[] = "-iwad";
  static char argument2[] = IWAD_PATH;
  static char argument3[] = "-nosound";
  static char *arguments[] = {argument0, argument1, argument2, argument3};

  doomgeneric_Create(4, arguments);
  doom_started = 1;

  return frame_rgba;
}

void EMSCRIPTEN_KEEPALIVE cartbox_set_input(uint32_t buttons) {
  const uint32_t changed = buttons ^ previous_buttons;
  if (changed != 0) {
    for (size_t i = 0; i < BUTTON_BINDING_COUNT; i++) {
      const ButtonBinding binding = BUTTON_BINDINGS[i];
      if ((changed & binding.button) != 0) {
        queue_key((buttons & binding.button) != 0 ? 1 : 0, binding.doom_key);
      }
    }
  }
  previous_buttons = buttons;
}

/*
 * Doom advances in fixed 35Hz tics and TryRunTics always runs at least one,
 * so calling doomgeneric_Tick once per host frame would run the game at the
 * display's refresh rate — roughly 1.7x too fast at 60fps. The accumulator
 * below converts the host's variable frame rate into Doom's fixed tic rate.
 */
#define MS_PER_TIC (1000.0 / (double)TICRATE)

/** Bounds catch-up work so a long stall cannot spiral into a frozen tab. */
#define MAX_TICS_PER_FRAME 3

void EMSCRIPTEN_KEEPALIVE cartbox_tick(float delta_seconds) {
  if (!doom_started) {
    return;
  }
  if (!(delta_seconds > 0.0f)) {
    return;
  }

  tick_accumulator_ms += (double)delta_seconds * 1000.0;

  int tics_run = 0;
  while (tick_accumulator_ms >= MS_PER_TIC && tics_run < MAX_TICS_PER_FRAME) {
    tick_accumulator_ms -= MS_PER_TIC;
    tic_count++;
    doomgeneric_Tick();
    tics_run++;
  }

  /* Drop the backlog rather than paying it off over the following frames. */
  if (tick_accumulator_ms >= MS_PER_TIC) {
    tick_accumulator_ms = 0.0;
  }
}

/**
 * Doom has no score, so the closest honest equivalent is the console player's
 * kill count — the number the end-of-level screen tallies.
 */
int EMSCRIPTEN_KEEPALIVE cartbox_score(void) {
  if (!doom_started) {
    return 0;
  }
  return players[consoleplayer].killcount;
}
