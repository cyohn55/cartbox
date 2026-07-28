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
  /** A recent replay of this cart, looped as the card's gameplay preview. */
  preview?: FeedClipInfo | null;
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
 * Outcome of assembling a feed from independently-fetched sources.
 *
 * A feed with no items is a real, renderable state (nobody has published yet),
 * which is exactly why a backend outage must not be allowed to produce one: the
 * two look identical on screen but mean opposite things. `ok: false` keeps them
 * distinguishable all the way to the console.
 */
export type FeedAssembly =
  | { ok: true; items: FeedItem[]; degraded: boolean }
  | { ok: false; reason: string };

/**
 * Assembles the feed from per-source results, tolerating partial failure.
 *
 * One flaky source should not blank the homescreen, so surviving sources are
 * mixed and the result is flagged `degraded`. Every source failing means the
 * backend is unreachable, and that is reported as a failure rather than as an
 * empty platform.
 *
 * Authored posts are split by kind before interleaving so the mix alternates
 * card varieties instead of treating "posts" as one clump.
 */
export function assembleFeed(sources: ReadonlyArray<PromiseSettledResult<FeedItem[]>>): FeedAssembly {
  if (sources.length === 0) {
    return { ok: true, items: [], degraded: false };
  }

  const failures = sources.filter(
    (source): source is PromiseRejectedResult => source.status === "rejected",
  );
  if (failures.length === sources.length) {
    const reason = failures[0]?.reason;
    return { ok: false, reason: reason instanceof Error ? reason.message : String(reason) };
  }

  const groups: FeedItem[][] = [];
  const postsByKind = new Map<FeedItemKind, FeedItem[]>();
  for (const source of sources) {
    if (source.status !== "fulfilled") {
      continue;
    }
    // Cards that carry their own payload stay grouped by source; authored posts
    // are one source but many kinds, so they fan out into a group per kind.
    for (const item of source.value) {
      if (item.kind === "cart" || item.kind === "clip" || item.kind === "achievement") {
        continue;
      }
      const group = postsByKind.get(item.kind) ?? [];
      group.push(item);
      postsByKind.set(item.kind, group);
    }
    const carried = source.value.filter(
      (item) => item.kind === "cart" || item.kind === "clip" || item.kind === "achievement",
    );
    if (carried.length > 0) {
      groups.push(carried);
    }
  }

  return {
    ok: true,
    items: interleaveFeed([...groups, ...postsByKind.values()]),
    degraded: failures.length > 0,
  };
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
