/**
 * Node ESM resolve hook for the unit tests. The app's TypeScript uses bundler
 * module resolution (extensionless relative imports like `./spriteBlock`), which
 * the bundler resolves but bare Node does not. This hook appends `.ts` to
 * extensionless relative specifiers so `node --experimental-transform-types` can
 * load the real modules under test without changing the production import style.
 */

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExtension = /\.[cm]?[jt]sx?$/.test(specifier);
  if (isRelative && !hasExtension) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Fall through to default resolution (e.g. it was really extensionless).
    }
  }
  return nextResolve(specifier, context);
}
