import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Test config for the Cartbox monorepo.
 *
 * - Aliases the `@cartbox/player` package specifier to the player source so
 *   server-side modules (the render worker) that import the player by name
 *   resolve without a build step.
 * - Collects the suite from the top-level "Unit Tests" folder.
 */
const playerSource = fileURLToPath(
  new URL("./packages/player/src/index.ts", import.meta.url),
);
const editorSource = fileURLToPath(
  new URL("./packages/editor/src/index.ts", import.meta.url),
);
// The web app's own "@/..." alias. Without it, any app module that imports a
// sibling that way is untestable — the test resolves the app file fine and then
// dies on its imports.
const webSource = fileURLToPath(new URL("./apps/web/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@cartbox/player": playerSource,
      "@cartbox/editor": editorSource,
      "@": webSource,
    },
  },
  test: {
    include: [fileURLToPath(new URL("../../Unit Tests/**/*.test.ts", import.meta.url))],
  },
});
