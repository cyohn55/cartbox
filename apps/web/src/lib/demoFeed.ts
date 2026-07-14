/**
 * Baked-in home feed for the static "demo" build (src/lib/staticSite.ts).
 *
 * The server build assembles the feed live in /api/feed; the static build has
 * no server, so the console homescreen mixes the baked-in demo carts with a
 * small authored set of news / tips / trivia / LFP cards here instead. Uses
 * the same FeedItem model and interleave as the live path, so the cards and
 * their ordering rules match exactly.
 */

import { DEMO_CARTS, demoCartUrl, demoThumbUrl } from "./demoCatalog";
import { ENGINE_URL_BY_MODEL } from "./consoleModel";
import { interleaveFeed, type FeedItem } from "./feedMix";

const DEMO_POSTS: readonly FeedItem[] = [
  {
    id: "demo-post:news-1",
    kind: "news",
    title: "Welcome to Cartbox",
    body: "Make and play tiny games right in your browser. This is the static demo build — accounts and the community feed go live on the full site.",
    authorHandle: "cartbox_news",
    authorName: "Cartbox News",
    createdAt: "",
    link: "/browse",
  },
  {
    id: "demo-post:tip-1",
    kind: "dev_tip",
    title: "Tip: design for the D-pad first",
    body: "Handheld players are on a D-pad and four face buttons. Map your core verb to A, secondary to B — thumbs never leave the pad.",
    authorHandle: "cart_academy",
    authorName: "Cart Academy",
    createdAt: "",
  },
  {
    id: "demo-post:trivia-1",
    kind: "trivia",
    title: "Video game trivia",
    body: "The original Game Boy launched in 1989. How many shades of 'green' could its screen display?",
    authorHandle: "cart_academy",
    authorName: "Cart Academy",
    createdAt: "",
    trivia: { choices: ["2", "4", "8", "16"], answerIndex: 1 },
  },
  {
    id: "demo-post:lfp-1",
    kind: "lfp",
    title: "Looking for players: score run",
    body: "Trying to crack the top of the leaderboard tonight. All skill levels welcome.",
    authorHandle: "pixelsmith",
    authorName: "Pixelsmith",
    createdAt: "",
  },
  {
    id: "demo-post:trivia-2",
    kind: "trivia",
    title: "Video game trivia",
    body: "Which handheld was the first with a backlit color screen out of the box?",
    authorHandle: "cart_academy",
    authorName: "Cart Academy",
    createdAt: "",
    trivia: { choices: ["Game Boy Color", "Game Gear", "Atari Lynx", "WonderSwan"], answerIndex: 2 },
  },
  {
    id: "demo-post:tip-2",
    kind: "dev_tip",
    title: "Tip: juice your score pops",
    body: "When the score changes, flash it white for 4 frames and nudge it 2px up. Cheap, and players feel every point.",
    authorHandle: "cart_academy",
    authorName: "Cart Academy",
    createdAt: "",
  },
];

/** Builds the demo build's mixed feed from the baked catalog + authored posts. */
export function buildDemoFeed(): FeedItem[] {
  const cartItems: FeedItem[] = DEMO_CARTS.map((cart) => ({
    id: `cart:${cart.id}`,
    kind: "cart",
    title: cart.title,
    body: cart.description,
    authorHandle: "demo",
    authorName: "Demo",
    createdAt: "",
    cart: {
      id: cart.id,
      title: cart.title,
      modelId: cart.consoleModel,
      priceCents: cart.priceCents,
      plays: cart.plays,
      thumbUrl: demoThumbUrl(cart.id),
      cartUrl: demoCartUrl(cart.id),
      engineUrl: ENGINE_URL_BY_MODEL[cart.consoleModel],
    },
  }));

  const postsByKind = new Map<string, FeedItem[]>();
  for (const post of DEMO_POSTS) {
    const group = postsByKind.get(post.kind) ?? [];
    group.push(post);
    postsByKind.set(post.kind, group);
  }

  return interleaveFeed([cartItems, ...postsByKind.values()]);
}
