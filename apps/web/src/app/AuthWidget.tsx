"use client";

/**
 * Header auth control: shows the signed-in email + sign out, or a sign-in link.
 * Reacts to auth state changes so it updates immediately after login/logout.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import { supabaseBrowser } from "@/lib/supabase-browser";

export function AuthWidget() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = supabaseBrowser();
    void supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!email) {
    return <Link href="/login">Sign in</Link>;
  }

  const signOut = async () => {
    await supabaseBrowser().auth.signOut();
    window.location.reload();
  };

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <span>{email}</span>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
    </span>
  );
}
