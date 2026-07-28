/**
 * Unit tests for the Browse catalog foundation (Phase 1):
 *   - the unified cart + title view model and its runtime filter
 *   - license classification, and its agreement with the database
 *   - claim authority: listing edits, steward management, pricing, succession
 *
 * Expected values are derived from the modules' own inputs and from the real
 * migration file rather than copied constants, so the tests assert behaviour
 * and cross-module agreement instead of snapshotting a list.
 *
 * Run with: npx vitest run "Unit Tests/catalog-titles.test.ts"
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  cartToEntry,
  filterByRuntime,
  formatPrice,
  mergeCatalog,
  runtimeForConsoleModel,
  titleToEntry,
  type CartRow,
  type TitleRow,
} from "../apps/web/src/lib/catalog";
import {
  COMMERCIAL_LICENSE_IDS,
  licensePermitsCommercial,
  requiresSourceOffer,
} from "../apps/web/src/lib/licensing";
import {
  RUNTIME_IDS,
  implementedRuntimes,
  isRuntimeId,
  requiresUserAssets,
  resolveRuntime,
  runtimeDescriptors,
} from "../apps/web/src/lib/titleRuntime";
import {
  canEditListing,
  canFileTransferClaim,
  canManageStewards,
  canRevokeClaim,
  canSelfEscalate,
  canSetPrice,
  forfeitPrimary,
  isNoticeWindowClosed,
  promoteToPrimary,
  type ClaimableTitle,
  type SuccessionPolicy,
  type TitleClaim,
} from "../apps/web/src/lib/titleClaims";
import { DEMO_TITLES } from "../apps/web/src/lib/demoTitles";

const MIGRATION_PATH = fileURLToPath(
  new URL(
    "../supabase/migrations/0011_titles_catalog.sql",
    import.meta.url,
  ),
);

const migrationSql = readFileSync(MIGRATION_PATH, "utf8");

// ---------------------------------------------------------------------------
// Fixtures — built from the modules' own types so a shape change breaks here.
// ---------------------------------------------------------------------------

function makeCart(overrides: Partial<CartRow> = {}): CartRow {
  return {
    id: "cart-1",
    title: "Neon City",
    description: "A cyberpunk side-scroller.",
    console_model: "pro",
    price_cents: 0,
    plays: 12,
    thumb_key: "thumbs/cart-1.png",
    created_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeTitle(overrides: Partial<TitleRow> = {}): TitleRow {
  return {
    id: "title-1",
    name: "SuperTux",
    description: "A 2D platformer.",
    runtime: "wasm-app",
    asset_source: "bundled",
    tier: "A",
    price_cents: 0,
    plays: 3,
    thumb_key: null,
    created_at: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeClaim(overrides: Partial<TitleClaim> = {}): TitleClaim {
  return {
    titleId: "title-1",
    profileId: "profile-1",
    level: "steward",
    isPrimary: true,
    status: "active",
    grantedBy: null,
    lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const identityThumb = (key: string | null | undefined) => key ?? null;

// ---------------------------------------------------------------------------
// Catalog view model
// ---------------------------------------------------------------------------

describe("catalog normalisation", () => {
  it("maps a cart's console model onto the matching Cartbox runtime", () => {
    expect(runtimeForConsoleModel("pro")).toBe("cartbox-pro");
    expect(runtimeForConsoleModel("classic")).toBe("cartbox-classic");
  });

  it("treats an unknown console model as Classic rather than failing", () => {
    // Carts predate the runtime registry, so an unrecognised value must still
    // produce a playable entry.
    expect(runtimeForConsoleModel("voxel")).toBe("cartbox-classic");
  });

  it("carries the cart's own field values into the entry", () => {
    const cart = makeCart({ title: "Lumen", price_cents: 250, plays: 7 });
    const entry = cartToEntry(cart, identityThumb);

    expect(entry.kind).toBe("cart");
    expect(entry.name).toBe(cart.title);
    expect(entry.priceCents).toBe(cart.price_cents);
    expect(entry.plays).toBe(cart.plays);
    expect(entry.href).toContain(cart.id);
    expect(entry.createdAt.toISOString()).toBe(cart.created_at);
  });

  it("resolves thumbnails through the injected resolver, not a hard-coded host", () => {
    const entry = cartToEntry(makeCart({ thumb_key: "k" }), (key) => `cdn://${key}`);
    expect(entry.thumbUrl).toBe("cdn://k");
  });

  it("renders an entry without art when the row has no thumbnail key", () => {
    const entry = titleToEntry(makeTitle({ thumb_key: null }), (key) => (key ? `cdn://${key}` : null));
    expect(entry.thumbUrl).toBeNull();
  });

  it("keeps tier and asset source on titles and omits them on carts", () => {
    const title = titleToEntry(makeTitle({ tier: "C", asset_source: "user-supplied" }), identityThumb);
    const cart = cartToEntry(makeCart(), identityThumb);

    expect(title.tier).toBe("C");
    expect(title.assetSource).toBe("user-supplied");
    expect(cart.tier).toBeUndefined();
    expect(cart.assetSource).toBeUndefined();
  });
});

describe("mergeCatalog", () => {
  it("interleaves carts and titles by recency rather than grouping by kind", () => {
    const older = cartToEntry(makeCart({ id: "old", created_at: "2026-01-01T00:00:00.000Z" }), identityThumb);
    const newest = titleToEntry(makeTitle({ id: "new", created_at: "2026-09-01T00:00:00.000Z" }), identityThumb);
    const middle = cartToEntry(makeCart({ id: "mid", created_at: "2026-05-01T00:00:00.000Z" }), identityThumb);

    const merged = mergeCatalog([[older, middle], [newest]]);

    expect(merged.map((entry) => entry.id)).toEqual(["new", "mid", "old"]);
  });

  it("is non-destructive — the input arrays keep their original order", () => {
    const first = cartToEntry(makeCart({ id: "a", created_at: "2026-01-01T00:00:00.000Z" }), identityThumb);
    const second = cartToEntry(makeCart({ id: "b", created_at: "2026-06-01T00:00:00.000Z" }), identityThumb);
    const source = [first, second];

    mergeCatalog([source]);

    expect(source.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("filterByRuntime", () => {
  const entries = [
    cartToEntry(makeCart({ id: "pro", console_model: "pro" }), identityThumb),
    cartToEntry(makeCart({ id: "classic", console_model: "classic" }), identityThumb),
    titleToEntry(makeTitle({ id: "wasm", runtime: "wasm-app" }), identityThumb),
  ];

  it("narrows to entries served by the requested runtime", () => {
    expect(filterByRuntime(entries, "wasm-app").map((entry) => entry.id)).toEqual(["wasm"]);
  });

  it("returns the whole catalog when no runtime is requested", () => {
    expect(filterByRuntime(entries, undefined)).toHaveLength(entries.length);
    expect(filterByRuntime(entries, null)).toHaveLength(entries.length);
  });

  it("falls back to the whole catalog for an unrecognised runtime", () => {
    // A stale or hand-typed query string should not blank the page.
    expect(filterByRuntime(entries, "nintendo-64")).toHaveLength(entries.length);
  });

  it("returns nothing for a known runtime with no entries, so the empty state shows", () => {
    expect(filterByRuntime(entries, "dos")).toEqual([]);
  });
});

describe("formatPrice", () => {
  it("names the free case instead of printing a zero amount", () => {
    expect(formatPrice(0)).toBe("Free");
  });

  it("renders cents as a two-decimal amount", () => {
    expect(formatPrice(250)).toBe("$2.50");
    expect(formatPrice(1)).toBe("$0.01");
  });
});

// ---------------------------------------------------------------------------
// Runtime registry
// ---------------------------------------------------------------------------

describe("runtime registry", () => {
  it("describes every declared runtime exactly once", () => {
    const described = runtimeDescriptors().map((runtime) => runtime.id);
    expect(described).toEqual([...RUNTIME_IDS]);
    expect(new Set(described).size).toBe(RUNTIME_IDS.length);
  });

  it("resolves an unknown runtime to undefined rather than a default engine", () => {
    // Booting the wrong engine would fail obscurely; "cannot play this" is the
    // honest outcome.
    expect(resolveRuntime("libretro-but-not")).toBeUndefined();
    expect(resolveRuntime(null)).toBeUndefined();
    expect(resolveRuntime("")).toBeUndefined();
  });

  it("recognises every declared runtime id", () => {
    for (const id of RUNTIME_IDS) {
      expect(isRuntimeId(id)).toBe(true);
      expect(resolveRuntime(id)?.id).toBe(id);
    }
  });

  it("reports the Cartbox runtimes plus the ported-game, ScummVM, SuperTux and DOS runtimes as implemented", () => {
    // libretro is declared so catalog rows can exist before its player does;
    // wasm-app gained a player in Phase 2, scummvm followed with the ScummVM
    // engine build and its iframe player, supertux with the SuperTux one, and dos
    // with the js-dos/DOSBox iframe player.
    const implemented = implementedRuntimes().map((runtime) => runtime.id);
    expect(implemented).toEqual([
      "cartbox-classic",
      "cartbox-pro",
      "wasm-app",
      "scummvm",
      "supertux",
      "dos",
    ]);
  });

  it("gives a console model to the Cartbox runtimes and to nothing else", () => {
    // consoleModel selects one of our own cores, so a ported game must not carry
    // one — that field is what would otherwise boot a cart engine for it.
    for (const runtime of runtimeDescriptors()) {
      const isCartboxRuntime = runtime.id.startsWith("cartbox-");
      expect(runtime.consoleModel !== undefined).toBe(isCartboxRuntime);
    }
  });

  it("flags only user-supplied assets as needing the player's own game data", () => {
    expect(requiresUserAssets("user-supplied")).toBe(true);
    expect(requiresUserAssets("bundled")).toBe(false);
    expect(requiresUserAssets("freeware-fetch")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Licensing — including agreement with the database
// ---------------------------------------------------------------------------

describe("license classification", () => {
  /**
   * Extracts the license ids from `license_permits_commercial()` in the real
   * migration. The database is authoritative for enforcement and the TypeScript
   * list only gates the UI, so the two must not drift.
   */
  function licenseIdsFromMigration(): string[] {
    const functionBody = migrationSql.split("license_permits_commercial")[1] ?? "";
    const selectClause = functionBody.slice(0, functionBody.indexOf("$$;"));
    return [...selectClause.matchAll(/'([a-z0-9.-]+)'/g)].map((match) => match[1]);
  }

  it("matches the database's commercial-license list exactly", () => {
    expect(licenseIdsFromMigration().sort()).toEqual([...COMMERCIAL_LICENSE_IDS].sort());
  });

  it("permits pricing under each license the database allows", () => {
    for (const license of licenseIdsFromMigration()) {
      expect(licensePermitsCommercial(license)).toBe(true);
    }
  });

  it("refuses pricing for non-commercial licenses", () => {
    expect(licensePermitsCommercial("cc-by-nc-4.0")).toBe(false);
    expect(licensePermitsCommercial("cc-by-nc-sa-4.0")).toBe(false);
  });

  it("refuses pricing for an unknown license rather than assuming permission", () => {
    // Defaulting to "no" means an unrecognised license blocks a listing instead
    // of silently breaching someone's terms.
    expect(licensePermitsCommercial("some-bespoke-eula")).toBe(false);
    expect(licensePermitsCommercial("")).toBe(false);
  });

  it("requires a source offer for copyleft licenses only", () => {
    expect(requiresSourceOffer("gpl-3.0")).toBe(true);
    expect(requiresSourceOffer("lgpl-2.1")).toBe(true);
    expect(requiresSourceOffer("mit")).toBe(false);
    expect(requiresSourceOffer("cc0-1.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claim authority
// ---------------------------------------------------------------------------

describe("listing authority", () => {
  it("lets any active claim edit the listing", () => {
    const subordinate = makeClaim({ isPrimary: false, grantedBy: "profile-1" });
    expect(canEditListing(subordinate).allowed).toBe(true);
    expect(canEditListing(makeClaim()).allowed).toBe(true);
  });

  it("denies editing on a claim that is not active", () => {
    for (const status of ["pending", "suspended", "revoked"] as const) {
      const decision = canEditListing(makeClaim({ status }));
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).toContain(status);
    }
  });

  it("restricts steward management to the primary claimant", () => {
    expect(canManageStewards(makeClaim()).allowed).toBe(true);
    expect(canManageStewards(makeClaim({ isPrimary: false, grantedBy: "profile-1" })).allowed).toBe(false);
  });
});

describe("revocation", () => {
  const primary = makeClaim();
  const subordinate = makeClaim({ profileId: "profile-2", isPrimary: false, grantedBy: "profile-1" });

  it("lets the primary revoke a subordinate", () => {
    expect(canRevokeClaim(primary, subordinate).allowed).toBe(true);
  });

  it("does not let a subordinate revoke anyone", () => {
    expect(canRevokeClaim(subordinate, primary).allowed).toBe(false);
  });

  it("routes ending a primary claim through review, not revocation", () => {
    const other = makeClaim({ profileId: "profile-3", isPrimary: true });
    expect(canRevokeClaim(primary, other).allowed).toBe(false);
  });

  it("refuses to act across titles", () => {
    const foreign = makeClaim({ titleId: "title-2", profileId: "profile-9", isPrimary: false, grantedBy: "x" });
    expect(canRevokeClaim(primary, foreign).allowed).toBe(false);
  });
});

describe("pricing authority", () => {
  const commercialTitle: ClaimableTitle = { id: "title-1", tier: "A", license: "gpl-3.0" };
  const rightsholder = makeClaim({ level: "rightsholder" });

  it("allows a price for an active rightsholder primary on a commercial license", () => {
    expect(canSetPrice(rightsholder, commercialTitle).allowed).toBe(true);
  });

  it("refuses a price at steward level", () => {
    const decision = canSetPrice(makeClaim({ level: "steward" }), commercialTitle);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/rightsholder/);
  });

  it("never delegates pricing to a subordinate, even at rightsholder level", () => {
    // The rule that stops a delegated steward from becoming a payee.
    const subordinate = makeClaim({ level: "rightsholder", isPrimary: false, grantedBy: "profile-1" });
    const decision = canSetPrice(subordinate, commercialTitle);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/does not delegate/);
  });

  it("refuses a price on publisher freeware, which grants redistribution not resale", () => {
    const freeware: ClaimableTitle = { id: "title-1", tier: "B", license: "mit" };
    expect(canSetPrice(rightsholder, freeware).allowed).toBe(false);
  });

  it("refuses a price under a non-commercial license", () => {
    const nonCommercial: ClaimableTitle = { id: "title-1", tier: "A", license: "cc-by-nc-4.0" };
    const decision = canSetPrice(rightsholder, nonCommercial);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("cc-by-nc-4.0");
  });

  it("refuses a price on a suspended claim, so a dispute parks the money", () => {
    expect(canSetPrice(makeClaim({ level: "rightsholder", status: "suspended" }), commercialTitle).allowed).toBe(false);
  });

  it("never permits self-escalation to rightsholder", () => {
    expect(canSelfEscalate().allowed).toBe(false);
  });
});

describe("succession", () => {
  const policy: SuccessionPolicy = {
    inactivityMs: 180 * 24 * 60 * 60 * 1000,
    noticeMs: 30 * 24 * 60 * 60 * 1000,
  };
  const filedAt = new Date("2026-07-01T00:00:00.000Z");
  const incumbent = makeClaim({ level: "rightsholder", lastActiveAt: new Date("2025-01-01T00:00:00.000Z") });
  const subordinate = makeClaim({ profileId: "profile-2", isPrimary: false, grantedBy: "profile-1" });

  it("lets a subordinate file once the incumbent has passed the inactivity window", () => {
    const now = new Date(incumbent.lastActiveAt.getTime() + policy.inactivityMs + 1);
    expect(canFileTransferClaim(subordinate, incumbent, now, policy).allowed).toBe(true);
  });

  it("refuses to open a transfer while the incumbent is still active", () => {
    const now = new Date(incumbent.lastActiveAt.getTime() + policy.inactivityMs - 1);
    expect(canFileTransferClaim(subordinate, incumbent, now, policy).allowed).toBe(false);
  });

  it("does not let the primary file against itself", () => {
    const now = new Date(incumbent.lastActiveAt.getTime() + policy.inactivityMs + 1);
    expect(canFileTransferClaim(incumbent, incumbent, now, policy).allowed).toBe(false);
  });

  it("closes the notice window only after it has fully elapsed", () => {
    const justBefore = new Date(filedAt.getTime() + policy.noticeMs - 1);
    const justAfter = new Date(filedAt.getTime() + policy.noticeMs);
    expect(isNoticeWindowClosed(filedAt, incumbent, justBefore, policy)).toBe(false);
    expect(isNoticeWindowClosed(filedAt, incumbent, justAfter, policy)).toBe(true);
  });

  it("lapses the claim when the incumbent responds within the notice window", () => {
    // Responding is all it takes to retain primary status.
    const responded = makeClaim({ lastActiveAt: new Date(filedAt.getTime() + 1) });
    const wellAfter = new Date(filedAt.getTime() + policy.noticeMs * 10);
    expect(isNoticeWindowClosed(filedAt, responded, wellAfter, policy)).toBe(false);
  });

  it("promotes a successor at steward level regardless of what the outgoing primary held", () => {
    // Load-bearing: otherwise outlasting a maintainer becomes a route to
    // charging money for someone else's game.
    const promoted = promoteToPrimary(subordinate);
    expect(promoted.isPrimary).toBe(true);
    expect(promoted.level).toBe("steward");
    expect(promoted.status).toBe("active");
    expect(promoted.grantedBy).toBeNull();
  });

  it("leaves a promoted successor unable to set a price", () => {
    const promoted = promoteToPrimary(subordinate);
    const title: ClaimableTitle = { id: "title-1", tier: "A", license: "mit" };
    expect(canSetPrice(promoted, title).allowed).toBe(false);
  });

  it("revokes rather than deletes the outgoing primary, keeping the grant chain", () => {
    const forfeited = forfeitPrimary(incumbent);
    expect(forfeited.isPrimary).toBe(false);
    expect(forfeited.status).toBe("revoked");
    expect(forfeited.profileId).toBe(incumbent.profileId);
  });
});

// ---------------------------------------------------------------------------
// Seed data must satisfy the same rules as production rows
// ---------------------------------------------------------------------------

describe("demo titles", () => {
  it("declares a runtime the registry knows", () => {
    for (const title of DEMO_TITLES) {
      expect(resolveRuntime(title.runtime)).toBeDefined();
    }
  });

  it("ships no assets for any Tier C title", () => {
    // Tier C exists precisely because we may not distribute the game data.
    for (const title of DEMO_TITLES.filter((entry) => entry.tier === "C")) {
      expect(title.assetSource).toBe("user-supplied");
    }
  });

  it("gives every copyleft title a source link, satisfying the source offer", () => {
    for (const title of DEMO_TITLES.filter((entry) => requiresSourceOffer(entry.license))) {
      expect(title.sourceUrl).toBeTruthy();
    }
  });

  it("uses unique ids and slugs", () => {
    expect(new Set(DEMO_TITLES.map((title) => title.id)).size).toBe(DEMO_TITLES.length);
    expect(new Set(DEMO_TITLES.map((title) => title.slug)).size).toBe(DEMO_TITLES.length);
  });
});

// ---------------------------------------------------------------------------
// Migration invariants
// ---------------------------------------------------------------------------

describe("migration 0011", () => {
  it("enforces one primary claim per title with a partial unique index", () => {
    // A check constraint sees one row at a time and cannot express this.
    expect(migrationSql).toMatch(/create unique index[\s\S]*?title_claims \(title_id\)[\s\S]*?where is_primary/);
  });

  it("guards pricing with a trigger, since the rule spans two tables", () => {
    expect(migrationSql).toContain("assert_title_pricing_authority");
    expect(migrationSql).toMatch(/before insert or update of price_cents on titles/);
  });

  it("reverts a price when rightsholder authority is lost", () => {
    expect(migrationSql).toContain("revert_price_on_claim_change");
    expect(migrationSql).toMatch(/update titles set price_cents = 0/);
  });

  it("ties a purchase to exactly one of a cart or a title", () => {
    expect(migrationSql).toMatch(/check \(\(cart_id is null\) <> \(title_id is null\)\)/);
  });

  it("keeps Tier C titles off our storage and Tier B titles free", () => {
    expect(migrationSql).toContain("titles_tier_c_is_user_supplied");
    expect(migrationSql).toContain("titles_freeware_is_free");
  });
});
