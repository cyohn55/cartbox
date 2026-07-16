"use client";

/**
 * Create tab: launches the cartridge editor. The editor is a full workbench
 * (sprites, maps, code, music, FX), so it opens as its own page — this screen
 * is the console's launcher for it, cursor-navigable like everything else.
 */

import { withBasePath } from "@/lib/staticSite";

const STARTERS = [
  {
    href: "/edit/new",
    title: "NEW CLASSIC CART",
    blurb: "240×136 · 16 colors · 4 channels — the original canvas.",
  },
  {
    href: "/edit/new?model=pro",
    title: "NEW PRO CART",
    blurb: "640×360 · 64 colors · 8 channels — the big screen.",
  },
  {
    href: "/edit/new?starter=parallax",
    title: "PARALLAX SCENE",
    blurb: "Start from three scrolling map layers.",
  },
] as const;

export function CreateScreen() {
  return (
    <div className="os-page" data-console-nav data-testid="create-screen">
      <h2>CREATE A CARTRIDGE</h2>
      <p className="os-card-body" style={{ marginTop: 0 }}>
        The editor opens full-screen — sprites, maps, code, sound, and FX in
        one workbench. Your thumbs made games possible; a keyboard makes them
        comfortable.
      </p>
      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        {STARTERS.map((starter) => (
          <a key={starter.href} className="os-grid-card" href={withBasePath(starter.href)} style={{ padding: 12 }}>
            <span className="os-grid-title" style={{ fontSize: 13 }}>
              {starter.title}
            </span>
            <span className="os-grid-sub" style={{ marginTop: 4, display: "block" }}>
              {starter.blurb}
            </span>
          </a>
        ))}
      </div>

      <h2 style={{ marginTop: 20 }}>CUSTOMIZE YOUR HANDHELD</h2>
      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        <a className="os-grid-card" href={withBasePath("/onboarding/handheld")} style={{ padding: 12 }}>
          <span className="os-grid-title" style={{ fontSize: 13 }}>
            EDIT MY HANDHELD
          </span>
          <span className="os-grid-sub" style={{ marginTop: 4, display: "block" }}>
            Recolour it, pick a premade or animated skin, or draw your own — your
            current design opens ready to edit.
          </span>
        </a>
      </div>
    </div>
  );
}
