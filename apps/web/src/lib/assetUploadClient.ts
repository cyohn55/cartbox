/**
 * Sending one asset to a cart's store from the browser (AAA_FIDELITY_ROADMAP.md
 * F9e): through the API as multipart when it is small, or straight to storage
 * on a presigned PUT when it is past the serverless body limit (see
 * `/api/carts/[cartId]/assets/direct`). Either way the server re-checks the
 * name, type, hash and budget, and bytes already in the store cost nothing.
 */

import { uploadRoute } from "./cartAssetStore";

export interface UploadResult {
  readonly ok: boolean;
  /** The asset's public URL, when stored. */
  readonly url?: string;
  /** True when the store already held these bytes (nothing was sent). */
  readonly deduplicated?: boolean;
  readonly error?: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Upload `bytes` as `name` (its hash and type already worked out) to a cart. */
export async function uploadCartAsset(
  cartId: string,
  name: string,
  bytes: Uint8Array,
  hash: string,
  contentType: string,
  headersInit: HeadersInit,
  fetchImpl: Fetch = fetch,
): Promise<UploadResult> {
  const headers = Object.fromEntries(new Headers(headersInit).entries());
  const fail = async (response: Response): Promise<UploadResult> => {
    let message = `Server said ${response.status}.`;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // Not JSON: the status will do.
    }
    return { ok: false, error: message };
  };
  if (uploadRoute(bytes.length) === "multipart") {
    const form = new FormData();
    form.set("name", name);
    form.set("hash", hash);
    form.set("file", new File([bytes as BlobPart], name, { type: contentType }));
    const response = await fetchImpl(`/api/carts/${cartId}/assets`, { method: "POST", headers, body: form });
    if (!response.ok) return fail(response);
    const body = (await response.json()) as { url?: string; deduplicated?: boolean };
    return { ok: true, ...(body.url ? { url: body.url } : {}), deduplicated: body.deduplicated === true };
  }
  const describe = { name, hash, bytes: bytes.length, contentType };
  const json = { ...headers, "Content-Type": "application/json" };
  const begin = await fetchImpl(`/api/carts/${cartId}/assets/direct`, { method: "POST", headers: json, body: JSON.stringify({ phase: "begin", ...describe }) });
  if (!begin.ok) return fail(begin);
  const planned = (await begin.json()) as { deduplicated?: boolean; url?: string; upload?: { url: string; headers: Record<string, string> } };
  if (planned.deduplicated) return { ok: true, ...(planned.url ? { url: planned.url } : {}), deduplicated: true };
  if (!planned.upload) return { ok: false, error: "The server gave no upload address." };
  const put = await fetchImpl(planned.upload.url, { method: "PUT", headers: planned.upload.headers, body: bytes as BlobPart });
  if (!put.ok) return { ok: false, error: `Storage refused the upload (${put.status}).` };
  const commit = await fetchImpl(`/api/carts/${cartId}/assets/direct`, { method: "POST", headers: json, body: JSON.stringify({ phase: "commit", ...describe }) });
  if (!commit.ok) return fail(commit);
  const done = (await commit.json()) as { url?: string };
  return { ok: true, ...(done.url ? { url: done.url } : {}), deduplicated: false };
}
