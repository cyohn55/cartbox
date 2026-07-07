"use client";

/**
 * Static-demo replacement for /edit/new's server redirect (which mints a
 * random cart id — impossible on a static host, where only prerendered paths
 * exist). Instead every new cart opens the single local draft slot: any
 * previous draft is cleared so "Create" always starts fresh, and the
 * model/starter query carries over for the editor to read client-side.
 */

import { useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { clearCartDraft } from "@/lib/localCartStore";
import { DEMO_DRAFT_CART_ID } from "@/lib/demoCatalog";

function RedirectToDraft() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    clearCartDraft(DEMO_DRAFT_CART_ID);
    const query = searchParams.toString();
    router.replace(`/edit/${DEMO_DRAFT_CART_ID}${query ? `?${query}` : ""}`);
  }, [router, searchParams]);

  return <p style={{ padding: 20 }}>Opening a fresh cartridge…</p>;
}

export function StaticNewCartRedirect() {
  // useSearchParams needs a Suspense boundary in statically exported pages.
  return (
    <Suspense fallback={<p style={{ padding: 20 }}>Opening a fresh cartridge…</p>}>
      <RedirectToDraft />
    </Suspense>
  );
}
