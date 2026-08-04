/**
 * /hd2d — a playable HD-2D scene: Octopath-Traveler-style true-3D world (voxel
 * geometry wearing pixel-art materials) with a REPLACED night aesthetic, walked by
 * a layered-parallax 2D-sprite hero. Server-component wrapper around the client
 * canvas, matching the editor's and /world's page/component split.
 */

import Link from "next/link";
import { Hd2dScene } from "./Hd2dScene";
import { isStaticExport } from "@/lib/staticSite";

// The scene is fully client-side, so the static demo build can prerender it.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export default function Hd2dPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px" }}>
      <h1>HD-2D Street</h1>
      <p>
        A playable <strong>HD-2D</strong> scene in the style of <em>Octopath Traveler</em>,
        with a <em>REPLACED</em> neon-night aesthetic. The world is{" "}
        <strong>true 3D</strong> — real voxel geometry wearing hand-authored pixel-art
        materials (wet asphalt, brick towers with lit windows and neon bands,
        streetlamps) — while the hero is a <strong>2D sprite split into depth layers</strong>{" "}
        that parallax to fake volume as the fixed ¾ camera follows you. Everything
        shares one camera and one depth buffer, so the world occludes the character by
        true depth. Walk with the <strong>arrow keys</strong> or <strong>WASD</strong>.
      </p>
      <Hd2dScene />
      <p style={{ marginTop: 20 }}>
        <Link href="/">← Home</Link>
      </p>
    </main>
  );
}
