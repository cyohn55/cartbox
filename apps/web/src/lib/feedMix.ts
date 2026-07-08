/**
 * Console home-feed model: the item types every card renders from, and the
 * pure interleaving that turns per-source lists (playable carts, replay clips,
 * achievement unlocks, authored posts) into one mixed, TikTok-style feed.
 *
 * Kept free of server and DOM imports so the API route, the static demo feed,
 * and the unit tests can all share it.
 */

/** Every card variety the home feed can render. */
export type FeedItemKind =
  | "cart" // a cartridge playable directly in the feed
  | "clip" // a recorded replay of someone's run
  | "achievement" // a player unlocked an achievement
  | "news" // gaming / platform news
  | "lfp" // looking-for-player invite
  | "dev_tip" // game-development tip
  | "trivia" // video-game trivia question
  | "dev_post"; // post from a cartridge developer

/** Cart context a card needs to render (and, when free, play) a cartridge. */
export interface FeedCartInfo {
  id: string;
  title: string;
  modelId: string;
  priceCents: number;
  plays: number;
  thumbUrl: string | null;
  /** Present only when the cart is playable right in the feed (free carts). */
  cartUrl: string | null;
  engineUrl: string | null;
}

/** Replay-clip context: the serialized input stream that re-drives the cart. */
export interface FeedClipInfo {
  replayId: string;
  replayUrl: string;
  frameCount: number;
}

/** Trivia payload: multiple choice with one right answer. */
export interface FeedTriviaInfo {
  choices: string[];
  answerIndex: number;
}

/** One card in the home feed. Kind-specific payloads are optional groups. */
export interface FeedItem {
  /** Unique across the whole feed, e.g. "cart:<uuid>" or "post:<uuid>". */
  id: string;
  kind: FeedItemKind;
  title: string;
  body: string;
  authorHandle: string | null;
  authorName: string | null;
  createdAt: string;
  cart?: FeedCartInfo;
  clip?: FeedClipInfo;
  trivia?: FeedTriviaInfo;
  /** In-app destination for "read more" style cards (news). */
  link?: string;
}

/**
 * Mixes per-source groups into one feed.
 *
 * Greedy proportional round-robin: at each step the group with the largest
 * remaining fraction of its items goes next, preferring any group whose next
 * item differs in kind from the one just emitted (so two carts or two trivia
 * cards never sit adjacent unless nothing else is left). Deterministic, keeps
 * each group's internal order, and always emits every item exactly once.
 */
export function interleaveFeed<T extends { kind: string }>(
  groups: ReadonlyArray<ReadonlyArray<T>>,
): T[] {
  const cursors = groups.map(() => 0);
  const totalItems = groups.reduce((sum, group) => sum + group.length, 0);
  const mixed: T[] = [];
  let lastKind: string | null = null;

  while (mixed.length < totalItems) {
    let bestDifferent: T | null = null;
    let bestDifferentIndex = -1;
    let bestDifferentScore = -1;
    let bestAny: T | null = null;
    let bestAnyIndex = -1;
    let bestAnyScore = -1;

    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index] ?? [];
      const cursor = cursors[index] ?? 0;
      const next = group[cursor];
      if (next === undefined) {
        continue; // group exhausted
      }
      const score = (group.length - cursor) / group.length;
      if (score > bestAnyScore) {
        bestAnyScore = score;
        bestAnyIndex = index;
        bestAny = next;
      }
      if (next.kind !== lastKind && score > bestDifferentScore) {
        bestDifferentScore = score;
        bestDifferentIndex = index;
        bestDifferent = next;
      }
    }

    const item = bestDifferent ?? bestAny;
    const pickIndex = bestDifferent !== null ? bestDifferentIndex : bestAnyIndex;
    if (item === null) {
      break; // defensive: totalItems said more remained, but every group is dry
    }
    cursors[pickIndex] = (cursors[pickIndex] ?? 0) + 1;
    mixed.push(item);
    lastKind = item.kind;
  }

  return mixed;
}
