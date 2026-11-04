/**
 * The AAA tier's budgets (AAA_PRODUCTION_ROADMAP.md Q2, deviceBudgets.ts):
 * four device classes with a GPU budget per group of the frame graph's
 * passes, beside the fantasy tiers' table, which stays as it was.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AAA_BUDGETS_PROVISIONAL,
  AAA_BUDGET_DEVICES,
  AAA_DEVICE_BUDGETS,
  BUDGET_DEVICES,
  DEVICE_BUDGETS,
  PASS_GROUPS,
  PASS_GROUP_SHARES,
  budgetDevices,
  checkBudget,
  checkPassBudget,
  deviceBudget,
  fitSummary,
  overBudget,
  passGroup,
  smallestFit,
  tierDevice,
} from "@cartbox/editor";

const SCENE_KEYS = ["triangles", "drawCalls", "textureBytes", "meshBytes", "downloadBytes"] as const;

describe("the fantasy tiers' budgets", () => {
  it("are the default, unchanged by the AAA table", () => {
    expect(BUDGET_DEVICES).toEqual(["iphone", "ipad", "desktop"]);
    expect(budgetDevices()).toBe(BUDGET_DEVICES);
    const load = { triangles: 500_000, drawCalls: 100 };
    expect(checkBudget(load, "iphone")).toEqual(checkBudget(load, "iphone", "fantasy"));
    expect(smallestFit(load)).toBe("ipad");
    expect(deviceBudget("ipad")).toBe(DEVICE_BUDGETS.ipad);
  });

  it("check an integrated GPU, which they don't split from the desktop, as the desktop", () => {
    expect(tierDevice("integrated", "fantasy")).toBe("desktop");
    expect(deviceBudget("integrated", "fantasy")).toBe(DEVICE_BUDGETS.desktop);
    expect(checkBudget({ triangles: 1 }, "integrated")[0]!.budget).toBe(DEVICE_BUDGETS.desktop.triangles);
  });
});

describe("the AAA tier's budgets", () => {
  it("cover four classes, smallest first, each larger than the last", () => {
    expect(AAA_BUDGET_DEVICES).toEqual(["iphone", "ipad", "integrated", "desktop"]);
    expect(budgetDevices("aaa")).toBe(AAA_BUDGET_DEVICES);
    for (const key of SCENE_KEYS) {
      for (let i = 1; i < AAA_BUDGET_DEVICES.length; i += 1) {
        expect(AAA_DEVICE_BUDGETS[AAA_BUDGET_DEVICES[i]!][key]).toBeGreaterThan(AAA_DEVICE_BUDGETS[AAA_BUDGET_DEVICES[i - 1]!][key]);
      }
    }
  });

  it("allow more than the fantasy tiers on the same device", () => {
    for (const device of BUDGET_DEVICES) {
      for (const key of SCENE_KEYS) expect(AAA_DEVICE_BUDGETS[device][key]).toBeGreaterThan(DEVICE_BUDGETS[device][key]);
    }
  });

  it("hold AAA_FIDELITY_ROADMAP.md's targets: Epic 1440p60, High 1080p60, Medium at 30 fps on iPad and iPhone", () => {
    const { iphone, ipad, integrated, desktop } = AAA_DEVICE_BUDGETS;
    expect([desktop.level, desktop.resolution, desktop.frameMs]).toEqual(["Epic", "1440p", 1000 / 60]);
    expect([integrated.level, integrated.resolution, integrated.frameMs]).toEqual(["High", "1080p, upscaled", 1000 / 60]);
    expect([ipad.level, ipad.frameMs]).toEqual(["Medium", 1000 / 30]);
    expect([iphone.level, iphone.frameMs]).toEqual(["Medium", 1000 / 30]);
    expect(desktop.downloadBytes).toBeLessThanOrEqual(256 * 1024 * 1024); // the direct-upload ceiling (F9e)
  });

  it("say they are provisional until measured (R1)", () => {
    expect(AAA_BUDGETS_PROVISIONAL).toBe(true);
  });

  it("give every group of passes its share of the frame, leaving a tenth spare", () => {
    const total = PASS_GROUPS.reduce((sum, group) => sum + PASS_GROUP_SHARES[group], 0);
    expect(total).toBeCloseTo(0.9, 10);
    for (const device of AAA_BUDGET_DEVICES) {
      const budget = AAA_DEVICE_BUDGETS[device];
      for (const group of PASS_GROUPS) expect(budget.passMs[group]).toBeCloseTo(budget.frameMs * PASS_GROUP_SHARES[group], 10);
      expect(PASS_GROUPS.reduce((sum, g) => sum + budget.passMs[g], 0)).toBeCloseTo(budget.frameMs * 0.9, 10);
    }
  });

  it("check a scene, and find the smallest class it fits", () => {
    const load = { triangles: 2_000_000, drawCalls: 1500, textureBytes: 600 * 1024 * 1024 };
    expect(overBudget(load, "ipad", "aaa").map((l) => l.key)).toEqual(["triangles", "drawCalls", "textureBytes"]);
    expect(overBudget(load, "integrated", "aaa")).toEqual([]);
    expect(smallestFit(load, "aaa")).toBe("integrated");
    expect(smallestFit(load)).toBe("desktop");
    expect(smallestFit({ triangles: 9_000_000 }, "aaa")).toBeNull();
    expect(checkBudget(load, "desktop", "aaa")[0]!.text).toBe("2000k of 8000k");
  });
});

describe("fitSummary", () => {
  it("names the device with its article, and says when nothing larger is left", () => {
    expect(fitSummary("iphone")).toBe("Fits an iPhone and up.");
    expect(fitSummary("desktop")).toBe("Fits a desktop.");
    expect(fitSummary(null)).toBe("Over even a desktop's budget.");
    expect(fitSummary("integrated", "aaa")).toBe("Fits an integrated GPU and up.");
    expect(fitSummary("desktop", "aaa")).toBe("Fits a discrete GPU.");
    expect(fitSummary(null, "aaa")).toBe("Over even a discrete GPU's budget.");
  });
});

describe("passGroup", () => {
  it("sorts a pass by its name, a sub-pass by its root, the presenter's without its prefix", () => {
    expect(passGroup("cull.clusters.occlusion")).toBe("culling");
    expect(passGroup("virtual shadows")).toBe("shadows");
    expect(passGroup("vsm.mark")).toBe("shadows");
    expect(passGroup("opaque")).toBe("shading");
    expect(passGroup("ssgi.accumulate")).toBe("lighting");
    expect(passGroup("reflections.copy")).toBe("lighting");
    expect(passGroup("volumetric fog")).toBe("atmosphere");
    expect(passGroup("present: compose and tone map")).toBe("post");
    expect(passGroup("present: post")).toBe("post");
    expect(passGroup("readback")).toBe("other");
    expect(passGroup("something new")).toBe("other");
  });

  it("sorts every pass the renderer declares, so a new one can't hide in Other", () => {
    const root = fileURLToPath(new URL("../packages/player/src", import.meta.url));
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
    const names = new Set<string>();
    for (const file of sources(root)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
        if (!/\b(addPass|scenePass|blurPass)\(\s*(?!name\b)/.test(code)) continue;
        if (/\b(addPass|scenePass|blurPass)\(name: string/.test(code)) continue;
        for (const match of code.matchAll(/"([^"]+)"/g)) {
          if (!["render", "compute", "transfer"].includes(match[1]!)) names.add(match[1]!);
        }
      }
    }
    expect(names.size).toBeGreaterThan(50);
    for (const kept of ["opaque", "see-through", "sss.across", "compose and tone map", "compose", "taa.resolve", "virtual shadows"]) expect(names).toContain(kept);
    const unsorted = [...names].filter((name) => passGroup(name) === "other" && name !== "readback");
    expect(unsorted).toEqual([]);
  });
});

describe("checkPassBudget", () => {
  it("sums each group's passes against its budget, in the groups' order, leaving out groups that didn't run", () => {
    const budget = AAA_DEVICE_BUDGETS.desktop;
    const lines = checkPassBudget(
      [
        { name: "present: post", ms: 0.5 },
        { name: "opaque", ms: 3 },
        { name: "virtual shadows", ms: 2 },
        { name: "vsm.resolve", ms: 1 },
        { name: "see-through", ms: 1.2 },
        { name: "present: compose", ms: Number.NaN },
        { name: "taa.resolve", ms: -0.1 },
      ],
      "desktop",
    );
    expect(lines.map((l) => l.group)).toEqual(["shadows", "shading", "post"]);
    const [shadows, shading, post] = lines;
    expect(shadows!.ms).toBeCloseTo(3, 10);
    expect(shadows!.budget).toBeCloseTo(budget.passMs.shadows, 10);
    expect(shadows!.over).toBe(true); // 3 ms against 14% of 16.7 ms
    expect(shadows!.passes).toEqual(["virtual shadows", "vsm.resolve"]);
    expect(shading!.ms).toBeCloseTo(4.2, 10);
    expect(shading!.over).toBe(false);
    expect(post!.ms).toBeCloseTo(0.5, 10); // NaN left out, a negative time counted as none
    expect(post!.passes).toEqual(["present: post", "taa.resolve"]);
    expect(shadows!.text).toBe(`3.00 ms of ${budget.passMs.shadows.toFixed(2)} ms`);
  });

  it("holds a phone to twice a desktop's milliseconds, at 30 fps", () => {
    const [phone] = checkPassBudget([{ name: "opaque", ms: 5 }], "iphone");
    const [desk] = checkPassBudget([{ name: "opaque", ms: 5 }], "desktop");
    expect(phone!.budget).toBeCloseTo(desk!.budget * 2, 10);
    expect(phone!.over).toBe(false);
    expect(desk!.over).toBe(true);
  });
});
