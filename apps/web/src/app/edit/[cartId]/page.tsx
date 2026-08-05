/**
 * /edit/[cartId] — the custom Cartbox editor. Server component: resolves the
 * cart's name and the URL of its stored .tic (best-effort), then hands off to
 * the client workbench, which loads those bytes into the WASM engine. A cart
 * with no stored bytes opens on the demo seed.
 */

import { parsePostFxSettings, parseScene, parseAnim, parseParticles, type AnimSpec, type ParticleSpec, type PostFxSettings, type SceneSpec } from "@cartbox/player";
import type { CollisionData, FlagData } from "@cartbox/editor";

import { serviceClient } from "@/lib/supabase";
import { parseCollision } from "@/lib/collision";
import { parseFlags } from "@/lib/flags";
import { publicUrl } from "@/lib/storage";
import { resolveModelId } from "@/lib/consoleModel";
import { resolveStarterId } from "@/lib/starter";
import { parseRig, type WireRig } from "@/lib/rig";
import { parseMaterials, type WireMaterials } from "@/lib/materials";
import { parseVoxelPayload } from "@/lib/voxelSidecar";
import { isStaticExport } from "@/lib/staticSite";
import { DEMO_CARTS, DEMO_DRAFT_CART_ID } from "@/lib/demoCatalog";
import { EditorWorkbench } from "./EditorWorkbench";
import { StaticCartEditor } from "./StaticCartEditor";

// The static demo build prerenders an editor page per demo cart plus the local
// draft slot; the server build resolves carts per request.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export function generateStaticParams(): { cartId: string }[] {
  if (!isStaticExport) {
    return [];
  }
  return [{ cartId: DEMO_DRAFT_CART_ID }, ...DEMO_CARTS.map((cart) => ({ cartId: cart.id }))];
}

interface EditorPageProps {
  params: { cartId: string };
  searchParams: { model?: string; starter?: string };
}

interface CartTarget {
  name: string;
  cartUrl: string | null;
  /** Persisted console model, or null when the cart has no row yet (new cart). */
  storedModel: string | null;
  /** Persisted character rig, validated, or null when absent/malformed. */
  rig: WireRig | null;
  /** Persisted post-processing stack, validated, or null when absent/malformed. */
  fx: PostFxSettings | null;
  /** Persisted material swatch bindings, validated, or null when absent/malformed. */
  materials: WireMaterials | null;
  /** Persisted voxel sculpt payload, validated, or null when absent/malformed. */
  voxel: string | null;
  /** Persisted parallax-scene backdrop, validated, or null when absent/malformed. */
  scene: SceneSpec | null;
  /** Persisted animation timeline, validated, or null when absent/malformed. */
  anim: AnimSpec | null;
  /** Persisted weather/particle system, validated, or null when absent/malformed. */
  particles: ParticleSpec | null;
  /** Persisted per-cell collision layer, validated, or null when absent/malformed. */
  collision: CollisionData | null;
  /** Persisted per-cell tile-flags layer, validated, or null when absent/malformed. */
  flags: FlagData | null;
  /** Persisted marketplace description, or empty when none. */
  description: string;
  /** Persisted marketplace tags, or empty when none. */
  tags: string[];
}

async function resolveCart(cartId: string): Promise<CartTarget> {
  try {
    const { data } = await serviceClient()
      .from("carts")
      .select("title, description, tags, r2_key, console_model, rig, fx, materials, voxel, scene, anim, particles, collision, flags")
      .eq("id", cartId)
      .maybeSingle();
    return {
      name: data?.title ?? "Untitled cartridge",
      cartUrl: data?.r2_key ? publicUrl(data.r2_key) : null,
      storedModel: data?.console_model ?? null,
      rig: parseRig(data?.rig),
      fx: parsePostFxSettings(data?.fx),
      materials: parseMaterials(data?.materials),
      voxel: parseVoxelPayload(data?.voxel),
      scene: parseScene(data?.scene),
      anim: parseAnim(data?.anim),
      particles: parseParticles(data?.particles),
      collision: parseCollision(data?.collision),
      flags: parseFlags(data?.flags),
      description: typeof data?.description === "string" ? data.description : "",
      tags: Array.isArray(data?.tags) ? (data.tags as string[]) : [],
    };
  } catch {
    // A missing `voxel`/`scene`/`collision` column (migration not yet applied)
    // lands here too, and simply opens the editor with no sculpt/backdrop/collision
    // rather than failing.
    return {
      name: "Untitled cartridge",
      cartUrl: null,
      storedModel: null,
      rig: null,
      fx: null,
      materials: null,
      voxel: null,
      scene: null,
      anim: null,
      particles: null,
      collision: null,
      flags: null,
      description: "",
      tags: [],
    };
  }
}

export default async function EditorPage({ params, searchParams }: EditorPageProps) {
  if (isStaticExport) {
    // No database at build time — the client leaf resolves local drafts, baked
    // demo carts, and URL params (searchParams are unavailable in an export).
    return <StaticCartEditor cartId={params.cartId} />;
  }

  const { name, cartUrl, storedModel, rig, fx, materials, voxel, scene, anim, particles, collision, flags, description, tags } =
    await resolveCart(params.cartId);
  // A saved cart's persisted model is authoritative; a brand-new cart (no row)
  // takes the model from the ?model= param carried in from /edit/new.
  const modelId = resolveModelId(storedModel ?? searchParams.model);
  // The starter only seeds a brand-new cart (one with no stored bytes); the
  // workbench ignores it once real cart bytes load.
  const starterId = resolveStarterId(searchParams.starter);
  return (
    <EditorWorkbench
      cartId={params.cartId}
      cartName={name}
      cartUrl={cartUrl}
      modelId={modelId}
      starterId={starterId}
      initialRig={rig}
      initialFx={fx}
      initialMaterials={materials}
      initialVoxel={voxel}
      initialScene={scene}
      initialAnim={anim}
      initialParticles={particles}
      initialCollision={collision}
      initialFlags={flags}
      initialDescription={description}
      initialTags={tags}
    />
  );
}
