/**
 * Voxel avatar model — the player character shown on the console profile.
 *
 * An avatar is a small stack of part choices (hair, headgear, outfit,
 * accessory) plus palette picks, all gaming-flavored: armor, wizard robes,
 * space suits, headsets, swords, capes. This module is the pure core:
 * normalization, randomization, and the procedural voxel builder that turns a
 * spec into colored cubes for the renderer. No DOM, fully unit-testable.
 *
 * Coordinates: x = left→right, y = up (0 = feet), z = back→front.
 */

export interface VoxelAvatarSpec {
  hair: number;
  headgear: number;
  outfit: number;
  accessory: number;
  /** Palette indices. */
  skin: number;
  hairColor: number;
  outfitColor: number;
  accentColor: number;
}

export const HAIR_STYLES = ["Buzz", "Spiky", "Long", "Ponytail", "Afro", "Bald"] as const;
export const HEADGEAR = ["None", "Cap", "Crown", "Headset", "Horns", "Hood"] as const;
export const OUTFITS = ["Tee", "Hoodie", "Armor", "Wizard Robe", "Space Suit", "Racer Jacket"] as const;
export const ACCESSORIES = ["None", "Sword", "Shield", "Backpack", "Controller", "Cape"] as const;

export const SKIN_TONES = ["#f2c9a0", "#e0ac69", "#c68642", "#8d5524", "#5c3b1e", "#a8e6cf"] as const;
export const COLOR_CHOICES = [
  "#ff5d8f",
  "#f6b74a",
  "#57d18d",
  "#5aa9ff",
  "#8f86c6",
  "#ff8a3d",
  "#3fd3c2",
  "#e8e8ee",
  "#40405c",
  "#151221",
] as const;

/** Fixed material colors parts rely on. */
const GOLD = "#ffd24a";
const SILVER = "#c9ccda";
const DARK = "#17141f";
const WHITE = "#f2f2f7";

export const DEFAULT_VOXEL_AVATAR: VoxelAvatarSpec = {
  hair: 0,
  headgear: 0,
  outfit: 0,
  accessory: 0,
  skin: 0,
  hairColor: 8,
  outfitColor: 3,
  accentColor: 1,
};

function clampIndex(value: unknown, count: number, fallback: number): number {
  const index = typeof value === "number" && Number.isInteger(value) ? value : fallback;
  return Math.min(Math.max(index, 0), count - 1);
}

/** Coerces any input into a valid spec; absent fields take the default look. */
export function normalizeVoxelAvatar(input: unknown): VoxelAvatarSpec {
  const raw = (input ?? {}) as Record<string, unknown>;
  const defaults = DEFAULT_VOXEL_AVATAR;
  return {
    hair: clampIndex(raw.hair, HAIR_STYLES.length, defaults.hair),
    headgear: clampIndex(raw.headgear, HEADGEAR.length, defaults.headgear),
    outfit: clampIndex(raw.outfit, OUTFITS.length, defaults.outfit),
    accessory: clampIndex(raw.accessory, ACCESSORIES.length, defaults.accessory),
    skin: clampIndex(raw.skin, SKIN_TONES.length, defaults.skin),
    hairColor: clampIndex(raw.hairColor, COLOR_CHOICES.length, defaults.hairColor),
    outfitColor: clampIndex(raw.outfitColor, COLOR_CHOICES.length, defaults.outfitColor),
    accentColor: clampIndex(raw.accentColor, COLOR_CHOICES.length, defaults.accentColor),
  };
}

/** A random avatar; inject the RNG for deterministic tests. */
export function randomVoxelAvatar(random: () => number = Math.random): VoxelAvatarSpec {
  const pick = (count: number) => Math.floor(random() * count);
  return {
    hair: pick(HAIR_STYLES.length),
    headgear: pick(HEADGEAR.length),
    outfit: pick(OUTFITS.length),
    accessory: pick(ACCESSORIES.length),
    skin: pick(SKIN_TONES.length),
    hairColor: pick(COLOR_CHOICES.length),
    outfitColor: pick(COLOR_CHOICES.length),
    accentColor: pick(COLOR_CHOICES.length),
  };
}

