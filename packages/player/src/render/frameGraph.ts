/**
 * The frame graph (AAA_FIDELITY_ROADMAP.md F0c): a WebGPU frame declared as
 * passes and the textures they read and write, rather than encoded by hand in
 * one fixed order.
 *
 * A frame is built fresh each time:
 *
 * ```ts
 * const graph = new FrameGraph();
 * const colour = graph.importTexture("colour", this.colourTexture);
 * const lit = graph.createTexture("lit", { format: "rgba16float", width, height });
 * graph.addPass("shade", "render", (pass) => {
 *   pass.write(lit);
 *   return (ctx) => { const p = ctx.encoder.beginRenderPass({ ..., ...ctx.timing }); ... };
 * });
 * graph.addPass("blit", "render", (pass) => {
 *   pass.read(lit);
 *   pass.write(colour);
 *   return (ctx) => { ... };
 * });
 * graph.run(device, encoder, pool, timer);
 * ```
 *
 * Compiling it does three things:
 *
 * - **It culls.** A pass is kept only if it writes an imported texture (one
 *   that outlives the frame), is marked {@link PassBuilder.keep}, or writes
 *   something a kept pass reads. A pass nothing needs costs nothing.
 * - **It allocates.** A texture made with {@link FrameGraph.createTexture} is
 *   transient: it lives from the first kept pass that uses it to the last.
 *   Its usage flags come from how the passes use it. Two transients of the same
 *   description whose lives don't overlap share one GPU texture (aliasing).
 *   The {@link TransientPool} keeps those textures from frame to frame, so a
 *   steady frame allocates nothing.
 * - **It times.** Every kept render and compute pass gets its own pair of
 *   timestamps when the device has `timestamp-query` (see {@link GraphTimer}).
 *
 * Compiling is pure (no device), so the order, culling and aliasing can be
 * tested on their own.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A transient texture's shape. */
export interface TextureDesc {
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly sampleCount?: number;
}

/** How a pass uses a texture, which decides the usage flags a transient is made with. */
export type ReadAccess = "sampled" | "copySrc" | "attachment" | "storage";
export type WriteAccess = "attachment" | "copyDst" | "storage";

/** GPUTextureUsage bits for each access. */
const USAGE: Record<ReadAccess | WriteAccess, number> = {
  copySrc: 0x01,
  copyDst: 0x02,
  sampled: 0x04,
  storage: 0x08,
  attachment: 0x10,
};

/** A texture in the graph: transient (made by the graph) or imported (owned by the caller). */
export interface FrameResource {
  readonly id: number;
  readonly name: string;
}

/** What a pass's setup declares. */
export interface PassBuilder {
  /** The pass reads `resource`. A transient must have been written by an earlier pass. */
  read(resource: FrameResource, access?: ReadAccess): void;
  /** The pass writes `resource`. Reading it too (`read`) is what loading its contents means. */
  write(resource: FrameResource, access?: WriteAccess): void;
  /** Keep the pass even though nothing reads what it writes (a readback, say). */
  keep(): void;
}

/** What a pass's body gets when the graph runs it. */
export interface PassContext {
  readonly encoder: any;
  /** The GPU texture behind a resource the pass declared. */
  texture(resource: FrameResource): any;
  /** The pass's `timestampWrites` (spread into its pass descriptor), or {} when the frame isn't timed. */
  readonly timing: { readonly timestampWrites?: object };
}

/** Render and compute passes are timed; a transfer (copies, resolves, readbacks) is plain encoder commands. */
export type PassKind = "render" | "compute" | "transfer";

interface ResourceNode {
  readonly name: string;
  readonly desc: TextureDesc | null;
  readonly imported: any;
  usage: number;
}

interface PassNode {
  readonly name: string;
  readonly kind: PassKind;
  readonly reads: number[];
  readonly writes: number[];
  kept: boolean;
  readonly body: (ctx: PassContext) => void;
}

/** One transient's place in the compiled frame. */
export interface Allocation {
  readonly resource: string;
  /** The physical texture it lives in: transients sharing a slot alias. */
  readonly slot: number;
  /** Its first and last kept pass (indices into {@link CompiledFrame.order}). */
  readonly first: number;
  readonly last: number;
}

/** A physical transient texture the frame needs. */
export interface Slot {
  readonly key: string;
  readonly desc: TextureDesc;
  readonly usage: number;
}

