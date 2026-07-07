/**
 * /parallax — the Parallax Lab preview: a depth-layered 3D scene with a
 * segmented character rig, driven by a perspective camera. Server component
 * wrapper around the client canvas, matching the editor's page/component split.
 */

import Link from "next/link";
import { ParallaxLab } from "./ParallaxLab";
import { isStaticExport } from "@/lib/staticSite";

// The lab is fully client-side, so the static demo build can prerender it.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export default function ParallaxLabPage() {
  return (
    <main>
      <h1>Parallax Lab</h1>
      <p>
        Multi-plane sprite layering under a perspective camera. Each part of the
        character sits at its own depth, so panning and yaw give a flat sprite
        pseudo-3D volume.
      </p>
      <ParallaxLab />
      <p style={{ marginTop: 16 }}>
        <Link href="/">← Home</Link>
      </p>
    </main>
  );
}
