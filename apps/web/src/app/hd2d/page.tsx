/**
 * /hd2d — a playable HD-2D scene: an Octopath-Traveler-style true-3D village whose
 * terrain and scenery are composed entirely from named asset-library entries (the
 * "Village Pack"), walked by a layered-parallax 2D-sprite hero. Server-component
 * wrapper around the client canvas, matching the editor's and /world's split.
 */

import Link from "next/link";
import { Hd2dScene } from "./Hd2dScene";
import { isStaticExport } from "@/lib/staticSite";

// The scene is fully client-side, so the static demo build can prerender it.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export default function Hd2dPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px" }}>
      <h1>HD-2D Village</h1>
      <p>
        A playable <strong>HD-2D</strong> scene in the style of <em>Octopath Traveler</em>.
        The world is <strong>true 3D</strong>, and every piece of it is dropped in
        from the <strong>asset library</strong> — the ground tiles (grass, cobblestone,
        a pond) are library terrain textures, and the trees, cottages, well and lamp
        posts are library voxel props, each placed at an authored spot rather than
        generated. The hero is a <strong>2D sprite split into depth layers</strong> that
        parallaxes as the fixed ¾ camera follows you; world and character share one
        depth buffer, so terrain occludes the hero by true depth. Walk with the{" "}
        <strong>arrow keys</strong> or <strong>WASD</strong>.
      </p>
      <Hd2dScene />
      <p style={{ marginTop: 20 }}>
        <Link href="/">← Home</Link>
      </p>
    </main>
  );
}
