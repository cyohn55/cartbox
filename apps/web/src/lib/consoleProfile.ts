/**
 * Pure logic behind the console's profile and community-composer features:
 * resolving which clips a profile showcases, and validating a community post
 * before it reaches the database. Server routes and client screens share these
 * so the rules live in exactly one place (and stay unit-testable).
 */

/** How many clips a profile showcases. */
export const FEATURED_CLIP_LIMIT = 3;

/**
 * Resolves the clips a profile should showcase.
 *
 * The player's explicit picks win, in the order they picked them. When they
 * haven't picked any (or none of their picks still exist — e.g. the replays
 * were deleted), the profile falls back to their most recent clips. `clips`
 * is expected newest-first, as the API returns it.
 */
export function resolveFeaturedClips<T extends { replayId: string }>(
  featuredIds: readonly string[],
  clips: readonly T[],
  limit: number = FEATURED_CLIP_LIMIT,
): T[] {
  const byId = new Map(clips.map((clip) => [clip.replayId, clip]));
  const picked: T[] = [];
  for (const id of featuredIds) {
    const clip = byId.get(id);
    if (clip && !picked.includes(clip)) {
      picked.push(clip);
    }
    if (picked.length === limit) {
      break;
    }
  }
  return picked.length > 0 ? picked : clips.slice(0, limit);
}

/** Community-post kinds a player can author from the console. */
export const COMPOSABLE_POST_KINDS = ["lfp", "dev_post"] as const;
export type ComposablePostKind = (typeof COMPOSABLE_POST_KINDS)[number];

export const POST_TITLE_MIN = 3;
export const POST_TITLE_MAX = 80;
export const POST_BODY_MIN = 10;
export const POST_BODY_MAX = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FeedPostInput {
  kind: ComposablePostKind;
  title: string;
  body: string;
  cartId: string | null;
}

export type FeedPostValidation =
  | { ok: true; value: FeedPostInput }
  | { ok: false; error: string };

/**
 * Validates and normalizes a community post. Returns the trimmed, typed input
 * or a human-readable error the composer can show inline.
 */
export function validateFeedPostInput(input: {
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  cartId?: unknown;
}): FeedPostValidation {
  const kind = input.kind;
  if (kind !== "lfp" && kind !== "dev_post") {
    return { ok: false, error: "Post type must be a player invite or a devlog." };
  }

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length < POST_TITLE_MIN || title.length > POST_TITLE_MAX) {
    return { ok: false, error: `Title must be ${POST_TITLE_MIN}–${POST_TITLE_MAX} characters.` };
  }

  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (body.length < POST_BODY_MIN || body.length > POST_BODY_MAX) {
    return { ok: false, error: `Say a little more — ${POST_BODY_MIN}–${POST_BODY_MAX} characters.` };
  }

  let cartId: string | null = null;
  if (input.cartId !== undefined && input.cartId !== null && input.cartId !== "") {
    if (typeof input.cartId !== "string" || !UUID_PATTERN.test(input.cartId)) {
      return { ok: false, error: "The linked cartridge id is not valid." };
    }
    cartId = input.cartId;
  }

  return { ok: true, value: { kind, title, body, cartId } };
}
