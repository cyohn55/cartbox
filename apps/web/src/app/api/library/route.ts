/**
 * /api/library — list and search the first-party asset library (GET).
 *
 * The catalogue is served from a static manifest so the endpoint is a pure read:
 * load the manifest, validate it (it is authored out-of-band, so a bad edit
 * surfaces here as a 500 with a precise message rather than a malformed listing),
 * apply the request's search/filter/page, and return the slice. Swapping the
 * file read for an R2 fetch later changes only `loadManifest` — the query seam in
 * `libraryRoute.ts` is unaffected.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { parseLibraryManifest, type LibraryManifest } from "@/lib/libraryManifest";
import { buildLibraryResponse, parseLibraryRequest } from "@/lib/libraryRoute";

// The manifest is read at request time (not import-time) so re-authoring it does
// not require a rebuild. In dev this is the file under `public/`; the same path
// resolves in a standalone build because `public/` ships alongside the server.
const MANIFEST_PATH = path.join(process.cwd(), "public", "library", "manifest.json");

async function loadManifest(): Promise<LibraryManifest> {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  return parseLibraryManifest(JSON.parse(raw));
}

export async function GET(request: Request): Promise<NextResponse> {
  let manifest: LibraryManifest;
  try {
    manifest = await loadManifest();
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to load asset library";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const params = new URL(request.url).searchParams;
  const body = buildLibraryResponse(manifest, parseLibraryRequest(params));
  return NextResponse.json(body);
}
