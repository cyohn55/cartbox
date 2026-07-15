"use client";

/**
 * Sign in / sign up with Supabase Auth. Sign up collects a username, email, and
 * password: the username is validated and checked for availability, then passed
 * as user metadata so the DB trigger creates the profile with it (see
 * 0009_profile_on_signup.sql). New accounts continue to the handheld-selection
 * step — immediately when email confirmation is off, or after the verification
 * link when it is on.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { supabaseBrowser } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";
import { normalizeHandle, handleError } from "@/lib/handle";

type Mode = "signin" | "signup";

/** Where a new player goes to set up their handheld before reaching the app. */
const ONBOARDING_NEXT = "/onboarding/handheld?next=/profile/edit";

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
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  // Live, cheap format check for the username (availability is checked on submit).
  const normalizedHandle = normalizeHandle(handle);
  const handleFormatError = handle.length > 0 ? handleError(normalizedHandle) : null;

  const signUp = async (supabase: ReturnType<typeof supabaseBrowser>) => {
    const formatError = handleError(normalizedHandle);
    if (formatError) {
      setError(formatError);
      return;
    }

    // Availability pre-check (the DB still guards the race).
    const availability = await fetch(`/api/auth/handle?handle=${encodeURIComponent(normalizedHandle)}`)
      .then((response) => response.json() as Promise<{ available: boolean; error?: string }>)
      .catch(() => null);
    if (!availability?.available) {
      setError(availability?.error ?? "That username is taken.");
      return;
    }

    const { data, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { handle: normalizedHandle, display_name: normalizedHandle },
        emailRedirectTo: `${window.location.origin}${ONBOARDING_NEXT}`,
      },
    });
    if (authError) {
      setError(authError.message);
      return;
    }

    // With email confirmation on there is no session yet — the player must click
    // the verification link. Otherwise they are signed in and continue now.
    if (data.session) {
      router.push(ONBOARDING_NEXT);
      router.refresh();
    } else {
      setCheckEmail(true);
    }
  };

  const signIn = async (supabase: ReturnType<typeof supabaseBrowser>) => {
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      setError(authError.message);
      return;
    }
    // The profile page sends players without a handheld to onboarding.
    router.push("/profile/edit");
    router.refresh();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = supabaseBrowser();
    if (mode === "signup") {
      await signUp(supabase);
    } else {
      await signIn(supabase);
    }
    setBusy(false);
  };

  if (checkEmail) {
    return (
      <main>
        <h1>Confirm your email</h1>
        <p>
          We sent a verification link to <strong>{email}</strong>. Open it to finish creating your account — you&apos;ll
          then choose your handheld.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>{mode === "signin" ? "Sign in" : "Create account"}</h1>
      <form onSubmit={submit} style={{ display: "grid", gap: 10, maxWidth: 320 }}>
        {mode === "signup" && (
          <>
            <input
              type="text"
              placeholder="username"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
            {handleFormatError && (
              <small role="alert" style={{ color: "var(--live)" }}>
                {handleFormatError}
              </small>
            )}
          </>
        )}
        <input
          type="email"
          placeholder="you@email.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          minLength={6}
          required
        />
        <button type="submit" disabled={busy || (mode === "signup" && handleFormatError !== null)}>
          {busy ? "…" : mode === "signin" ? "Sign in" : "Sign up"}
        </button>
      </form>

      {error && <p role="alert">{error}</p>}

      <p>
        {mode === "signin" ? "No account?" : "Already have an account?"}{" "}
        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
          }}
        >
          {mode === "signin" ? "Create one" : "Sign in"}
        </button>
      </p>
    </main>
  );
}
