/**
 * Authoring-side rules for the cart asset store.
 *
 * `cartAssetStore.ts` decides what the *server* will accept. This decides what
 * the editor should offer before asking it — the naming a file picker cannot do
 * for itself, and the budget arithmetic the panel displays.
 *
 * Kept pure and DOM-free for the same reason `editorTabs.ts` is: the interesting
 * rules here are about names and numbers, and they should be testable without
 * mounting an editor or standing up a fetch.
 */

import {
  ALLOWED_ASSET_TYPES,
  cartAssetBytes,
  isValidAssetName,
  type CartAssets,
} from "@/lib/cartAssetStore";

/**
 * A size a person can read, in the units the thing is actually measured in.
 *
 * Binary units throughout, because every limit this is shown against is binary:
 * the 16MB per-asset cap and the PS1 model's 660MB disc are both built from
 * powers of two, so rendering them in decimal megabytes would label a budget
 * the spec calls 660MB as "692 MB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below ten, none above: "1.4 MB" is useful, "847.3 MB" is noise.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Control characters and DEL, which must never reach a URL or a log line. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Turn a file the creator picked into a name the manifest can hold.
 *
 * A filename is not a manifest key. It arrives from the operating system and
 * may carry path segments, control characters, or the `..` that
 * `isValidAssetName` refuses — so this is the one place that maps the former
 * onto the latter, rather than letting the picker hand the server something it
 * will reject and calling that the creator's problem.
 *
 * The transformation is deliberately visible rather than clever: the resulting
 * name shows in the panel, and can be retyped before anything is uploaded.
 */
export function assetNameFromFile(fileName: string): string {
  // Basename only. A `<input type="file">` gives one, but a drag-and-drop from
  // some platforms does not, and neither does a caller in a test.
  const base = fileName.split(/[/\\]/).pop() ?? "";

  const cleaned = base
    .replace(CONTROL_CHARS, "")
    // Runs of dots collapse to one. `..` is traversal-shaped and refused
    // outright, so "shot..2.png" has to become "shot.2.png" rather than fail.
    .replace(/\.{2,}/g, ".")
    .trim();

  if (cleaned === "" || cleaned === ".") return "asset";
  if (cleaned.length <= 255) return cleaned;

  // 255 is the manifest's limit. Truncating the stem rather than the whole
  // string keeps the extension, which is what the content type is read from.
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 ? cleaned.slice(dot) : "";
  return extension.length > 0 && extension.length < 255
    ? cleaned.slice(0, 255 - extension.length) + extension
    : cleaned.slice(0, 255);
}

/**
 * A name not already spoken for, by adding a numeric suffix before the
 * extension.
 *
 * Uploading over an existing name would silently repoint it at different bytes,
 * which for a published cart means its texture changing underneath its players.
 * The asset store makes assets immutable precisely to prevent that, so the
 * editor must not reintroduce it at the naming step: a second `hero.png`
 * becomes `hero-2.png`, and both stay reachable.
 */
export function uniqueAssetName(desired: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(desired)) return desired;

  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const extension = dot > 0 ? desired.slice(dot) : "";

  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem}-${n}${extension}`;
    if (!used.has(candidate) && isValidAssetName(candidate)) return candidate;
  }
  // Unreachable for any plausible manifest. Falling back to the original keeps
  // this total rather than throwing inside a file picker's change handler.
  return desired;
}

/**
 * Content types by extension, for the files a browser declines to type.
 *
 * `File.type` is a guess the platform makes from the extension and is routinely
 * empty for exactly the formats a 3D cart needs — `.glb` most of all. The server
 * allowlists whatever arrives, so an untyped upload is refused as an unsupported
 * type, which reads to the creator as "this editor does not take models" when
 * the truth is that their OS had no opinion about the extension.
 *
 * This is metadata, not a trust boundary: the allowlist still decides, and the
 * bytes are still hashed server-side.
 */
const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

/**
 * The content type to upload a file under.
 *
 * Prefers what the browser said when that is something the store accepts, and
 * otherwise falls back to the extension. When neither yields an allowed type the
 * browser's own value is passed through unchanged, so the rejection the creator
 * sees names what they actually picked rather than a type this function invented.
 */
export function contentTypeForUpload(fileName: string, browserType: string): string {
  if (ALLOWED_ASSET_TYPES.includes(browserType)) return browserType;

  const dot = fileName.lastIndexOf(".");
  const extension = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  const inferred = TYPE_BY_EXTENSION[extension];
  if (inferred) return inferred;

  return browserType || "application/octet-stream";
}

/** What a cart has spent of its model's asset allowance. */
export interface BudgetUsage {
  readonly usedBytes: number;
  readonly budgetBytes: number;
  /** Never negative: a cart over budget reads as full, not as owed bytes. */
  readonly freeBytes: number;
  /** 0..1, for a meter. A zero budget is a full meter rather than a NaN one. */
  readonly fraction: number;
}

export function budgetUsage(assets: CartAssets, budgetBytes: number): BudgetUsage {
  const usedBytes = cartAssetBytes(assets);
  return {
    usedBytes,
    budgetBytes,
    freeBytes: Math.max(0, budgetBytes - usedBytes),
    fraction: budgetBytes <= 0 ? 1 : Math.min(1, usedBytes / budgetBytes),
  };
}
