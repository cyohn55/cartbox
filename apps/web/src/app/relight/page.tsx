/**
 * /relight — the Relight Lab: an interactive view of the runtime material-
 * smoothing toggle. A server wrapper around the client canvas, matching the
 * other labs' page/component split.
 */

import Link from "next/link";

import { RelightLab } from "./RelightLab";
import { isStaticExport } from "@/lib/staticSite";

// The lab is fully client-side, so the static demo build can prerender it.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export default function RelightLabPage() {
  return (
    <main>
      <h1>Relight Lab</h1>
      <p style={{ maxWidth: 640 }}>
        Cartridge normal and material maps are 4-bit. Supersampling the lighting
        pass de-bands them at render time — flip the toggle to see the smoothing
        engage, running the real runtime on your GPU.
      </p>
      <RelightLab />
      <p style={{ marginTop: 16 }}>
        <Link href="/">← Home</Link>
      </p>
    </main>
  );
}
