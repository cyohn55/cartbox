/**
 * Root layout for the Cartbox web app (required by the App Router).
 */

import type { ReactNode } from "react";
import Link from "next/link";

import "./globals.css";
import { AuthWidget } from "./AuthWidget";
import { isStaticExport } from "@/lib/staticSite";

export const metadata = {
  title: "Cartbox",
  description: "Make and play tiny games. Keep the revenue.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <nav style={{ display: "flex", gap: 18, alignItems: "center" }}>
            <Link href="/" style={{ fontWeight: 700, letterSpacing: "-0.02em" }}>
              Cartbox
            </Link>
            <Link href="/browse" style={{ color: "var(--muted)" }}>
              Browse
            </Link>
            <Link href="/jams" style={{ color: "var(--muted)" }}>
              Jams
            </Link>
            <Link href="/edit/new" style={{ color: "var(--muted)" }}>
              Create
            </Link>
          </nav>
          {isStaticExport ? (
            <span
              style={{ color: "var(--muted)", fontSize: 13 }}
              title="Static demo build — accounts, publishing, and the community server are unavailable. Your work saves to this browser."
            >
              Demo build · saves locally
            </span>
          ) : (
            <AuthWidget />
          )}
        </header>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: 20 }}>{children}</div>
      </body>
    </html>
  );
}
