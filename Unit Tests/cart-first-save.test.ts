/**
 * First-save cart creation tests. /edit/new mints a cart id with no database
 * row; the first save must create that row itself. These tests exercise the
 * pure builder the save route uses, asserting the invariants the schema and
 * the Browse page depend on rather than snapshotting constants:
 *   - Save creates a private draft; only Publish lists it in Browse (upgrade #5)
 *   - the slug stays unique per owner (schema: unique (owner_id, slug)) even
 *     when many carts share the default title
 *   - the r2_key matches the `carts/<id>.tic` layout the play page serves from
 *   - untrusted model ids resolve to a real console model
 * Plus the id gate that keeps arbitrary URL segments out of the database.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CART_TITLE,
  buildDefaultProfileRow,
  buildNewCartRow,
  isValidCartId,
} from "../apps/web/src/lib/cartDraft";
import { slugify } from "../apps/web/src/lib/slug";

describe("isValidCartId", () => {
  it("accepts ids minted the way /edit/new mints them", () => {
    expect(isValidCartId(randomUUID())).toBe(true);
  });

  it("accepts uppercase UUIDs", () => {
    expect(isValidCartId(randomUUID().toUpperCase())).toBe(true);
  });

  const junk = ["new", "", "1234", "../secrets", "carts/evil.tic", `${randomUUID()}x`];
  for (const value of junk) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(isValidCartId(value)).toBe(false);
    });
  }
});

describe("buildNewCartRow", () => {
  const ownerId = randomUUID();

  it("creates a private draft on a plain Save, and publishes only when asked", () => {
    // A first Save (no publish flag) keeps the new cart unlisted so an untitled
    // work-in-progress does not appear in Browse the moment it is saved.
    expect(buildNewCartRow({ cartId: randomUUID(), ownerId }).published).toBe(false);
    expect(buildNewCartRow({ cartId: randomUUID(), ownerId, published: false }).published).toBe(false);
    // A first Publish creates it live.
    expect(buildNewCartRow({ cartId: randomUUID(), ownerId, published: true }).published).toBe(true);
  });

  it("stores bytes under the carts/<id>.tic key the play page expects", () => {
    const cartId = randomUUID();
    const row = buildNewCartRow({ cartId, ownerId });
    expect(row.r2_key).toBe(`carts/${cartId}.tic`);
    expect(row.id).toBe(cartId);
    expect(row.owner_id).toBe(ownerId);
  });

  it("falls back to the default title when none is given or it is blank", () => {
    expect(buildNewCartRow({ cartId: randomUUID(), ownerId }).title).toBe(DEFAULT_CART_TITLE);
    expect(buildNewCartRow({ cartId: randomUUID(), ownerId, title: "   " }).title).toBe(DEFAULT_CART_TITLE);
  });

  it("uses and trims a provided title", () => {
    const row = buildNewCartRow({ cartId: randomUUID(), ownerId, title: "  Neon City  " });
    expect(row.title).toBe("Neon City");
    expect(row.slug.startsWith(slugify("Neon City"))).toBe(true);
  });

  it("keeps slugs distinct across carts that share the default title", () => {
    const first = buildNewCartRow({ cartId: randomUUID(), ownerId });
    const second = buildNewCartRow({ cartId: randomUUID(), ownerId });
    expect(first.slug).not.toBe(second.slug);
  });

  it("resolves the console model, falling back to classic for junk", () => {
    expect(buildNewCartRow({ cartId: randomUUID(), ownerId, model: "pro" }).console_model).toBe("pro");
    expect(buildNewCartRow({ cartId: randomUUID(), ownerId, model: "hacked" }).console_model).toBe("classic");
    expect(buildNewCartRow({ cartId: randomUUID(), ownerId }).console_model).toBe("classic");
  });
});

describe("buildDefaultProfileRow", () => {
  it("keys the profile to the auth user id", () => {
    const userId = randomUUID();
    expect(buildDefaultProfileRow(userId).id).toBe(userId);
  });

  it("derives distinct handles for distinct users", () => {
    const first = buildDefaultProfileRow(randomUUID());
    const second = buildDefaultProfileRow(randomUUID());
    expect(first.handle).not.toBe(second.handle);
  });

  it("is deterministic, so a save retry builds the same profile", () => {
    const userId = randomUUID();
    expect(buildDefaultProfileRow(userId)).toEqual(buildDefaultProfileRow(userId));
  });
});
