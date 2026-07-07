/**
 * /profile/[handle] — a public profile: avatar, bio, and earned trophies.
 *
 * Server component. Trophies are the unlocks the verification worker granted, so
 * everything shown here was earned through a verified replay.
 */

import { notFound } from "next/navigation";

import { serviceClient } from "@/lib/supabase";
import { isStaticExport } from "@/lib/staticSite";
import { AvatarPreview } from "./AvatarPreview";

interface PageProps {
  params: { handle: string };
}

// Profiles live on the community server. `output: "export"` demands at least
// one prerendered path per dynamic route, so the static demo build emits a
// single placeholder that renders the not-available notice below.
export function generateStaticParams(): { handle: string }[] {
  return [{ handle: "demo" }];
}

interface UnlockRow {
  unlocked_at: string;
  achievements: { title: string; description: string; points: number } | null;
}

export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export default async function ProfilePage({ params }: PageProps) {
  if (isStaticExport) {
    return (
      <main>
        <h1>Profiles</h1>
        <p>Profiles live on the community server, which this static demo build doesn&apos;t include.</p>
      </main>
    );
  }

  const db = serviceClient();

  const { data: profile } = await db
    .from("profiles")
    .select("id, handle, display_name, bio, avatar_json")
    .eq("handle", params.handle)
    .single();

  if (!profile) {
    notFound();
  }

  const { data: unlocks } = await db
    .from("unlocks")
    .select("unlocked_at, achievements(title, description, points)")
    .eq("profile_id", profile.id)
    .order("unlocked_at", { ascending: false });

  const trophies = (unlocks ?? []) as unknown as UnlockRow[];
  const totalPoints = trophies.reduce((sum, row) => sum + (row.achievements?.points ?? 0), 0);

  return (
    <main>
      <header style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <AvatarPreview avatar={profile.avatar_json} size={96} />
        <div>
          <h1>{profile.display_name ?? profile.handle}</h1>
          <p>@{profile.handle}</p>
          {profile.bio && <p>{profile.bio}</p>}
        </div>
      </header>

      <section>
        <h2>
          Trophies · {trophies.length} · {totalPoints} pts
        </h2>
        {trophies.length === 0 && <p>No trophies yet.</p>}
        <ul>
          {trophies.map((row, index) => (
            <li key={index}>
              <strong>{row.achievements?.title ?? "Achievement"}</strong>
              {row.achievements?.points ? ` · ${row.achievements.points} pts` : ""}
              {row.achievements?.description && <div>{row.achievements.description}</div>}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
