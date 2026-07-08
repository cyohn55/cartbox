"use client";

/**
 * Console sign-in: email+password sign in / sign up (Supabase, same flow as
 * /login) plus "continue as guest". The static demo build has no auth server,
 * so it offers guest mode only.
 */

import { useState, type FormEvent } from "react";

import { supabaseBrowser } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";

type Mode = "signin" | "signup";

interface AuthScreenProps {
  onSignedIn: () => void;
  onGuest: () => void;
}

export function AuthScreen({ onSignedIn, onGuest }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isStaticExport) {
    return (
      <div className="os-stage os-auth" data-console-nav data-testid="auth-screen">
        <h2>WELCOME</h2>
        <p className="os-card-body">
          This is the static demo build — accounts live on the community server. Play as a guest;
          your work saves to this browser.
        </p>
        <button type="button" className="os-btn" onClick={onGuest}>
          Continue as guest
        </button>
      </div>
    );
  }

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
    onSignedIn();
  };

  return (
    <div className="os-stage os-auth" data-console-nav data-testid="auth-screen">
      <h2>{mode === "signin" ? "SIGN IN" : "NEW PLAYER"}</h2>
      <form onSubmit={submit}>
        <input
          className="os-input"
          type="email"
          placeholder="you@email.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
        />
        <input
          className="os-input"
          type="password"
          placeholder="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          minLength={6}
          required
        />
        <button type="submit" className="os-btn" disabled={busy}>
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      {error && <p className="os-error" role="alert">{error}</p>}

      <p className="os-card-body">
        {mode === "signin" ? "No account? " : "Already have an account? "}
        <button
          type="button"
          className="os-auth-switch"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        >
          {mode === "signin" ? "Create one" : "Sign in"}
        </button>
      </p>

      <button type="button" className="os-btn os-btn-ghost" onClick={onGuest}>
        Continue as guest
      </button>
    </div>
  );
}
