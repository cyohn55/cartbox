import Link from "next/link";

import { MODELS } from "@cartbox/player";

import { MobileConsoleRedirect } from "./MobileConsoleRedirect";

/**
 * A console model that is specified but cannot be authored in yet.
 *
 * Deliberately not a link. An era model is only playable once its core is
 * built, and offering it before then would let someone create a cartridge that
 * cannot boot — so this states what the machine is and that it is not ready,
 * rather than hiding it until the day it works. The spec is read from the model
 * itself, so this line cannot drift from the console it describes.
 */
function AnnouncedModel({ id }: { id: keyof typeof MODELS }) {
  const model = MODELS[id];
  return (
    <p style={{ color: "var(--muted)" }}>
      {model.label} cartridge — {model.width}×{model.height}, {model.paletteSize} colors,
      textured 3D <em>— in development</em>
    </p>
  );
}

export default function HomePage() {
  return (
    <main>
      {/* Phones boot straight into the handheld console. */}
      <MobileConsoleRedirect />
      <h1>Cartbox</h1>
      <p>Make and play tiny games. Play free in your browser; keep the revenue on what you sell.</p>
      <p>
        <Link href="/console">Power on the handheld console →</Link>
      </p>
      <p>
        <Link href="/edit/new">Create a Classic cartridge →</Link>
      </p>
      <p>
        <Link href="/edit/new?model=pro">Create a Pro cartridge — 640×360, 64 colors, 8 channels →</Link>
      </p>
      <p>
        <Link href="/edit/new?model=portrait">
          Create a Portrait cartridge — 360×640, 64 colors, 8 channels →
        </Link>
      </p>
      <AnnouncedModel id="ps1" />
      <p>
        <Link href="/edit/new?starter=parallax">Create a parallax scene — three scrolling map layers →</Link>
      </p>
      <p>
        <Link href="/edit/new?starter=platformer">Create a platformer — run and jump on a collision layer →</Link>
      </p>
      <p>
        <Link href="/parallax">Open the Parallax Lab — 3D layered scene + segmented character →</Link>
      </p>
      <p>
        <Link href="/browse">Browse cartridges →</Link>
      </p>
    </main>
  );
}
