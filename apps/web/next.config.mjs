// Static "demo" build for GitHub Pages and other static hosts. Set by
// scripts/build-static.mjs; see src/lib/staticSite.ts for what the mode means.
const isStaticExport = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @cartbox/player and @cartbox/payments are consumed as pre-built dist (ESM +
  // types) via their package exports, so no transpilePackages is needed.
  // @cartbox/editor is consumed as TypeScript source for fast iteration, so Next
  // transpiles it here.
  transpilePackages: ["@cartbox/editor"],
  // No ESLint config is wired up yet; TypeScript still fails the build on type errors.
  eslint: { ignoreDuringBuilds: true },
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
