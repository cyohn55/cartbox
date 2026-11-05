/**
 * Co-editing (AAA_PRODUCTION_ROADMAP.md W2), the engine side: editors of one
 * cart converge on the same sidecars whatever order edits arrive in, keep
 * each other's edits to different objects, see each other, and share locks.
 */
import { describe, expect, it } from "vitest";
import { CoEditSession, sidecarRegisters, sidecarsFromRegisters, type CoEditMessage, type CoEditTransport } from "../apps/web/src/lib/coEdit";
import { emptySidecars, type Sidecars } from "../apps/web/src/lib/sidecars";

/** A hub that queues messages, delivered in order or shuffled. */
function hub() {
  const handlers = new Map<string, (m: CoEditMessage) => void>();
  let queue: { to: string; m: CoEditMessage }[] = [];
  return {
    transport(id: string): CoEditTransport {
      return { send: (m) => { for (const to of handlers.keys()) if (to !== id) queue.push({ to, m }); }, onMessage: (h) => void handlers.set(id, h) };
    },
    flush(shuffle = false) {
      for (let guard = 0; queue.length > 0 && guard < 100; guard += 1) {
        const batch = queue;
        queue = [];
        if (shuffle) batch.reverse();
        for (const { to, m } of batch) handlers.get(to)?.(m);
      }
    },
  };
}

const scene = (objects: Record<string, number>, extra: Partial<Sidecars> = {}): Sidecars =>
  ({ ...emptySidecars(), ...extra, mesh: JSON.stringify({ version: 2, lighting: null, meshes: Object.entries(objects).map(([id, x]) => ({ id, name: id, transform: { position: [x, 0, 0] } })) }) }) as Sidecars;
const xs = (s: Sidecars) => Object.fromEntries((JSON.parse(s.mesh as unknown as string).meshes as { id: string; transform: { position: number[] } }[]).map((m) => [m.id, m.transform.position[0]]));

function three(start: Sidecars) {
  const h = hub();
  const shown = new Map<string, Sidecars>();
  const sessions = ["ana", "ben", "cy"].map((id) => new CoEditSession(id, h.transport(id), start, emptySidecars(), (s) => shown.set(id, s), () => 0));
  h.flush();
  return { h, shown, sessions };
}

describe("the object split", () => {
  it("round-trips sidecars through registers, scene objects one by one in order", () => {
    const s = scene({ door: 1, crate: 2, lamp: 3 });
    const back = sidecarsFromRegisters(sidecarRegisters(s), emptySidecars());
    expect(xs(back)).toEqual({ door: 1, crate: 2, lamp: 3 });
    expect(Object.keys(xs(back))).toEqual(["door", "crate", "lamp"]);
  });
});

describe("co-editing (W2)", () => {
  it("keeps everyone's edits to different objects, and settles the same object the same way everywhere, whatever the order", () => {
    for (const shuffle of [false, true]) {
      const { h, sessions } = three(scene({ door: 0, crate: 0, lamp: 0 }));
      const [ana, ben, cy] = sessions as [CoEditSession, CoEditSession, CoEditSession];
      ana.edit(scene({ door: 5, crate: 0, lamp: 0 }));
      ben.edit(scene({ door: 0, crate: 7, lamp: 0 }));
      // Ana and Cy both move the lamp at once: one wins, the same one everywhere.
      ana.edit(scene({ door: 5, crate: 0, lamp: 1 }));
      cy.edit(scene({ door: 0, crate: 0, lamp: 2 }));
      h.flush(shuffle);
      const results = sessions.map((s) => xs(s.sidecars()));
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);
      expect(results[0]!.door).toBe(5);
      expect(results[0]!.crate).toBe(7);
      expect([1, 2]).toContain(results[0]!.lamp);
    }
  });

  it("carries additions, deletions and other sidecars, and tells the editor when someone else's edit lands", () => {
    const { h, shown, sessions } = three(scene({ door: 0 }));
    const [ana, ben] = sessions as [CoEditSession, CoEditSession];
    ana.edit(scene({ door: 0, crate: 4 }, { flags: [1, 2] } as Partial<Sidecars>));
    h.flush();
    expect(xs(shown.get("ben")!)).toEqual({ door: 0, crate: 4 });
    expect((shown.get("cy")!.flags as unknown as number[])).toEqual([1, 2]);
    ben.edit(scene({ crate: 4 }, { flags: [1, 2] } as Partial<Sidecars>)); // the door deleted
    h.flush();
    expect(xs(ana.sidecars())).toEqual({ crate: 4 });
  });

  it("brings a newcomer up to date", () => {
    const h = hub();
    const start = scene({ door: 0 });
    const ana = new CoEditSession("ana", h.transport("ana"), start, emptySidecars(), () => {}, () => 0);
    ana.edit(scene({ door: 9, crate: 1 }));
    h.flush();
    let late: Sidecars | null = null;
    new CoEditSession("dee", h.transport("dee"), start, emptySidecars(), (s) => (late = s), () => 0);
    h.flush();
    expect(xs(late!)).toEqual({ door: 9, crate: 1 });
  });

  it("shows who else is here and what they've selected, until they go quiet", () => {
    let t = 0;
    const h = hub();
    const start = scene({ door: 0 });
    const ana = new CoEditSession("ana", h.transport("ana"), start, emptySidecars(), () => {}, () => t);
    const ben = new CoEditSession("ben", h.transport("ben"), start, emptySidecars(), () => {}, () => t);
    ben.announce("Ben", ["door"]);
    h.flush();
    expect(ana.others()).toEqual([{ peer: "ben", name: "Ben", selection: ["door"] }]);
    t = 20_000;
    expect(ana.others()).toEqual([]);
  });

  it("agrees on who holds a binary asset's lock, even when two grab it at once", () => {
    const { h, sessions } = three(scene({}));
    const [ana, ben] = sessions as [CoEditSession, CoEditSession];
    expect(ana.lock("sprites")).toBe(true);
    expect(ben.lock("sprites")).toBe(true); // it hasn't heard yet
    h.flush();
    const holders = sessions.map((s) => s.holder("sprites"));
    expect(new Set(holders).size).toBe(1);
    const owner = holders[0]!;
    const other = owner === "ana" ? ben : ana;
    expect(other.lock("sprites")).toBe(false);
    (owner === "ana" ? ana : ben).unlock("sprites");
    h.flush();
    expect(other.lock("sprites")).toBe(true);
  });
});
