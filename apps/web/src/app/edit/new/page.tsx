/**
 * /edit/new — entry point for authoring a new cartridge. Mints a fresh cart id
 * and redirects into the editor, so every new cart gets its own stable URL
 * (the editor and its later save/thumbnail steps key off that id). The target
 * cart has no stored bytes yet, so /edit/[cartId] opens it on the demo seed.
 *
 * This static segment takes routing precedence over the sibling dynamic
 * [cartId] route, so "new" is never treated as a cart id.
 */

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";

import { resolveModelId } from "@/lib/consoleModel";
import { resolveStarterId, DEFAULT_STARTER_ID } from "@/lib/starter";
import { isStaticExport } from "@/lib/staticSite";
import { StaticNewCartRedirect } from "./StaticNewCartRedirect";

// The static demo build replaces the per-request random-id redirect with a
// client-side hop into the local draft slot.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

interface NewCartPageProps {
  searchParams: { model?: string; starter?: string };
}

export default function NewCartPage({ searchParams }: NewCartPageProps) {
  if (isStaticExport) {
    return <StaticNewCartRedirect />;
  }
  return mintCartAndRedirect(searchParams);
}

function mintCartAndRedirect(searchParams: NewCartPageProps["searchParams"]): never {
  const modelId = resolveModelId(searchParams.model);
  const starterId = resolveStarterId(searchParams.starter);
  // Carry only non-default choices onto the fresh cart's URL, so the common
  // case (classic model, demo starter) stays a clean, param-free URL.
  const params = new URLSearchParams();
  if (modelId !== "classic") params.set("model", modelId);
  if (starterId !== DEFAULT_STARTER_ID) params.set("starter", starterId);
  const query = params.toString();
  redirect(`/edit/${randomUUID()}${query ? `?${query}` : ""}`);
}
