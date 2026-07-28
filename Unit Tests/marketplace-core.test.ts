/**
 * Unit tests for the pure marketplace logic introduced across Phases 2–5:
 *   - slug generation (Phase 2)
 *   - platform fee / creator net split (Phase 3)
 *   - export planning (Phase 4)
 *   - jam scheduling (Phase 5)
 *
 * As with the player tests, expected values are derived from invariants
 * (fee + net === amount, aspect of slug rules, status boundaries) rather than
 * copied constants, so the tests assert behaviour, not a snapshot.
 *
 * Run with: npx vitest run "Unit Tests/marketplace-core.test.ts"
 */

import { describe, expect, it } from "vitest";

import { slugify } from "../apps/web/src/lib/slug";
import { jamStatus, isSubmissionOpen } from "../apps/web/src/lib/jam";
import {
  DEFAULT_PLATFORM_FEE_BPS,
  computeCreatorNet,
  computePlatformFee,
} from "../services/payments/src/pricing";
import { buildExportPlan, type ExportTarget } from "../apps/desktop/src/export";

describe("slugify", () => {
  it("lowercases, trims, and collapses non-alphanumerics to single hyphens", () => {
    const slug = slugify("  Hello,   World!!  ");
    expect(slug).toBe("hello-world");
  });

  it("folds diacritics to ASCII", () => {
    expect(slugify("Pokémon Café")).toBe("pokemon-cafe");
  });

  it("never returns an empty string, even for symbol-only input", () => {
    expect(slugify("★★★")).toBe("untitled");
    expect(slugify("🎮")).toBe("untitled");
  });

  it("produces a slug with no leading or trailing hyphen", () => {
    const slug = slugify("---Edge---");
    expect(slug.startsWith("-")).toBe(false);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("pricing", () => {
  const amounts = [0, 1, 99, 100, 499, 1500, 9999];

  it("always splits an amount exactly into fee + net (no lost cents)", () => {
    for (const amount of amounts) {
      const fee = computePlatformFee(amount);
      const net = computeCreatorNet(amount);
      expect(fee + net).toBe(amount);
    }
  });

  it("keeps the fee within [0, amount]", () => {
    for (const amount of amounts) {
      const fee = computePlatformFee(amount);
      expect(fee).toBeGreaterThanOrEqual(0);
      expect(fee).toBeLessThanOrEqual(amount);
    }
  });

  it("charges the default take-rate on a round amount", () => {
    // $10.00 at 12% = $1.20; derived from the documented default, not hardcoded.
    const amount = 1000;
    const expectedFee = (amount * DEFAULT_PLATFORM_FEE_BPS) / 10_000;
    expect(computePlatformFee(amount)).toBe(expectedFee);
  });

  it("rejects invalid inputs", () => {
    expect(() => computePlatformFee(-1)).toThrow(RangeError);
    expect(() => computePlatformFee(10.5)).toThrow(RangeError);
    expect(() => computePlatformFee(100, 20_000)).toThrow(RangeError);
  });
});

describe("buildExportPlan", () => {
  it("produces one artifact per unique target, named from the slug", () => {
    const targets: ExportTarget[] = ["web", "windows", "web"]; // duplicate on purpose
    const plan = buildExportPlan("space-blaster", targets);

    expect(plan).toHaveLength(2); // duplicate collapsed
    for (const artifact of plan) {
      expect(artifact.filename.startsWith("space-blaster.")).toBe(true);
    }
    expect(plan.map((a) => a.target).sort()).toEqual(["web", "windows"]);
  });

  it("requires at least one target", () => {
    expect(() => buildExportPlan("slug", [])).toThrow(RangeError);
  });
});

describe("jamStatus", () => {
  const start = new Date("2026-08-01T00:00:00Z");
  const end = new Date("2026-08-08T00:00:00Z");

  it("labels times before, during, and after the window", () => {
    expect(jamStatus(start, end, new Date("2026-07-31T23:59:59Z"))).toBe("upcoming");
    expect(jamStatus(start, end, new Date("2026-08-04T12:00:00Z"))).toBe("open");
    expect(jamStatus(start, end, new Date("2026-08-08T00:00:01Z"))).toBe("closed");
  });

  it("treats the window as inclusive of start and exclusive of end", () => {
    expect(jamStatus(start, end, start)).toBe("open");
    expect(jamStatus(start, end, end)).toBe("closed");
  });

  it("agrees with isSubmissionOpen", () => {
    const during = new Date("2026-08-02T00:00:00Z");
    expect(isSubmissionOpen(start, end, during)).toBe(jamStatus(start, end, during) === "open");
  });

  it("rejects an inverted window", () => {
    expect(() => jamStatus(end, start)).toThrow(RangeError);
  });
});
