// Static "demo" build for GitHub Pages and other static hosts. Set by
// scripts/build-static.mjs; see src/lib/staticSite.ts for what the mode means.
const isStaticExport = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Off-origin CDN base for the large emulated-game bundles (Cloudflare R2). The
// bundle directories are served from R2 instead of shipping in the deploy — the
// fix for hitting GitHub Pages' size limits (scripts/fetch-* / build-* produce
// these; scripts/publish-bundles-r2.mjs uploads them). Crucially the browser
// still requests same-origin paths (/cube2/…, /quake/…) and Next rewrites them
// to R2, so the iframe runtimes' same-origin input bridges keep working.
//
// The default is the project's own public R2 bucket. It lives here rather than
// in each host's environment because it is a public URL, not a credential, and
// it is a property of the project rather than of a deployment: leaving it to be
// configured per host is what makes a fresh deploy 404 every game until someone
// remembers the variable. GAME_CDN_URL still overrides it — set it to point a
// deployment at a different bucket, or to "" to serve bundles from public/.
const DEFAULT_GAME_CDN_URL = "https://pub-b6ce848723704dc5a863b41aa15c804c.r2.dev";
const gameCdnUrl = (process.env.GAME_CDN_URL ?? DEFAULT_GAME_CDN_URL).replace(/\/$/, "");

/** The bundle roots served from public/ today, reroutable to the CDN. */
const GAME_BUNDLE_ROOTS = ["quake", "cube2", "scummvm", "supertux", "dosbox", "games"];

/**
 * Roots whose engine streams with Range requests, and so must not be cached.
 *
 * Mirrors RANGE_STREAMED_ROOTS in scripts/publish-bundles-r2.mjs, which is where
 * the fix that matters lives (the origin's Cache-Control). Next requires config
 * to stand alone, so the list cannot be imported from a script; the test asserts
 * the two still agree.
 */
const RANGE_STREAMED_ROOTS = ["quake"];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @cartbox/player and @cartbox/payments are consumed as pre-built dist (ESM +
  // types) via their package exports, so no transpilePackages is needed.
  // @cartbox/editor is consumed as TypeScript source for fast iteration, so Next
  // transpiles it here.
  transpilePackages: ["@cartbox/editor"],
  // No ESLint config is wired up yet; TypeScript still fails the build on type errors.
  eslint: { ignoreDuringBuilds: true },
  // Serve the large game bundles from R2 when GAME_CDN_URL is configured. Static
  // export can't do rewrites (and Pages serves public/ directly), so this only
  // applies to the server build (Vercel). afterFiles: a locally-present bundle
  // still wins in dev; on Vercel the bundles aren't built, so the rewrite routes
  // them to R2.
  ...(!isStaticExport && gameCdnUrl
    ? {
        async rewrites() {
          return {
            afterFiles: GAME_BUNDLE_ROOTS.map((root) => ({
              source: `/${root}/:path*`,
              destination: `${gameCdnUrl}/${root}/:path*`,
            })),
          };
        },

        // Keep the *browser* from holding a partial of a range-streamed bundle.
        //
        // Scoped to RANGE_STREAMED_ROOTS, and it must stay that way: applied to
        // every root it tells the browser not to cache any bundle at all, so a
        // player re-downloads C&C's 13MB zip — or SuperTux's 162MB data file —
        // from scratch on every single launch. That reads as a game hanging on
        // its loading screen, which is exactly what it caused.
        //
        // This rule is *not* what fixes the edge. Vercel's CDN keys its cache on
        // the URL, ignores the `Range` request header, and stores what the
        // origin sent — so preventing the poisoned entry is the origin's job
        // (`cacheControlForKey` in scripts/publish-bundles-r2.mjs). Reading a
        // `headers()` rule as though it governed the edge is how that fix first
        // went out half-working.
        //
        // "Unit Tests/game-cdn-rewrites.test.ts" asserts this list still matches
        // the publisher's.
        async headers() {
          return RANGE_STREAMED_ROOTS.map((root) => ({
            source: `/${root}/:path*`,
            headers: [{ key: "Cache-Control", value: "no-store" }],
          }));
        },
      }
    : {}),
  ...(isStaticExport
    ? {
        output: "export",
        // GitHub Pages project sites live under /<repo>.
        ...(basePath ? { basePath } : {}),
        // Every route becomes <route>/index.html, which static hosts serve
        // without needing rewrite rules.
        trailingSlash: true,
        // next/image optimization needs a server; exports must opt out.
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
