/**
 * /world — the world-primitive foundation demo: hexel terrain, voxel objects and
 * pixel weather composited into one camera and depth buffer. Server component
 * wrapper around the client canvas, matching the editor's page/component split.
 */

import Link from "next/link";
import { WorldDemo } from "./WorldDemo";
import { isStaticExport } from "@/lib/staticSite";

// The demo is fully client-side, so the static demo build can prerender it.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export default function WorldPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px" }}>
      <h1>World Foundation</h1>
      <p>
        The three world primitives sharing one camera and one depth buffer:{" "}
        <strong>hexels</strong> for the full-3D terrain (orbit to find the caves),{" "}
        <strong>voxels</strong> for built objects — a sunk monolith the terrain
        occludes, and handhelds floating above it — and <strong>pixels</strong> for
        the falling snow. Everything hides everything else by true depth, not draw
        order. The centre handheld boots the Cartbox <strong>Make · Play · Share</strong>{" "}
        OS live on its own screen — a grid of self-lit voxels driven by a tiny
        framebuffer. Drive it with the d-pad: <strong>arrow keys</strong> to move
        the cursor, <strong>Z</strong> = A (select / apply), <strong>X</strong> =
        B (back), <strong>Enter</strong> = Start. Open the menu, customize the
        handheld's body, buttons and screen colour, then choose <strong>PICK</strong>.
        The other handhelds vanish and the same keys (or WASD) walk you into the
        world.
      </p>
      <WorldDemo />
      <p style={{ marginTop: 20 }}>
        <Link href="/">← Home</Link>
      </p>
    </main>
  );
}
