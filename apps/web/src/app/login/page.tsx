"use client";

/**
 * Sign in / sign up with email + password (Supabase Auth). On success the
 * session is stored in cookies by the browser client and picked up by the SSR
 * middleware, so server components immediately see the user.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { supabaseBrowser } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";

type Mode = "signin" | "signup";

export default function LoginPage() {
  // Accounts need the auth server; the static demo build has none. The flag is
  // a build-time constant, so the hook order below stays consistent.
  if (isStaticExport) {
    return (
      <main>
        <h1>Sign in</h1>
        <p>Accounts aren&apos;t available in this static demo build — your work saves to this browser instead.</p>
      </main>
    );
  }
  return <LoginForm />;
}

function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = supabaseBrowser();
    const { error: authError } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    setBusy(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    router.push("/profile/edit");
    router.refresh();
  };

  return (
    <main>
      <h1>{mode === "signin" ? "Sign in" : "Create account"}</h1>
      <form onSubmit={submit} style={{ display: "grid", gap: 10, maxWidth: 320 }}>
        <input
          type="email"
          placeholder="you@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          minLength={6}
          required
        />
        <button type="submit" disabled={busy}>
          {busy ? "…" : mode === "signin" ? "Sign in" : "Sign up"}
        </button>
      </form>

      {error && <p role="alert">{error}</p>}

      <p>
        {mode === "signin" ? "No account?" : "Already have an account?"}{" "}
        <button type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
          {mode === "signin" ? "Create one" : "Sign in"}
        </button>
      </p>
    </main>
  );
}
