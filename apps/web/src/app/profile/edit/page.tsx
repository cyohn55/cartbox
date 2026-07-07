/**
 * /profile/edit — the signed-in user's avatar editor.
 *
 * Server component that resolves the current user, loads their existing avatar,
 * and hands it to the client editor.
 */

import { redirect } from "next/navigation";

import { serviceClient } from "@/lib/supabase";
import { getServerUserId } from "@/lib/supabase-server";
import { isStaticExport } from "@/lib/staticSite";
import { AvatarEditor } from "@/app/profile/AvatarEditor";

export default async function EditProfilePage() {
  if (isStaticExport) {
    return (
      <main>
        <h1>Your avatar</h1>
        <p>Profiles need an account, which this static demo build doesn&apos;t support.</p>
      </main>
    );
  }

  const userId = await getServerUserId();
  if (!userId) {
    redirect("/"); // not signed in
  }

  const db = serviceClient();
  const { data: profile } = await db
    .from("profiles")
    .select("avatar_json")
    .eq("id", userId)
    .single();

  return (
    <main>
      <h1>Your avatar</h1>
      <AvatarEditor initial={profile?.avatar_json} />
    </main>
  );
}
