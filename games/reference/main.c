/*
 * Reference implementation of the Cartbox Game ABI (see ../README.md).
 *
 * A small but genuinely playable game: steer a collector around a field, gather
 * pickups for points, avoid drifting hazards. It exists to exercise every part
 * of the ABI against a real WebAssembly binary — framebuffer handoff, input,
 * scoring, and save/load round-tripping — so the host runtime is verified
 * against compiled code rather than a JavaScript stand-in.
 *
 * Deliberately dependency-free: no SDL, no libc beyond string/stdlib, so it
 * builds anywhere emcc does and the ABI stays visible rather than buried under
 * a framework.
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MAX_DIMENSION 1024
#define PICKUP_COUNT 6
#define HAZARD_COUNT 3
#define PLAYER_RADIUS 5
#define ENTITY_RADIUS 4
#define PLAYER_SPEED 90.0f
#define HAZARD_SPEED 45.0f

/* Button bits — must match BUTTON_BITS in apps/web/src/lib/gameInput.ts. */
#define BUTTON_UP 0x01u
#define BUTTON_DOWN 0x02u
#define BUTTON_LEFT 0x04u
#define BUTTON_RIGHT 0x08u
#define BUTTON_A 0x10u

/* Bumped whenever the save layout changes, so old saves are rejected not misread. */
#define SAVE_MAGIC 0x43425831u /* "CBX1" */

typedef struct {
    float x;
    float y;
    float velocityX;
    float velocityY;
    int active;
} Entity;

typedef struct {
    uint32_t magic;
    int32_t score;
    float playerX;
    float playerY;
    Entity pickups[PICKUP_COUNT];
    Entity hazards[HAZARD_COUNT];
    uint32_t rngState;
} SaveState;

static uint8_t *framebuffer = NULL;
static int screenWidth = 0;
static int screenHeight = 0;

static float playerX = 0.0f;
static float playerY = 0.0f;
static int score = 0;
static uint32_t buttons = 0;
static uint32_t rngState = 0x13579bdfu;

static Entity pickups[PICKUP_COUNT];
static Entity hazards[HAZARD_COUNT];

/* xorshift — deterministic, so a restored save replays identically. */
static uint32_t nextRandom(void) {
    rngState ^= rngState << 13;
    rngState ^= rngState >> 17;
    rngState ^= rngState << 5;
    return rngState;
}

static float randomInRange(float low, float high) {
    return low + (float)(nextRandom() % 10000u) / 10000.0f * (high - low);
}

static void placeEntity(Entity *entity, float speed) {
    entity->x = randomInRange((float)ENTITY_RADIUS, (float)(screenWidth - ENTITY_RADIUS));
    entity->y = randomInRange((float)ENTITY_RADIUS, (float)(screenHeight - ENTITY_RADIUS));
    entity->velocityX = randomInRange(-speed, speed);
    entity->velocityY = randomInRange(-speed, speed);
    entity->active = 1;
}

static void resetWorld(void) {
    playerX = (float)screenWidth / 2.0f;
    playerY = (float)screenHeight / 2.0f;
    score = 0;
    for (int i = 0; i < PICKUP_COUNT; ++i) {
        placeEntity(&pickups[i], 0.0f);
    }
    for (int i = 0; i < HAZARD_COUNT; ++i) {
        placeEntity(&hazards[i], HAZARD_SPEED);
    }
}

static void putPixel(int x, int y, uint8_t r, uint8_t g, uint8_t b) {
    if (x < 0 || y < 0 || x >= screenWidth || y >= screenHeight) {
        return;
    }
    uint8_t *pixel = framebuffer + ((size_t)y * (size_t)screenWidth + (size_t)x) * 4u;
    pixel[0] = r;
    pixel[1] = g;
    pixel[2] = b;
    pixel[3] = 255u;
}

static void fillDisc(float centreX, float centreY, int radius, uint8_t r, uint8_t g, uint8_t b) {
    for (int dy = -radius; dy <= radius; ++dy) {
        for (int dx = -radius; dx <= radius; ++dx) {
            if (dx * dx + dy * dy <= radius * radius) {
                putPixel((int)centreX + dx, (int)centreY + dy, r, g, b);
            }
        }
    }
}

static int overlaps(float ax, float ay, float bx, float by, int radius) {
    float dx = ax - bx;
    float dy = ay - by;
    return (dx * dx + dy * dy) <= (float)(radius * radius);
}

static void clampToField(float *value, float low, float high) {
    if (*value < low) {
        *value = low;
    }
    if (*value > high) {
        *value = high;
    }
}

EMSCRIPTEN_KEEPALIVE
uint8_t *cartbox_init(int width, int height) {
    if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        return NULL;
    }
    free(framebuffer);
    screenWidth = width;
    screenHeight = height;
    framebuffer = (uint8_t *)calloc((size_t)width * (size_t)height * 4u, 1u);
    if (framebuffer == NULL) {
        return NULL;
    }
    resetWorld();
    return framebuffer;
}

EMSCRIPTEN_KEEPALIVE
void cartbox_set_input(uint32_t pressed) {
    buttons = pressed;
}