/** The frame after culling, ordering and allocation. */
export interface CompiledFrame {
  /** The kept passes, in the order they run. */
  readonly order: readonly string[];
  /** The passes nothing needed. */
  readonly culled: readonly string[];
  /** Every transient a kept pass uses. */
  readonly allocations: readonly Allocation[];
  readonly slots: readonly Slot[];
}

/** A transient's pool key: two transients alias only if they would be made identically. */
export function slotKey(desc: TextureDesc, usage: number): string {
  return `${desc.format}:${desc.width}x${desc.height}:${desc.sampleCount ?? 1}:${usage}`;
}

export class FrameGraph {
  private readonly resources: ResourceNode[] = [];
  private readonly passes: PassNode[] = [];
  private compiled: CompiledFrame | null = null;
  /** Indices of the kept passes, parallel to `compiled.order`. */
  private keptPasses: number[] = [];
  private slotOf = new Map<number, number>();

  /** A texture the graph makes, alive only for the passes that use it. */
  createTexture(name: string, desc: TextureDesc): FrameResource {
    return this.add({ name, desc, imported: null, usage: 0 });
  }

  /** A texture the caller owns (it outlives the frame): a pass writing it is always kept. */
  importTexture(name: string, texture: any): FrameResource {
    if (!texture) throw new Error(`frame graph: imported texture "${name}" is missing`);
    return this.add({ name, desc: null, imported: texture, usage: 0 });
  }

  /** Declare a pass: `setup` names what it reads and writes, and returns the body that encodes it. */
  addPass(name: string, kind: PassKind, setup: (pass: PassBuilder) => (ctx: PassContext) => void): void {
    if (this.compiled) throw new Error("frame graph: passes can't be added after compiling");
    const reads: number[] = [];
    const writes: number[] = [];
    let kept = false;
    const own = (resource: FrameResource) => {
      const node = this.resources[resource.id];
      if (!node || node.name !== resource.name) throw new Error(`frame graph: "${resource.name}" isn't this graph's`);
      return node;
    };
    const builder: PassBuilder = {
      read: (resource, access = "sampled") => {
        own(resource).usage |= USAGE[access];
        if (!reads.includes(resource.id)) reads.push(resource.id);
      },
      write: (resource, access = "attachment") => {
        own(resource).usage |= USAGE[access];
        if (!writes.includes(resource.id)) writes.push(resource.id);
      },
      keep: () => {
        kept = true;
      },
    };
    const body = setup(builder);
    this.passes.push({ name, kind, reads, writes, kept, body });
  }

  /** Cull, order and allocate (pure: no device). Compiling twice returns the same frame. */
  compile(): CompiledFrame {
    if (this.compiled) return this.compiled;
    // Live passes, from the last back: a pass is live if it's kept, writes
    // something imported, or writes something a later live pass reads.
    const needed = new Set<number>();
    const live = new Array<boolean>(this.passes.length).fill(false);
    for (let i = this.passes.length - 1; i >= 0; i -= 1) {
      const pass = this.passes[i]!;
      const outputs = pass.writes.some((id) => this.resources[id]!.imported !== null || needed.has(id));
      if (pass.kept || outputs) {
        live[i] = true;
        for (const id of pass.reads) needed.add(id);
      }
    }
    const keptPasses = this.passes.map((_, i) => i).filter((i) => live[i]);

    // Transients: each must be written before it's read, and lives from its first use to its last.
    const first = new Map<number, number>();
    const last = new Map<number, number>();
    keptPasses.forEach((passIndex, order) => {
      const pass = this.passes[passIndex]!;
      for (const id of pass.reads) {
        if (this.resources[id]!.imported === null && !first.has(id)) {
          throw new Error(`frame graph: pass "${pass.name}" reads "${this.resources[id]!.name}" before anything writes it`);
        }
      }
      for (const id of [...pass.reads, ...pass.writes]) {
        if (this.resources[id]!.imported !== null) continue;
        if (!first.has(id)) first.set(id, order);
        last.set(id, order);
      }
    });

    // Aliasing: walk the passes in order, taking a free slot of the same key at a
    // transient's first use and freeing it after its last.
    const slots: Slot[] = [];
    const free = new Map<string, number[]>();
    const slotOf = new Map<number, number>();
    const byFirst = [...first.keys()].sort((a, b) => first.get(a)! - first.get(b)! || a - b);
    const allocations: Allocation[] = [];
    for (let order = 0; order < keptPasses.length; order += 1) {
      for (const id of byFirst) {
        if (first.get(id) !== order) continue;
        const node = this.resources[id]!;
        const key = slotKey(node.desc!, node.usage);
        const pool = free.get(key);
        let slot = pool?.pop();
        if (slot === undefined) {
          slot = slots.length;
          slots.push({ key, desc: node.desc!, usage: node.usage });
        }
        slotOf.set(id, slot);
        allocations.push({ resource: node.name, slot, first: order, last: last.get(id)! });
      }
      for (const id of byFirst) {
        if (last.get(id) !== order) continue;
        const key = slots[slotOf.get(id)!]!.key;
        const pool = free.get(key) ?? [];
        pool.push(slotOf.get(id)!);
        free.set(key, pool);
      }
    }

    this.keptPasses = keptPasses;
    this.slotOf = slotOf;
    this.compiled = {
      order: keptPasses.map((i) => this.passes[i]!.name),
      culled: this.passes.filter((_, i) => !live[i]).map((p) => p.name),
      allocations,
      slots,
    };
    return this.compiled;
  }

