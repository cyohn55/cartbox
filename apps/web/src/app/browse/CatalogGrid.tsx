/**
 * The Browse grid, shared by both builds.
 *
 * Rendered from a server component in the Supabase-backed build and from the
 * client-side filter in the static demo build, so it holds no data access of its
 * own — entries in, markup out.
 */

import Link from "next/link";

import { formatPrice, type CatalogEntry } from "@/lib/catalog";
import { resolveRuntime } from "@/lib/titleRuntime";

export function CatalogGrid({ entries }: { entries: readonly CatalogEntry[] }) {
  if (entries.length === 0) {
    return <p>Nothing here yet.</p>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
      {entries.map((entry) => (
        <Link key={`${entry.kind}:${entry.id}`} href={entry.href}>
          <article>
            {entry.thumbUrl && (
              <img
                src={entry.thumbUrl}
                alt={entry.name}
                style={{ width: "100%", imageRendering: "pixelated" }}
              />
            )}
            <h3>{entry.name}</h3>
            <p>
              {formatPrice(entry.priceCents)} · {resolveRuntime(entry.runtime)?.label ?? entry.runtime}
            </p>
            {/* Tier C ships the engine only, so say so before the player commits. */}
            {entry.assetSource === "user-supplied" && (
              <p style={{ color: "var(--muted)", fontSize: 12 }}>Bring your own game data</p>
            )}
            <p style={{ color: "var(--muted)", fontSize: 13 }}>{entry.description}</p>
          </article>
        </Link>
      ))}
    </div>
  );
}
