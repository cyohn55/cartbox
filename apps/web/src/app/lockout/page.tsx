/**
 * /lockout — play the Lockout arena outside the editor: solo against bots, or
 * online in a room with friends (the page relays the match; see LockoutGame).
 */

import Link from "next/link";

import { LockoutGame } from "./LockoutGame";
import { isStaticExport } from "@/lib/staticSite";

// Fully client-side, so the static demo build can prerender it.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export default function LockoutPage() {
  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "24px 16px" }}>
      <h1 style={{ marginBottom: 4 }}>Lockout</h1>
      <p style={{ maxWidth: 680, color: "var(--muted)", marginTop: 0 }}>
        A first-person arena on the Xbox 360 core: a Forerunner-style tower over a snowy valley. Play solo against seven
        bots, or open a room and share the link — up to eight people, with bots filling the empty slots.
      </p>
      <LockoutGame />
      <p style={{ marginTop: 16 }}>
        <Link href="/">← Home</Link>
      </p>
    </main>
  );
}
