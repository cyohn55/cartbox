/**
 * Worker loop: render thumbnails for carts that don't have one yet.
 *
 * The pipeline per cart is: download the .tic from R2, load it into a headless
 * console, render a PNG, upload it, and record the key. One failed cart is
 * logged and skipped so it never blocks the rest of the batch.
 */

import { getModel } from "@cartbox/player";

import { findPendingThumbnails, setThumbnail, type PendingCart } from "./db.js";
import { getObject, putObject } from "./storage.js";
import { loadEngine, openConsole } from "./engine.js";
import { renderThumbnail } from "./renderThumbnail.js";
import { resolveEngineUrl } from "./config.js";

/** Outcome of one worker pass. */
export interface BatchResult {
  rendered: number;
  failed: number;
}

/** Object key a cart's thumbnail is stored under. */
function thumbnailKey(cartId: string): string {
  return `thumbs/${cartId}.png`;
}

/**
 * Renders and stores a thumbnail for a single cart.
 * Separated out so it can be retried or invoked directly (e.g. a re-render endpoint).
 */
export async function renderCartThumbnail(cart: PendingCart): Promise<void> {
  const model = getModel(cart.console_model);
  const engineModule = await loadEngine(resolveEngineUrl(model.id));
  const cartBytes = await getObject(cart.r2_key);
  const console = openConsole(engineModule, model, cartBytes);
  try {
    const png = renderThumbnail(console, model);
    const key = thumbnailKey(cart.id);
    await putObject(key, png, "image/png");
    await setThumbnail(cart.id, key);
  } finally {
    console.dispose(); // always release WASM memory, even on encode/upload failure
  }
}

/**
 * Processes one batch of pending thumbnails. Each cart's model is resolved from
 * its `console_model`, and the matching engine build is loaded (and cached) per
 * model.
 *
 * @param batchSize Maximum carts to process this pass.
 * @returns Counts of rendered and failed carts.
 */
export async function processPendingThumbnails(batchSize: number): Promise<BatchResult> {
  const pending = await findPendingThumbnails(batchSize);

  let rendered = 0;
  let failed = 0;
  for (const cart of pending) {
    try {
      await renderCartThumbnail(cart);
      rendered++;
    } catch (error) {
      failed++;
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Thumbnail render failed for cart ${cart.id}: ${reason}`);
    }
  }
  return { rendered, failed };
}