  /** Compile, take the transients from `pool`, and encode every kept pass into `encoder`. */
  run(encoder: any, pool: TransientPool, timer: GraphTimer | null = null): CompiledFrame {
    const compiled = this.compile();
    const textures = pool.take(compiled.slots);
    const timed = timer ? timer.begin(this.keptPasses.map((i) => this.passes[i]!).filter((p) => p.kind !== "transfer").map((p) => p.name)) : null;
    let timedIndex = 0;
    for (const passIndex of this.keptPasses) {
      const pass = this.passes[passIndex]!;
      const declared = new Set([...pass.reads, ...pass.writes]);
      const timing = timed && pass.kind !== "transfer" ? { timestampWrites: timed(timedIndex++) } : {};
      pass.body({
        encoder,
        timing,
        texture: (resource) => {
          if (!declared.has(resource.id)) throw new Error(`frame graph: pass "${pass.name}" uses "${resource.name}" without declaring it`);
          const node = this.resources[resource.id]!;
          return node.imported ?? textures[this.slotOf.get(resource.id)!];
        },
      });
    }
    timer?.resolve(encoder);
    return compiled;
  }

  private add(node: ResourceNode): FrameResource {
    if (this.compiled) throw new Error("frame graph: resources can't be added after compiling");
    this.resources.push(node);
    return { id: this.resources.length - 1, name: node.name };
  }
}

/**
 * The transient textures, kept across frames. A frame's slots take textures of
 * their key in order, so a frame with the same shape as the last gets the same
 * textures. A texture no frame has taken for {@link TransientPool.idleFrames}
 * frames is destroyed.
 */
export class TransientPool {
  private readonly textures = new Map<string, { texture: any; usedFrame: number }[]>();
  private frame = 0;
  /** Textures created (for tests and the profiler). */
  created = 0;

  constructor(
    private readonly device: any,
    readonly idleFrames = 120,
  ) {}

  /** One texture for each slot, in slot order. */
  take(slots: readonly Slot[]): any[] {
    this.frame += 1;
    const taken = new Map<string, number>();
    const out = slots.map((slot) => {
      const n = taken.get(slot.key) ?? 0;
      taken.set(slot.key, n + 1);
      const list = this.textures.get(slot.key) ?? [];
      this.textures.set(slot.key, list);
      if (!list[n]) {
        const { format, width, height, sampleCount } = slot.desc;
        list[n] = { texture: this.device.createTexture({ size: { width, height }, format, usage: slot.usage, ...(sampleCount && sampleCount > 1 ? { sampleCount } : {}) }), usedFrame: this.frame };
        this.created += 1;
      }
      list[n]!.usedFrame = this.frame;
      return list[n]!.texture;
    });
    for (const [key, list] of this.textures) {
      while (list.length > 0 && this.frame - list[list.length - 1]!.usedFrame > this.idleFrames) list.pop()!.texture.destroy?.();
      if (list.length === 0) this.textures.delete(key);
    }
    return out;
  }

  /** Textures the pool holds now. */
  get size(): number {
    let n = 0;
    for (const list of this.textures.values()) n += list.length;
    return n;
  }