export interface Voxel {
  x: number;
  y: number;
  z: number;
  color: string;
}

/** Later writes win, so parts layered after the body replace its voxels. */
class VoxelGrid {
  private readonly cells = new Map<string, Voxel>();

  set(x: number, y: number, z: number, color: string): void {
    this.cells.set(`${x},${y},${z}`, { x, y, z, color });
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: string): void {
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (let z = z0; z <= z1; z += 1) {
          this.set(x, y, z, color);
        }
      }
    }
  }

  list(): Voxel[] {
    return [...this.cells.values()];
  }
}

/**
 * Builds the avatar's voxels. Layer order matters: body first, then outfit
 * details, hair, headgear, accessory — later layers overwrite shared cells
 * (a hood replaces hair, armor replaces the shirt).
 */
export function buildAvatarVoxels(spec: VoxelAvatarSpec): Voxel[] {
  const grid = new VoxelGrid();
  const skin = SKIN_TONES[spec.skin]!;
  const hair = COLOR_CHOICES[spec.hairColor]!;
  const outfit = COLOR_CHOICES[spec.outfitColor]!;
  const accent = COLOR_CHOICES[spec.accentColor]!;

  // --- Base body ----------------------------------------------------------
  grid.box(-2, -1, 0, 5, -1, 0, DARK); // left leg (pants)
  grid.box(1, 2, 0, 5, -1, 0, DARK); // right leg
  grid.box(-3, 2, 6, 12, -1, 1, outfit); // torso
  grid.box(-5, -4, 6, 11, -1, 0, skin); // left arm
  grid.box(4, 5, 6, 11, -1, 0, skin); // right arm
  grid.box(-3, 2, 13, 18, -2, 2, skin); // head
  grid.set(-2, 16, 2, DARK); // eyes, always front
  grid.set(1, 16, 2, DARK);

  // --- Outfit -------------------------------------------------------------
  switch (spec.outfit) {
    case 0: // Tee: short sleeves
      grid.box(-5, -4, 10, 11, -1, 0, outfit);
      grid.box(4, 5, 10, 11, -1, 0, outfit);
      break;
    case 1: // Hoodie: full sleeves + kangaroo pocket
      grid.box(-5, -4, 6, 11, -1, 0, outfit);
      grid.box(4, 5, 6, 11, -1, 0, outfit);
      grid.box(-1, 0, 6, 8, 1, 1, accent);
      break;
    case 2: // Armor: silver plate + pauldrons
      grid.box(-3, 2, 6, 12, -1, 1, SILVER);
      grid.box(-6, -4, 11, 12, -1, 1, accent);
      grid.box(4, 6, 11, 12, -1, 1, accent);
      break;
    case 3: // Wizard robe: skirt over the legs + full sleeves
      grid.box(-3, 2, 1, 5, -1, 1, outfit);
      grid.box(-5, -4, 6, 11, -1, 0, outfit);
      grid.box(4, 5, 6, 11, -1, 0, outfit);
      grid.box(-3, 2, 12, 12, -1, 1, accent); // trim collar
      break;
    case 4: // Space suit: white shell, chest panel, oxygen pack
      grid.box(-3, 2, 6, 12, -1, 1, WHITE);
      grid.box(-5, -4, 6, 11, -1, 0, WHITE);
      grid.box(4, 5, 6, 11, -1, 0, WHITE);
      grid.box(-1, 0, 9, 10, 1, 1, accent);
      grid.box(-2, 1, 8, 12, -2, -2, SILVER);
      break;
    case 5: // Racer jacket: center stripe + cuffs
      grid.box(-5, -4, 6, 11, -1, 0, outfit);
      grid.box(4, 5, 6, 11, -1, 0, outfit);
      grid.box(0, 0, 6, 12, 1, 1, WHITE);
      grid.box(-5, -4, 6, 6, -1, 0, accent);
      grid.box(4, 5, 6, 6, -1, 0, accent);
      break;
  }

  // --- Hair ---------------------------------------------------------------
  switch (spec.hair) {
    case 0: // Buzz
      grid.box(-3, 2, 19, 19, -2, 2, hair);
      break;
    case 1: // Spiky
      grid.box(-3, 2, 19, 19, -2, 2, hair);
      for (const x of [-3, -1, 1]) {
        grid.set(x, 20, 0, hair);
        grid.set(x + 1, 20, -1, hair);
      }
      break;
    case 2: // Long: top + a fall of hair down the back
      grid.box(-3, 2, 19, 19, -2, 2, hair);
      grid.box(-3, 2, 10, 18, -3, -3, hair);
      break;
    case 3: // Ponytail
      grid.box(-3, 2, 19, 19, -2, 2, hair);
      grid.box(-1, 0, 14, 19, -3, -3, hair);
      grid.box(-1, 0, 11, 13, -4, -4, hair);
      break;
    case 4: // Afro: a proud dome
      grid.box(-4, 3, 19, 21, -3, 3, hair);
      grid.box(-4, 3, 17, 18, -3, -3, hair);
      grid.box(-4, 3, 17, 18, 3, 3, hair);
      break;
    case 5: // Bald
      break;
  }

  // --- Headgear (drawn over hair) ------------------------------------------
  switch (spec.headgear) {
    case 1: // Cap with a front brim
      grid.box(-3, 2, 19, 19, -2, 2, accent);
      grid.box(-2, 1, 18, 18, 3, 5, accent);
      break;
    case 2: // Crown
      grid.box(-3, 2, 19, 19, -2, 2, GOLD);
      for (const x of [-3, -1, 1]) {
        grid.set(x, 20, 2, GOLD);
        grid.set(x + 1, 20, -2, GOLD);
      }
      break;
    case 3: // Gaming headset: band + ear cups
      grid.box(-3, 2, 19, 19, 0, 0, DARK);
      grid.box(-4, -4, 14, 16, -1, 1, accent);
      grid.box(3, 3, 14, 16, -1, 1, accent);
      break;
    case 4: // Horns
      grid.box(-3, -3, 19, 20, 0, 0, GOLD);
      grid.box(2, 2, 19, 20, 0, 0, GOLD);
      break;
    case 5: // Hood: wraps the head, replaces hair
      grid.box(-3, 2, 19, 19, -2, 2, outfit);
      grid.box(-3, 2, 13, 18, -3, -3, outfit);
      grid.box(-4, -4, 13, 19, -2, 2, outfit);
      grid.box(3, 3, 13, 19, -2, 2, outfit);
      break;
  }

  // --- Accessory ------------------------------------------------------------
  switch (spec.accessory) {
    case 1: // Sword on the back
      grid.box(2, 2, 8, 17, -3, -3, SILVER);
      grid.box(1, 3, 9, 9, -3, -3, GOLD);
      grid.set(2, 7, -3, DARK);
      break;
    case 2: // Shield on the left arm
      grid.box(-7, -6, 7, 11, -1, 1, accent);
      grid.box(-7, -6, 8, 10, 0, 0, GOLD);
      break;
    case 3: // Backpack
      grid.box(-2, 1, 7, 12, -3, -3, accent);
      grid.box(-1, 0, 12, 12, -4, -4, DARK);
      break;
    case 4: // Controller held in front
      grid.box(-2, 1, 8, 9, 2, 2, DARK);
      grid.set(-2, 9, 3, accent);
      grid.set(1, 9, 3, accent);
      break;
    case 5: // Cape
      grid.box(-3, 2, 3, 12, -3, -3, accent);
      break;
  }

  return grid.list();
}