EMSCRIPTEN_KEEPALIVE
void cartbox_tick(float deltaSeconds) {
    if (framebuffer == NULL) {
        return;
    }
    /* Clamp the step so a backgrounded tab does not teleport everything on return. */
    if (deltaSeconds > 0.1f) {
        deltaSeconds = 0.1f;
    }

    if (buttons & BUTTON_LEFT) {
        playerX -= PLAYER_SPEED * deltaSeconds;
    }
    if (buttons & BUTTON_RIGHT) {
        playerX += PLAYER_SPEED * deltaSeconds;
    }
    if (buttons & BUTTON_UP) {
        playerY -= PLAYER_SPEED * deltaSeconds;
    }
    if (buttons & BUTTON_DOWN) {
        playerY += PLAYER_SPEED * deltaSeconds;
    }
    clampToField(&playerX, (float)PLAYER_RADIUS, (float)(screenWidth - PLAYER_RADIUS));
    clampToField(&playerY, (float)PLAYER_RADIUS, (float)(screenHeight - PLAYER_RADIUS));

    for (int i = 0; i < HAZARD_COUNT; ++i) {
        Entity *hazard = &hazards[i];
        hazard->x += hazard->velocityX * deltaSeconds;
        hazard->y += hazard->velocityY * deltaSeconds;
        if (hazard->x < (float)ENTITY_RADIUS || hazard->x > (float)(screenWidth - ENTITY_RADIUS)) {
            hazard->velocityX = -hazard->velocityX;
            clampToField(&hazard->x, (float)ENTITY_RADIUS, (float)(screenWidth - ENTITY_RADIUS));
        }
        if (hazard->y < (float)ENTITY_RADIUS || hazard->y > (float)(screenHeight - ENTITY_RADIUS)) {
            hazard->velocityY = -hazard->velocityY;
            clampToField(&hazard->y, (float)ENTITY_RADIUS, (float)(screenHeight - ENTITY_RADIUS));
        }
        if (overlaps(playerX, playerY, hazard->x, hazard->y, PLAYER_RADIUS + ENTITY_RADIUS)) {
            score -= 1;
            placeEntity(hazard, HAZARD_SPEED);
        }
    }

    int remaining = 0;
    for (int i = 0; i < PICKUP_COUNT; ++i) {
        Entity *pickup = &pickups[i];
        if (!pickup->active) {
            continue;
        }
        remaining += 1;
        if (overlaps(playerX, playerY, pickup->x, pickup->y, PLAYER_RADIUS + ENTITY_RADIUS)) {
            pickup->active = 0;
            score += 10;
        }
    }
    /* Clearing the field respawns it, so the game has no dead end. */
    if (remaining == 0) {
        for (int i = 0; i < PICKUP_COUNT; ++i) {
            placeEntity(&pickups[i], 0.0f);
        }
    }

    /* Repaint: dark field, pickups, hazards, then the player on top. */
    for (int y = 0; y < screenHeight; ++y) {
        for (int x = 0; x < screenWidth; ++x) {
            putPixel(x, y, 16u, 18u, 28u);
        }
    }
    for (int i = 0; i < PICKUP_COUNT; ++i) {
        if (pickups[i].active) {
            fillDisc(pickups[i].x, pickups[i].y, ENTITY_RADIUS, 96u, 220u, 128u);
        }
    }
    for (int i = 0; i < HAZARD_COUNT; ++i) {
        fillDisc(hazards[i].x, hazards[i].y, ENTITY_RADIUS, 224u, 80u, 96u);
    }
    fillDisc(playerX, playerY, PLAYER_RADIUS, 240u, 232u, 120u);
}

EMSCRIPTEN_KEEPALIVE
int cartbox_score(void) {
    return score;
}

EMSCRIPTEN_KEEPALIVE
int cartbox_save_size(void) {
    return (int)sizeof(SaveState);
}

EMSCRIPTEN_KEEPALIVE
int cartbox_save(uint8_t *out) {
    if (out == NULL || framebuffer == NULL) {
        return 0;
    }
    SaveState state;
    memset(&state, 0, sizeof(state));
    state.magic = SAVE_MAGIC;
    state.score = score;
    state.playerX = playerX;
    state.playerY = playerY;
    state.rngState = rngState;
    memcpy(state.pickups, pickups, sizeof(pickups));
    memcpy(state.hazards, hazards, sizeof(hazards));
    memcpy(out, &state, sizeof(state));
    return (int)sizeof(state);
}

EMSCRIPTEN_KEEPALIVE
int cartbox_load(const uint8_t *data, int size) {
    /* Saves outlive game updates, so an unrecognised one is rejected, not read. */
    if (data == NULL || size != (int)sizeof(SaveState)) {
        return 0;
    }
    SaveState state;
    memcpy(&state, data, sizeof(state));
    if (state.magic != SAVE_MAGIC) {
        return 0;
    }
    score = state.score;
    playerX = state.playerX;
    playerY = state.playerY;
    rngState = state.rngState;
    memcpy(pickups, state.pickups, sizeof(pickups));
    memcpy(hazards, state.hazards, sizeof(hazards));
    return 1;
}
