/**
 * Browse's featured banner for Lockout, the built-in arena shooter. It lives on
 * its own page (/lockout: full screen, matchmaking, the Start menu) rather than
 * in the published-cart catalog, so Browse points to it here.
 */

import Link from "next/link";

import { withBasePath } from "@/lib/staticSite";

export function FeaturedLockout() {
  return (
    <Link
      href="/lockout"
      aria-label="Play Lockout"
      className="cbx-panel"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: 16,
        alignItems: "center",
        padding: 12,
        marginBottom: 20,
        color: "inherit",
        textDecoration: "none",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static export: no image optimizer */}
      <img
        src={withBasePath("/featured/lockout.jpg")}
        alt="Lockout: a first-person arena with a Spartan-style soldier and a rifle"
        width={640}
        height={360}
        style={{ width: "100%", height: "auto", borderRadius: "var(--radius-sm)", display: "block" }}
      />
      <div style={{ display: "grid", gap: 8 }}>
        <span style={{ color: "var(--muted)", fontSize: 12, letterSpacing: 1, textTransform: "uppercase" }}>
          Featured · Xbox 360
        </span>
        <strong style={{ fontSize: 22 }}>Lockout</strong>
        <span style={{ color: "var(--muted)" }}>
          A first-person arena shooter. Play against bots, or pick Matchmaking to play people online. Works with an Xbox
          controller, touch or a keyboard.
        </span>
        <span className="cbx-btn cbx-btn-accent" style={{ justifySelf: "start", marginTop: 4 }}>
          Play Lockout →
        </span>
      </div>
    </Link>
  );
}
