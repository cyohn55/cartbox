// Static "demo" build for GitHub Pages and other static hosts. Set by
// scripts/build-static.mjs; see src/lib/staticSite.ts for what the mode means.
const isStaticExport = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Off-origin CDN base for the large emulated-game bundles (Cloudflare R2). When
// set, the game bundle directories are served from R2 instead of shipping in the
// deploy — the fix for hitting GitHub Pages' size limits (scripts/fetch-* / build-*
// produce these; scripts/publish-bundles-r2.mjs uploads them). Crucially the
// browser still requests same-origin paths (/cube2/…, /quake/…) and Next rewrites
// them to R2, so the iframe runtimes' same-origin input bridges keep working.
const gameCdnUrl = (process.env.GAME_CDN_URL ?? "").replace(/\/$/, "");

/** The bundle roots served from public/ today, reroutable to the CDN. */
const GAME_BUNDLE_ROOTS = ["quake", "cube2", "scummvm", "supertux", "dosbox", "games"];

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
