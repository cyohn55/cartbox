/**
 * Rig persistence tests. They exercise the server-safe wire validator (parseRig)
 * against malformed input, and — the load-bearing check — prove that a rig built
 * with the editor package's own helpers survives a JSON round-trip through the
 * validator unchanged. That guards against drift between the editor's SpriteRig
 * model and the web app's WireRig shape, which live in separate packages on
 * purpose (server code must not import the editor barrel).
 */

import { describe, expect, it } from "vitest";
import {
  emptySpriteRig,
  upsertRigPart,
  DEFAULT_RIG_UNITS_PER_PIXEL,
} from "@cartbox/editor";

import { parseRig, MAX_RIG_PARTS, type WireRigPart } from "../apps/web/src/lib/rig";

function validPart(overrides: Partial<WireRigPart> = {}): WireRigPart {
  return {
    name: "torso",
    page: 0,
    baseTile: 1,
    blockTiles: 1,
    depthOffset: 0,
    offsetX: 0,
    offsetY: 0,
    unitsPerPixel: DEFAULT_RIG_UNITS_PER_PIXEL,
    ...overrides,
  };
}

function validRig(parts: WireRigPart[] = [validPart()]) {
  return { parts, pivotDepth: 10, colorKey: 0 };
}

describe("parseRig accepts well-formed rigs", () => {
  it("returns an equivalent rig for valid input", () => {
    const rig = validRig([validPart({ name: "cape", depthOffset: 6 }), validPart({ name: "foreArm", depthOffset: -4 })]);
    expect(parseRig(rig)).toEqual(rig);
  });

  it("accepts an empty parts list", () => {
    expect(parseRig(validRig([]))).toEqual({ parts: [], pivotDepth: 10, colorKey: 0 });
  });
});

describe("parseRig rejects malformed input", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["a non-object", 42],
    ["missing parts", { pivotDepth: 10, colorKey: 0 }],
    ["parts not an array", { parts: {}, pivotDepth: 10, colorKey: 0 }],
    ["too many parts", validRig(Array.from({ length: MAX_RIG_PARTS + 1 }, (_v, i) => validPart({ name: `p${i}` })))],
    ["a bad page", validRig([validPart({ page: 3 as WireRigPart["page"] })])],
    ["a base tile out of range", validRig([validPart({ baseTile: 999 })])],
    ["a non-integer base tile", validRig([validPart({ baseTile: 1.5 })])],
    ["an unsupported block size", validRig([validPart({ blockTiles: 3 })])],
    ["a non-positive unitsPerPixel", validRig([validPart({ unitsPerPixel: 0 })])],
    ["a non-finite depth", validRig([validPart({ depthOffset: Number.POSITIVE_INFINITY })])],
    ["duplicate part names", validRig([validPart({ name: "torso" }), validPart({ name: "torso" })])],
    ["a zero pivot depth", { parts: [validPart()], pivotDepth: 0, colorKey: 0 }],
    ["a colour key out of range", { parts: [validPart()], pivotDepth: 10, colorKey: 99 }],
  ];

  for (const [label, input] of cases) {
    it(`rejects ${label}`, () => {
      expect(parseRig(input)).toBeNull();
    });
  }
});

describe("editor rig round-trips through the wire validator", () => {
  it("survives JSON serialisation unchanged", () => {
    let rig = emptySpriteRig();
    rig = upsertRigPart(rig, {
      name: "foreArm",
      page: 0,
      baseTile: 5,
      blockTiles: 2,
      depthOffset: -4,
      offsetX: 0,
      offsetY: 0,
      unitsPerPixel: DEFAULT_RIG_UNITS_PER_PIXEL,
    });

    const wire = JSON.parse(JSON.stringify(rig));
    const parsed = parseRig(wire);

    // The editor model and the wire shape must agree field-for-field.
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(rig);
  });
});
