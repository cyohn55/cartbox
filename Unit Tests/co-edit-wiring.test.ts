/**
 * Co-editing wired into the editor (AAA_PRODUCTION_ROADMAP.md W2): the
 * realtime transport's parts, the Supabase channel transport (against a fake
 * Realtime hub), and what the editor's hook applies.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { CoEditSession, type CoEditMessage } from "@/lib/coEdit";
import { CoEditAssembler, splitCoEditMessage, supabaseCoEditTransport, type CoEditPart } from "@/lib/coEditRealtime";
import { SIDECAR_KEYS, type Sidecars } from "@/lib/sidecars";
import { changedSidecarKeys } from "../apps/web/src/app/edit/[cartId]/useCoEdit";

const EMPTY = Object.fromEntries(SIDECAR_KEYS.map((key) => [key, null])) as unknown as Sidecars;
const withMesh = (meshes: object[], extra: object = {}): Sidecars => ({ ...EMPTY, mesh: JSON.stringify({ version: 2, ...extra, meshes }) }) as Sidecars;
const meshIds = (s: Sidecars) => (JSON.parse(s.mesh as string) as { meshes: { id: string; v?: number }[] }).meshes.map((m) => `${m.id}${m.v ?? ""}`);

describe("messages in parts", () => {
  const big: CoEditMessage = { kind: "ops", from: "a", ops: [["mesh:rock", JSON.stringify({ id: "rock", data: "x".repeat(25_000) }), 3, "a"]] };

  it("splits a message into parts and puts it back in any order", () => {
    const parts = splitCoEditMessage(big, 4000, "m1");
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every((p) => p.s.length <= 4000 && p.n === parts.length && p.id === "m1")).toBe(true);
    const a = new CoEditAssembler();
    const shuffled = [...parts].reverse();
    const results = shuffled.map((p) => a.add(p));
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
    expect(results.at(-1)).toEqual(big);
    expect(a.waiting).toBe(0);
  });

  it("ignores repeated and malformed parts, and drops a message whose parts stop coming", () => {
    let t = 0;
    const a = new CoEditAssembler(1000, () => t);
    const parts = splitCoEditMessage(big, 10_000, "m2");
    expect(a.add(parts[0]!)).toBeNull();
    expect(a.add(parts[0]!)).toBeNull(); // a repeat counts once
    expect(a.add({ id: "x", i: 5, n: 2, s: "" })).toBeNull();
    expect(a.add({ id: "x", i: 0, n: 0, s: "" })).toBeNull();
    expect(a.add(null as unknown as CoEditPart)).toBeNull();
    expect(a.waiting).toBe(1);
    t = 5000;
    a.add({ id: "other", i: 0, n: 2, s: "{" });
    expect(a.waiting).toBe(1); // m2 was dropped; only "other" waits
  });

  it("sends a small message whole", () => {
    expect(splitCoEditMessage({ kind: "hello", from: "a" })).toHaveLength(1);
  });
});

/** A fake Realtime: channels by topic, broadcast to every other subscriber, each part as its own message. */
function fakeRealtime(maxPayloadChars = 120_000) {
  const subscribers = new Map<string, Set<{ deliver: (payload: unknown) => void }>>();
  let sent = 0;
  let removed = 0;
  const client = {
    channel(topic: string) {
      let handler: ((m: { payload: unknown }) => void) | null = null;
      const self = {
        deliver: (payload: unknown) => handler?.({ payload }),
      };
      const channel = {
        on(_type: string, _filter: unknown, h: (m: { payload: unknown }) => void) {
          handler = h;
          return channel;
        },
        subscribe(cb: (status: string) => void) {
          if (!subscribers.has(topic)) subscribers.set(topic, new Set());
          subscribers.get(topic)!.add(self);
          queueMicrotask(() => cb("SUBSCRIBED"));
          return channel;
        },
        async send({ payload }: { payload: unknown }) {
          sent += 1;
          expect(JSON.stringify(payload).length).toBeLessThan(maxPayloadChars);
          for (const s of subscribers.get(topic) ?? []) if (s !== self) queueMicrotask(() => s.deliver(structuredClone(payload)));
          return "ok";
        },
        _self: self,
        _topic: topic,
      };
      return channel;
    },
    async removeChannel(channel: { _self: object; _topic: string }) {
      removed += 1;
      subscribers.get(channel._topic)?.delete(channel._self as never);
      return "ok";
    },
  };
  return { client: client as unknown as SupabaseClient, sent: () => sent, removed: () => removed };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe("co-editing over the hosted channel", () => {
  it("brings a newcomer up to date and carries large objects both ways, in parts", async () => {
    const hub = fakeRealtime();
    const start = withMesh([{ id: "a" }, { id: "b" }]);
    const ta = supabaseCoEditTransport(hub.client, "cart1");
    const seenA: Sidecars[] = [];
    const a = new CoEditSession("pa", ta, start, EMPTY, (s) => seenA.push(s));
    await ta.ready;
    // A big edit before b joins: an object with 300 KB of geometry.
    const heavy = { id: "a", v: 2, geometry: "g".repeat(300_000) };
    a.edit(withMesh([heavy, { id: "b" }]));

    const tb = supabaseCoEditTransport(hub.client, "cart1");
    const seenB: Sidecars[] = [];
    const b = new CoEditSession("pb", tb, start, EMPTY, (s) => seenB.push(s));
    await tb.ready;
    await settle();
    expect(seenB.length).toBeGreaterThan(0);
    expect(meshIds(b.sidecars())).toEqual(["a2", "b"]);
    expect(hub.sent()).toBeGreaterThan(3); // the catch-up went in parts

    // b edits another object; a hears it.
    b.edit(withMesh([heavy, { id: "b", v: 7 }]));
    await settle();
    expect(meshIds(a.sidecars())).toEqual(["a2", "b7"]);
    expect(seenA.length).toBe(1);

    // Another cart's channel hears nothing.
    const tc = supabaseCoEditTransport(hub.client, "cart2");
    const seenC: Sidecars[] = [];
    new CoEditSession("pc", tc, start, EMPTY, (s) => seenC.push(s));
    await tc.ready;
    b.edit(withMesh([heavy, { id: "b", v: 8 }]));
    await settle();
    expect(seenC).toEqual([]);

    ta.close();
    tb.close();
    tc.close();
    expect(hub.removed()).toBe(3);
  });

  it("holds what's sent before the channel opens until it does", async () => {
    const hub = fakeRealtime();
    const tb = supabaseCoEditTransport(hub.client, "cart");
    const got: CoEditMessage[] = [];
    tb.onMessage((m) => got.push(m));
    await tb.ready;
    const ta = supabaseCoEditTransport(hub.client, "cart");
    ta.send({ kind: "hello", from: "early" }); // before SUBSCRIBED
    expect(got).toEqual([]);
    await ta.ready;
    await settle();
    expect(got).toEqual([{ kind: "hello", from: "early" }]);
  });
});

describe("what the editor applies", () => {
  it("changes only the layers that differ, reading a reordered scene as the same", () => {
    const a = { ...withMesh([{ id: "x", n: 1 }], { lighting: { sun: 1 } }), fx: { bloom: 1 } } as unknown as Sidecars;
    const reordered = { ...a, mesh: JSON.stringify({ meshes: [{ n: 1, id: "x" }], lighting: { sun: 1 }, version: 2 }) } as Sidecars;
    expect(changedSidecarKeys(a, reordered)).toEqual([]);
    const moved = { ...a, mesh: JSON.stringify({ version: 2, lighting: { sun: 1 }, meshes: [{ id: "x", n: 2 }] }), fx: { bloom: 2 } } as unknown as Sidecars;
    expect(changedSidecarKeys(a, moved).sort()).toEqual(["fx", "mesh"]);
    expect(changedSidecarKeys(a, { ...a, fx: null } as Sidecars)).toEqual(["fx"]);
  });

  it("settles two editors on the same cart when each applies what the other merged", async () => {
    const hub = fakeRealtime();
    const start = withMesh([{ id: "a" }, { id: "b" }]);
    // Each editor's own copy of the cart, set as the hook sets it (layer by layer, only what changed).
    const carts = { a: start, b: start };
    const editor = (who: "a" | "b") => {
      const t = supabaseCoEditTransport(hub.client, "cart");
      const s = new CoEditSession(`p${who}`, t, start, EMPTY, (merged) => {
        const next = { ...carts[who] } as Record<string, unknown>;
        for (const key of changedSidecarKeys(carts[who], merged)) next[key] = merged[key];
        carts[who] = next as Sidecars;
        s.edit(carts[who]); // the hook's effect: a merged change goes out as nothing
      });
      return { t, s };
    };
    const A = editor("a");
    const B = editor("b");
    await Promise.all([A.t.ready, B.t.ready]);
    const sentBefore = hub.sent();
    carts.a = withMesh([{ id: "a", v: 1 }, { id: "b" }]);
    A.s.edit(carts.a);
    carts.b = withMesh([{ id: "a" }, { id: "b", v: 2 }]);
    B.s.edit(carts.b);
    await settle();
    expect(meshIds(carts.a)).toEqual(["a1", "b2"]);
    expect(meshIds(carts.b)).toEqual(["a1", "b2"]);
    expect(hub.sent() - sentBefore).toBe(2); // the two edits, and no echo
  });
});
