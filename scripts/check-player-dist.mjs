/**
 * Fails when `packages/player/dist` is out of date with its source.
 *
 * The web app resolves `@cartbox/player` through the package's `types`/`main`,
 * which point at `dist` — and `dist` is committed. That means `apps/web` type-
 * checks against a *snapshot* of the player, not the player. When the snapshot
 * goes stale the failure is silent and confusing: the web app compiles cleanly
 * against types that no longer describe the code that will run.
 *
 * That is not hypothetical. `RenderCaps` was added to `ConsoleModel` and nothing
 * in the web app could see it, because the committed `dist` predated it by
 * several features.
 *
 * The real fix is for the web app to compile against source, which is a build
 * change with its own risks (types from source, runtime from dist, is worse
 * than either). Until then this makes the staleness loud: rebuild, and fail if
 * the rebuild changed anything that was committed.
 */

import { execFileSync } from "node:child_process";

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

run("npm", ["run", "build", "--workspace", "packages/player"]);

const changed = run("git", ["status", "--porcelain", "--", "packages/player/dist"]).trim();

if (changed) {
  console.error(
    [
      "",
      "packages/player/dist is out of date with packages/player/src.",
      "",
      changed,
      "",
      "The committed dist is what `apps/web` type-checks against, so a stale one",
      "hides changes to the player from the web app entirely.",
      "",
      "Fix: npm run build:player, then commit the result.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("packages/player/dist is up to date.");
