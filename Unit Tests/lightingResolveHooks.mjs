/**
 * Resolve hook for the lighting tests. The player's source uses NodeNext-style
 * relative imports with a `.js` extension (e.g. `./lightingModel.js`) that only
 * exist as `.ts` on disk. This maps those `.js` specifiers to `.ts` (and also
 * handles extensionless ones) so `node --experimental-transform-types` can load
 * the real modules under test without changing the production import style.
 */

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  if (isRelative) {
    if (/\.js$/.test(specifier)) {
      try {
        return await nextResolve(specifier.replace(/\.js$/, ".ts"), context);
      } catch {
        /* fall through */
      }
    } else if (!/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return await nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through */
      }
    }
  }
  return nextResolve(specifier, context);
}
