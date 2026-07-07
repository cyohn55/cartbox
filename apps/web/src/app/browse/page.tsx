/**
 * /browse — the cartridge gallery. Server component listing published carts,
 * newest first, with an optional ?tag= filter.
 */

import Link from "next/link";

import { serviceClient } from "@/lib/supabase";
import { publicUrl } from "@/lib/storage";
import { isStaticExport } from "@/lib/staticSite";
import { DEMO_CARTS } from "@/lib/demoCatalog";

interface BrowseProps {
  searchParams: { tag?: string };
}

function formatPrice(cents: number): string {
  return cents === 0 ? "Free" : `$${(cents / 100).toFixed(2)}`;
}

// The static demo build renders the baked-in catalog at build time; the server
// build must stay dynamic so a just-published cart appears immediately.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

/** Build-time gallery over the baked-in demo catalog (static build only). */
function StaticBrowsePage() {
  return (
    <main>
      <h1>Browse cartridges</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
        {DEMO_CARTS.map((cart) => (
          <Link key={cart.id} href={`/play/${cart.id}`}>
            <article>
              <h3>{cart.title}</h3>
              <p>
                {formatPrice(cart.priceCents)} · {cart.consoleModel === "pro" ? "Pro" : "Classic"}
              </p>
              <p style={{ color: "var(--muted)", fontSize: 13 }}>{cart.description}</p>
            </article>
          </Link>
        ))}
      </div>
    </main>
  );
}

export default async function BrowsePage({ searchParams }: BrowseProps) {
  if (isStaticExport) {
    return <StaticBrowsePage />;
  }

  const db = serviceClient();
  let query = db
    .from("carts")
    .select("id, title, tags, price_cents, thumb_key, plays")
    .eq("published", true)
    .order("created_at", { ascending: false })
    .limit(60);

  if (searchParams.tag) {
    query = query.contains("tags", [searchParams.tag]);
  }

  const { data } = await query;
  const carts = data ?? [];

  return (
    <main>
      <h1>Browse cartridges{searchParams.tag ? ` · #${searchParams.tag}` : ""}</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
        {carts.map((cart) => (
          <Link key={cart.id} href={`/play/${cart.id}`}>
            <article>
              {cart.thumb_key && (
                <img src={publicUrl(cart.thumb_key)} alt={cart.title} style={{ width: "100%", imageRendering: "pixelated" }} />
              )}
              <h3>{cart.title}</h3>
              <p>{formatPrice(cart.price_cents)} · {cart.plays} plays</p>
            </article>
          </Link>
        ))}
      </div>
      {carts.length === 0 && <p>No cartridges yet.</p>}
    </main>
  );
}
