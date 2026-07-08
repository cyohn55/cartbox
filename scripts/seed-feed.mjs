// Seeds the console home-feed with starter content: gaming news, looking-for-
// player invites, developer tips, trivia, and cartridge-developer posts — so
// the handheld homescreen shows the full mixed feed before the community
// produces this content organically.
//
// Idempotent: authors and posts use fixed ids/handles, so re-running updates
// rows instead of duplicating them. Run via:
//   node --env-file=.env scripts/seed-feed.mjs

import { createClient } from "@supabase/supabase-js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

// Fixed post ids keep the seed idempotent across re-runs.
const POST_ID_BASE = "00000000-0000-4000-9000-0000000001";
const postId = (index) => `${POST_ID_BASE}${String(index).padStart(2, "0")}`;

/** Community authors who "write" the seeded posts. */
const AUTHORS = [
  { email: "news@cartbox.dev", handle: "cartbox_news", displayName: "Cartbox News" },
  { email: "tips@cartbox.dev", handle: "cart_academy", displayName: "Cart Academy" },
  { email: "pixel@cartbox.dev", handle: "pixelsmith", displayName: "Pixelsmith" },
];

/** Resolves (creating if needed) an auth user + profile, returning its id. */
async function ensureAuthor({ email, handle, displayName }) {
  const { data: created, error } = await supabase.auth.admin.createUser({
    email,
    password: crypto.randomUUID(), // never logged in with; posts are read-only content
    email_confirm: true,
  });
  if (error && !/already/i.test(error.message)) throw error;

  let userId = created?.user?.id;
  if (!userId) {
    const { data: list } = await supabase.auth.admin.listUsers();
    userId = list.users.find((user) => user.email === email)?.id;
  }
  if (!userId) throw new Error(`could not resolve author ${handle}`);

  const { error: profileError } = await supabase
    .from("profiles")
    .upsert({ id: userId, handle, display_name: displayName });
  if (profileError) throw new Error(`seeding profile ${handle} failed: ${profileError.message}`);
  return userId;
}

async function main() {
  const authorIds = {};
  for (const author of AUTHORS) {
    authorIds[author.handle] = await ensureAuthor(author);
  }

  // Attach cart-linked posts (LFP, dev posts) to real published carts when the
  // local stack has any, so tapping through from the feed lands somewhere.
  const { data: carts } = await supabase
    .from("carts")
    .select("id, title")
    .eq("published", true)
    .order("created_at", { ascending: false })
    .limit(4);
  const cartAt = (index) => carts?.[index % (carts?.length || 1)]?.id ?? null;

  const posts = [
    {
      id: postId(1),
      kind: "news",
      author_id: authorIds.cartbox_news,
      title: "Pro model carts are here",
      body: "The Pro fantasy console is live: 640×360, 64 colors, 8 audio channels. Classic carts keep running unchanged — Pro is a second core, side by side.",
      meta: { link: "/browse" },
    },
    {
      id: postId(2),
      kind: "news",
      author_id: authorIds.cartbox_news,
      title: "Weekend jam: one button only",
      body: "This weekend's jam theme is ONE BUTTON. Design a whole game around a single input. Entries open Friday in the Jams tab.",
      meta: { link: "/jams" },
    },
    {
      id: postId(3),
      kind: "lfp",
      author_id: authorIds.pixelsmith,
      cart_id: cartAt(0),
      title: "Looking for players: co-op score run",
      body: "Trying to crack the top of the leaderboard tonight. Anyone up for trading replays and strategies? All skill levels welcome.",
      meta: { playersWanted: 3 },
    },
    {
      id: postId(4),
      kind: "dev_tip",
      author_id: authorIds.cart_academy,
      title: "Tip: design for the D-pad first",
      body: "Handheld players are on a D-pad and four face buttons. Map your core verb to A, secondary to B, and keep menus off the shoulder of the layout — thumbs never leave the pad.",
      meta: {},
    },
    {
      id: postId(5),
      kind: "trivia",
      author_id: authorIds.cart_academy,
      title: "Video game trivia",
      body: "The original Game Boy launched in 1989. How many shades of 'green' could its screen display?",
      meta: { choices: ["2", "4", "8", "16"], answerIndex: 1 },
    },
    {
      id: postId(6),
      kind: "dev_post",
      author_id: authorIds.pixelsmith,
      cart_id: cartAt(1),
      title: "Devlog: lighting my dungeon crawler",
      body: "Switched the torch flicker from random jitter to a slow sine + noise blend and the whole dungeon started breathing. cartbox.light() with radius pulses — try it.",
      meta: {},
    },
    {
      id: postId(7),
      kind: "dev_tip",
      author_id: authorIds.cart_academy,
      title: "Tip: juice your score pops",
      body: "When the score changes, don't just redraw the number — flash it white for 4 frames and nudge it 2px up. Cheap, and players feel every point.",
      meta: {},
    },
    {
      id: postId(8),
      kind: "trivia",
      author_id: authorIds.cart_academy,
      title: "Video game trivia",
      body: "Which handheld was the first with a backlit color screen out of the box?",
      meta: { choices: ["Game Boy Color", "Game Gear", "Atari Lynx", "WonderSwan"], answerIndex: 2 },
    },
    {
      id: postId(9),
      kind: "news",
      author_id: authorIds.cartbox_news,
      title: "Creator payouts now live",
      body: "Sell your carts and keep the revenue — Stripe payouts are enabled for creator accounts. Set a price from the editor's publish panel.",
      meta: { link: "/edit/new" },
    },
    {
      id: postId(10),
      kind: "lfp",
      author_id: authorIds.pixelsmith,
      cart_id: cartAt(2),
      title: "Race me: speedrun challenge",
      body: "Posted my best run as a replay. Beat my time, post yours, and tag me. Loser makes the winner a victory cart.",
      meta: { playersWanted: 1 },
    },
  ];

  const { error } = await supabase.from("feed_posts").upsert(posts);
  if (error) throw new Error(`seeding feed_posts failed: ${error.message}`);

  console.log(`Seeded ${posts.length} feed posts from ${AUTHORS.length} authors.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
