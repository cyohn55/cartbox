"use client";

/**
 * Static-demo entry into the editor (see src/lib/staticSite.ts).
 *
 * The server build resolves a cart's stored bytes, model and sidecars from the
 * database before mounting the workbench. The static build has no database, so
 * this client leaf does the same resolution in the browser:
 *
 *   1. A locally saved draft for this cart id (localStorage) wins — it holds
 *      the user's own edits, exposed to the workbench as a blob URL so the
 *      normal cart-loading path applies unchanged.
 *   2. Otherwise the baked-in demo cart bytes load, when the id is in the
 *      catalog.
 *   3. Otherwise the workbench opens a fresh cart on the chosen starter, with
 *      model/starter read from the URL query (?model=pro&starter=parallax),
 *      which a statically exported server component cannot see.
 *
 * The sidecars come back from the draft as one registry bundle. Listing them
 * here by hand is what made the demo build drop every mesh and world a creator
 * built: this file passed `initialMesh={null}` and `initialWorld={null}` no
 * matter what the draft held.
 */

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { resolveModelId } from "@/lib/consoleModel";
import { resolveStarterId } from "@/lib/starter";
import { draftBytes, loadCartDraft } from "@/lib/localCartStore";
import { findDemoCart, demoCartUrl } from "@/lib/demoCatalog";
import { emptySidecars, type Sidecars } from "@/lib/sidecars";
import { EditorWorkbench } from "./EditorWorkbench";

interface StaticCartEditorProps {
  cartId: string;
}

interface ResolvedCart {
  name: string;
  cartUrl: string | null;
  storedModel: string | null;
  sidecars: Sidecars;
  description: string;
  tags: string[];
}

function StaticCartEditorInner({ cartId }: StaticCartEditorProps) {
  const searchParams = useSearchParams();
  const [resolved, setResolved] = useState<ResolvedCart | null>(null);

  useEffect(() => {
    const demoCart = findDemoCart(cartId);
    const draft = loadCartDraft(cartId);
    if (draft) {
      const blobUrl = URL.createObjectURL(
        new Blob([draftBytes(draft) as unknown as BlobPart], { type: "application/octet-stream" }),
      );
      setResolved({
        name: draft.meta.title || (demoCart ? `${demoCart.title} (local edits)` : "Draft cartridge"),
        cartUrl: blobUrl,
        storedModel: draft.model,
        sidecars: draft.sidecars,
        description: draft.meta.description,
        tags: draft.meta.tags,
      });
      return () => URL.revokeObjectURL(blobUrl);
    }
    setResolved({
      name: demoCart?.title ?? "Draft cartridge",
      cartUrl: demoCart ? demoCartUrl(demoCart.id) : null,
      storedModel: demoCart?.consoleModel ?? null,
      sidecars: emptySidecars(),
      description: "",
      tags: [],
    });
    return undefined;
  }, [cartId]);

  if (!resolved) {
    return <div style={{ padding: 20 }}>Loading cartridge…</div>;
  }

  // A saved model is authoritative; a brand-new draft takes ?model= from the
  // URL, mirroring how the server build resolves /edit/new hand-offs.
  const modelId = resolveModelId(resolved.storedModel ?? searchParams.get("model"));
  const starterId = resolveStarterId(searchParams.get("starter") ?? undefined);

  return (
    <EditorWorkbench
      cartId={cartId}
      cartName={resolved.name}
      cartUrl={resolved.cartUrl}
      modelId={modelId}
      starterId={starterId}
      initialSidecars={resolved.sidecars}
      initialDescription={resolved.description}
      initialTags={resolved.tags}
    />
  );
}

export function StaticCartEditor({ cartId }: StaticCartEditorProps) {
  // useSearchParams needs a Suspense boundary in statically exported pages.
  return (
    <Suspense fallback={<div style={{ padding: 20 }}>Loading cartridge…</div>}>
      <StaticCartEditorInner cartId={cartId} />
    </Suspense>
  );
}
