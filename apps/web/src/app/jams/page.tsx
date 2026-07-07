/**
 * /jams — list of game jams grouped by lifecycle status.
 *
 * Server component: reads jams directly and labels each with its computed
 * status so creators can see what is open, coming, and finished.
 */

import Link from "next/link";

import { serviceClient } from "@/lib/supabase";
import { jamStatus, type JamStatus } from "@/lib/jam";
import { isStaticExport } from "@/lib/staticSite";

const STATUS_LABEL: Record<JamStatus, string> = {
  open: "Open now",
  upcoming: "Upcoming",
  closed: "Finished",
};

export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export default async function JamsPage() {
  if (isStaticExport) {
    return (
      <main>
        <h1>Game jams</h1>
        <p>Jams live on the community server, which this static demo build doesn&apos;t include.</p>
      </main>
    );
  }

  const db = serviceClient();
  const { data } = await db
    .from("jams")
    .select("id, slug, title, theme, starts_at, ends_at")
    .order("starts_at", { ascending: false });

  const jams = (data ?? []).map((jam) => ({
    ...jam,
    status: jamStatus(new Date(jam.starts_at), new Date(jam.ends_at)),
  }));

  return (
    <main>
      <h1>Game jams</h1>
      {jams.length === 0 && <p>No jams yet — the launch jam is coming soon.</p>}
      <ul>
        {jams.map((jam) => (
          <li key={jam.id}>
            <Link href={`/jams/${jam.slug}`}>{jam.title}</Link>
            <span> — {STATUS_LABEL[jam.status]}</span>
            {jam.theme && <span> · Theme: {jam.theme}</span>}
          </li>
        ))}
      </ul>
    </main>
  );
}
