/**
 * Render worker entry point.
 *
 * Runs one batch by default (suitable for a cron/queue trigger). Pass --watch to
 * poll continuously with a fixed interval (suitable for a long-lived container).
 *
 *   ENGINE_URL=./engine/dist/tic80.js node dist/index.js
 *   ENGINE_URL=./engine/dist/tic80.js node dist/index.js --watch
 */

import { pathToFileURL } from "node:url";

import { DEFAULT_BATCH_SIZE, requiredEnv } from "./config.js";
import { processPendingThumbnails } from "./worker.js";
import { verifyPendingReplays, verifyPendingScores } from "./verify.js";

export {
  processPendingThumbnails,
  renderCartThumbnail,
  type BatchResult,
} from "./worker.js";
export { renderThumbnail } from "./renderThumbnail.js";
export {
  verifyPendingReplay,
  verifyPendingReplays,
  verifyPendingScore,
  verifyPendingScores,
} from "./verify.js";

/** Interval between polls in --watch mode. */
const WATCH_INTERVAL_MS = 15_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  requiredEnv("ENGINE_URL"); // validated up front; the per-model URL is resolved at render time
  const watch = process.argv.includes("--watch");
  const verifyMode = process.argv.includes("--verify");

  do {
    if (verifyMode) {
      const scores = await verifyPendingScores(DEFAULT_BATCH_SIZE);
      const replays = await verifyPendingReplays(DEFAULT_BATCH_SIZE);
      if (scores.verified || scores.rejected || scores.failed || replays.granted || replays.failed) {
        console.log(
          `Scores: ${scores.verified} verified, ${scores.rejected} rejected, ${scores.failed} failed. ` +
            `Replay unlocks: ${replays.granted} granted, ${replays.failed} failed.`,
        );
      }
    } else {
      const result = await processPendingThumbnails(DEFAULT_BATCH_SIZE);
      if (result.rendered > 0 || result.failed > 0) {
        console.log(`Rendered ${result.rendered}, failed ${result.failed}.`);
      }
    }
    if (watch) {
      await delay(WATCH_INTERVAL_MS);
    }
  } while (watch);
}

// Only run when executed directly, not when imported by tests.
// pathToFileURL handles paths with spaces/special chars (unlike `file://` + raw path).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
