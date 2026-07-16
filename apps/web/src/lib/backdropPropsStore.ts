/**
 * Loading and local persistence for the editable backdrop prop set.
 *
 * The global source of truth is the committed `public/backdrop/props.json` every
 * visitor loads. The manager and the editor edit a *working copy* in
 * localStorage; while one exists it overrides the published set on this browser,
 * so you can tune and preview the scene live before publishing. Publishing
 * globally (Global-by-deploy) means exporting the working set to props.json and
 * committing it — see `exportPropSet` and the seed script.
 */

import {
  DEFAULT_BACKDROP_PROP_SET,
  deserializePropSet,
  normalizePropSet,
  serializePropSet,
  type BackdropPropSet,
} from "./backdropProps";
import { withBasePath } from "./staticSite";

const WORKING_KEY = "cartbox.backdrop.working";

/** URL of the committed global prop set (basePath-aware for GitHub Pages). */
export function publishedSetUrl(): string {
  return withBasePath("/backdrop/props.json");
}

/**
 * Fetch the committed global set, falling back to the built-in defaults if it is
 * missing or malformed — the backdrop must never fail to render.
 */
export async function loadPublishedSet(): Promise<BackdropPropSet> {
  try {
    const response = await fetch(publishedSetUrl(), { cache: "no-store" });
    if (!response.ok) return DEFAULT_BACKDROP_PROP_SET;
    const set = normalizePropSet(await response.json());
    return set ?? DEFAULT_BACKDROP_PROP_SET;
  } catch {
    return DEFAULT_BACKDROP_PROP_SET;
  }
}

/** The local working copy, or null if none has been saved on this browser. */
export function loadWorkingSet(): BackdropPropSet | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(WORKING_KEY);
  if (!raw) return null;
  return deserializePropSet(raw);
}

/** Save the working copy (used by the manager + editor publish). */
export function saveWorkingSet(set: BackdropPropSet): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WORKING_KEY, serializePropSet(set));
}

/** Drop the working copy, so this browser falls back to the published set. */
export function clearWorkingSet(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(WORKING_KEY);
}

/** True when a local working copy exists (i.e. an unpublished preview is active). */
export function hasWorkingSet(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(WORKING_KEY) !== null;
}

/**
 * The set the backdrop should render: the local working copy when present
 * (owner preview), otherwise the published global set.
 */
export async function loadActiveSet(): Promise<BackdropPropSet> {
  return loadWorkingSet() ?? (await loadPublishedSet());
}

/** JSON for download / committing to props.json. */
export function exportPropSet(set: BackdropPropSet): string {
  return `${serializePropSet(set)}\n`;
}

/** Parse + validate an uploaded/pasted JSON string into a set, or null. */
export function importPropSetJson(json: string): BackdropPropSet | null {
  return deserializePropSet(json);
}

const PENDING_EDIT_KEY = "cartbox.backdrop.pendingEdit";

/** A prop the manager handed to the editor to pixel-edit and re-publish. */
export interface PendingPropEdit {
  /** Existing prop id to overwrite on publish, or null to add a new prop. */
  readonly targetId: string | null;
  readonly name: string;
  /** Decoded pixels the editor seeds its sprite with. */
  readonly width: number;
  readonly height: number;
  /** base64 RGBA (matches PropArt.albedo). */
  readonly albedo: string;
}

/** Stash a prop for the editor to open (manager → "Edit pixels"). */
export function savePendingPropEdit(edit: PendingPropEdit): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PENDING_EDIT_KEY, JSON.stringify(edit));
}

/** Read the pending edit the editor should open, if any. */
export function loadPendingPropEdit(): PendingPropEdit | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(PENDING_EDIT_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingPropEdit;
    if (typeof value.albedo !== "string" || !Number.isFinite(value.width) || !Number.isFinite(value.height)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** Clear the pending edit (after the editor consumes or publishes it). */
export function clearPendingPropEdit(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(PENDING_EDIT_KEY);
}