  destroy(): void {
    for (const list of this.textures.values()) for (const entry of list) entry.texture.destroy?.();
    this.textures.clear();
  }
}

/** One pass's GPU time. */
export interface PassTime {
  readonly name: string;
  readonly ms: number;
}

/**
 * Timestamps around every timed pass of a frame, when the device was created
 * with `timestamp-query`. The results land a frame or two late (the GPU runs
 * behind); `lastPasses` and `lastMs` (first begin to last end) are the newest
 * frame read back. A frame encoded while the last is still being read is not
 * timed.
 */
export class GraphTimer {
  lastMs: number | null = null;
  lastPasses: readonly PassTime[] = [];
  private readonly querySet: any;
  private readonly resolveBuffer: any;
  private readonly readBuffer: any;
  private reading = false;
  /** The passes of the frame being encoded, when it is timed. */
  private encoding: string[] | null = null;
  /** The passes whose timestamps were copied out, waiting for {@link read}. */
  private copied: string[] | null = null;

  private constructor(
    device: any,
    /** Passes a frame may time; any past it go untimed. */
    readonly capacity: number,
  ) {
    this.querySet = device.createQuerySet({ type: "timestamp", count: capacity * 2 });
    this.resolveBuffer = device.createBuffer({ size: capacity * 16, usage: 0x200 | 0x04 }); // QUERY_RESOLVE | COPY_SRC
    this.readBuffer = device.createBuffer({ size: capacity * 16, usage: 0x08 | 0x01 }); // COPY_DST | MAP_READ
  }

  /** A timer, when the device was created with `timestamp-query`. */
  static create(device: any, capacity = 16): GraphTimer | null {
    try {
      return device?.features?.has?.("timestamp-query") ? new GraphTimer(device, capacity) : null;
    } catch {
      return null;
    }
  }

  /** Start timing a frame of these passes; returns each pass's `timestampWrites`, or null when this frame isn't timed. */
  begin(passes: readonly string[]): ((index: number) => object | undefined) | null {
    if (this.reading || passes.length === 0) {
      this.encoding = null;
      return null;
    }
    this.encoding = passes.slice(0, this.capacity);
    return (index) => (index < this.capacity ? { querySet: this.querySet, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1 } : undefined);
  }

  /** After the frame's passes: resolve its timestamps and copy them out. */
  resolve(encoder: any): void {
    const passes = this.encoding;
    this.encoding = null;
    if (!passes) return;
    encoder.resolveQuerySet(this.querySet, 0, passes.length * 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, passes.length * 16);
    this.copied = passes;
  }

  /** After submitting: read the copied timestamps back. */
  read(): void {
    const passes = this.copied;
    if (!passes) return;
    this.copied = null;
    this.reading = true;
    this.readBuffer
      .mapAsync(0x01, 0, passes.length * 16)
      .then(() => {
        const t = new BigUint64Array(this.readBuffer.getMappedRange(0, passes.length * 16).slice(0));
        this.readBuffer.unmap();
        const times = timesFromStamps(passes, t);
        if (times) {
          this.lastPasses = times.passes;
          this.lastMs = times.total;
        }
      })
      .catch(() => {})
      .finally(() => {
        this.reading = false;
      });
  }

  destroy(): void {
    this.querySet?.destroy?.();
    this.resolveBuffer?.destroy?.();
    this.readBuffer?.destroy?.();
  }
}

/**
 * Each pass's time from its begin/end timestamps (nanoseconds), and the frame's
 * from the first begin to the last end; null when the stamps are nonsense (a
 * clock reset, an unwritten query).
 */
export function timesFromStamps(passes: readonly string[], stamps: BigUint64Array): { passes: PassTime[]; total: number } | null {
  if (passes.length === 0 || stamps.length < passes.length * 2) return null;
  const out: PassTime[] = [];
  for (let i = 0; i < passes.length; i += 1) {
    const ns = Number(stamps[i * 2 + 1]! - stamps[i * 2]!);
    if (!(ns >= 0 && ns < 1e10)) return null;
    out.push({ name: passes[i]!, ms: ns / 1e6 });
  }
  const total = Number(stamps[passes.length * 2 - 1]! - stamps[0]!);
  if (!(total >= 0 && total < 1e10)) return null;
  return { passes: out, total: total / 1e6 };
}
