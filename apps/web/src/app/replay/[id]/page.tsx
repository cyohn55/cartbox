/**
 * /replay/[id] — watch a recorded replay.
 *
 * Server component: loads the replay row and its cart, then hands the client
 * viewer the cart URL, the serialized-replay URL, and the model.
 */

import { notFound } from "next/navigation";

import { serviceClient } from "@/lib/supabase";
import { publicUrl } from "@/lib/storage";
import { isStaticExport } from "@/lib/staticSite";
import type { ModelId } from "@cartbox/player";
import { ReplayViewer } from "./ReplayViewer";

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? "/engine/tic80.js";

interface PageProps {
  params: { id: string };
}

export const dynamic = isStaticExport ? "auto" : "force-dynamic";

// Replays live on the community server. `output: "export"` demands at least
// one prerendered path per dynamic route, so the static demo build emits a
// single placeholder that renders the not-available notice below.
export function generateStaticParams(): { id: string }[] {
  return [{ id: "none" }];
}

export default async function ReplayPage({ params }: PageProps) {
  if (isStaticExport) {
    return (
      <main>
        <h1>Replays</h1>
        <p>Replays live on the community server, which this static demo build doesn&apos;t include.</p>
      </main>
    );
  }

  const db = serviceClient();

  const { data: replay } = await db
    .from("replays")
    .select("id, cart_id, model_id, data_r2_key")
    .eq("id", params.id)
    .single();

  if (!replay) {
    notFound();
  }

  const { data: cart } = await db
    .from("carts")
    .select("id, title, r2_key")
    .eq("id", replay.cart_id)
    .single();

  if (!cart) {
    notFound();
  }

  return (
    <main>
      <h1>Replay — {cart.title}</h1>
      <ReplayViewer
        cartUrl={publicUrl(cart.r2_key)}
        engineUrl={ENGINE_URL}
        replayUrl={publicUrl(replay.data_r2_key)}
        modelId={replay.model_id as ModelId}
      />
    </main>
  );
}
