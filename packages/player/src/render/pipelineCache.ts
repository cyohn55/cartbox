/**
 * One pipeline cache per GPU device (AAA_PRODUCTION_ROADMAP.md M3, completing
 * DEMO_QUALITY_ROADMAP.md R5).
 *
 * Every render and compute pipeline the player makes goes through here:
 *
 * - **Memoized by descriptor.** Two requests for the same pipeline (the same
 *   shader modules and layout objects, the same entry points, formats, blend,
 *   depth and constants) get the same pipeline, so a renderer made again (a
 *   resize, a quality change, the editor's viewport and a play view on one
 *   device) compiles nothing it compiled before.
 * - **Async where it can be.** `renderAsync` / `computeAsync` compile with the
 *   device's `create*PipelineAsync`, off the frame, and put the result where a
 *   later synchronous request finds it. A warm-up uses them behind the loading
 *   screen.
 * - **Counted.** Synchronous compiles after {@link PipelineCache.markReady}
 *   (the first frame is up) are `late`: each is a likely hitch, and the
 *   profiler shows the count.
 *
 * The key treats the two places a descriptor holds GPU objects (`module` and a
 * non-"auto" `layout`) by identity, and everything else by value. Labels are
 * left out, so a pipeline is shared whatever it was called. Shader modules go
 * through {@link shaderModule}, one per WGSL source per device, so the same
 * pipeline asked for twice has the same modules and so the same key.
 *
 * **A recorded warm-up** (as engines keep a recorded pipeline-state cache):
 * each pipeline with an "auto" layout whose modules came from
 * {@link shaderModule} is also a *recipe*, its descriptor with each module
 * written as its WGSL. The recipes a session's renderer asked for are saved
 * ({@link PipelineManifestStore}); the next load compiles them asynchronously
 * before its first frame ({@link warmPipelines}), so a pass that was first
 * switched on mid-game last time is already compiled this time. Recipes that
 * no renderer asks for again drop out at the next save.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PipelineStats {
  /** Pipelines compiled synchronously (create*Pipeline). */
  readonly compiled: number;
  /** Pipelines compiled asynchronously (create*PipelineAsync). */
  readonly compiledAsync: number;
  /** Requests answered from the cache. */
  readonly reused: number;
  /** Synchronous compiles after markReady: the frame waited for each. */
  readonly late: number;
  /** Asynchronous compiles still running. */
  readonly pending: number;
}

type Kind = "render" | "compute";

const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object): number => {
  let id = ids.get(o);
  if (id === undefined) {
    id = nextId++;
    ids.set(o, id);
  }
  return id;
};

/** The cache's key for a descriptor: GPU objects by identity, the rest by value, labels left out. */
export function pipelineKey(kind: Kind, descriptor: object): string {
  return `${kind}:${JSON.stringify(descriptor, (key, value) => {
    if (key === "label") return undefined;
    if ((key === "module" || key === "layout") && value !== null && typeof value === "object") return `#${idOf(value)}`;
    return value;
  })}`;
}

/** Each shader module made through {@link shaderModule}, with its source. */
const moduleCode = new WeakMap<object, string>();
const moduleCaches = new WeakMap<object, Map<string, any>>();

/**
 * A shader module for `descriptor` on `device`: one per WGSL source (labels
 * aside), remembered with its source so pipelines using it can be recorded.
 * A descriptor with more than code and a label is made as asked, uncached.
 */
export function shaderModule(device: any, descriptor: { readonly code: string; readonly label?: string; readonly [key: string]: unknown }): any {
  if (Object.keys(descriptor).some((k) => k !== "code" && k !== "label")) return device.createShaderModule(descriptor);
  let modules = moduleCaches.get(device);
  if (!modules) moduleCaches.set(device, (modules = new Map()));
  let module = modules.get(descriptor.code);
  if (!module) {
    module = device.createShaderModule({ code: descriptor.code });
    modules.set(descriptor.code, module);
    if (module !== null && typeof module === "object") moduleCode.set(module, descriptor.code);
  }
  return module;
}

/** Each bind group or pipeline layout made through the caches below, as the plain descriptor that makes it again. */
const layoutRecipes = new WeakMap<object, unknown>();
const bindGroupLayoutCaches = new WeakMap<object, Map<string, any>>();
const pipelineLayoutCaches = new WeakMap<object, Map<string, any>>();
const withoutLabel = (descriptor: object): object => JSON.parse(JSON.stringify(descriptor, (key, value) => (key === "label" ? undefined : value))) as object;

/**
 * A bind group layout for `descriptor` on `device`: one per descriptor (labels
 * aside), since equal layouts are interchangeable in WebGPU, remembered so a
 * pipeline layout made of it can be recorded.
 */
export function bindGroupLayout(device: any, descriptor: object): any {
  let layouts = bindGroupLayoutCaches.get(device);
  if (!layouts) bindGroupLayoutCaches.set(device, (layouts = new Map()));
  const plain = withoutLabel(descriptor);
  const key = JSON.stringify(plain);
  let layout = layouts.get(key);
  if (!layout) {
    layout = device.createBindGroupLayout(descriptor);
    layouts.set(key, layout);
    if (layout !== null && typeof layout === "object") layoutRecipes.set(layout, plain);
  }
  return layout;
}

/**
 * A pipeline layout over `descriptor.bindGroupLayouts` on `device`: one per set
 * of bind group layouts. Recorded as their descriptors when each came from
 * {@link bindGroupLayout} (a layout taken off an "auto" pipeline can't be).
 */
export function pipelineLayout(device: any, descriptor: { readonly bindGroupLayouts: readonly any[]; readonly label?: string }): any {
  let layouts = pipelineLayoutCaches.get(device);
  if (!layouts) pipelineLayoutCaches.set(device, (layouts = new Map()));
  const groups = [...descriptor.bindGroupLayouts];
  const key = groups.map((g) => (g !== null && typeof g === "object" ? idOf(g) : String(g))).join(",");
  let layout = layouts.get(key);
  if (!layout) {
    layout = device.createPipelineLayout(descriptor);
    layouts.set(key, layout);
    const recipes = groups.map((g) => (g !== null && typeof g === "object" ? layoutRecipes.get(g) : undefined));
    if (layout !== null && typeof layout === "object" && recipes.every((r) => r !== undefined)) layoutRecipes.set(layout, { $groups: recipes });
  }
  return layout;
}

/**
 * A pipeline's recipe: `kind:` then its descriptor as JSON, each module written
 * as `{"$wgsl": source}` and an explicit layout as its bind group layouts'
 * descriptors; null when it can't be written down (a module or layout not
 * made through these caches).
 */
export function pipelineRecipe(kind: Kind, descriptor: any): string | null {
  const layout = descriptor?.layout;
  if (layout !== "auto" && !(layout !== null && typeof layout === "object" && layoutRecipes.has(layout))) return null;
  let ok = true;
  const json = JSON.stringify(descriptor, (key, value) => {
    if (key === "label") return undefined;
    if (key === "module") {
      const code = value !== null && typeof value === "object" ? moduleCode.get(value) : undefined;
      if (code === undefined) ok = false;
      return { $wgsl: code ?? "" };
    }
    if (key === "layout" && value !== null && typeof value === "object") return { $layout: layoutRecipes.get(value) };
    return value;
  });
  return ok ? `${kind}:${json}` : null;
}

/** A recipe as a descriptor on `device` again (its modules through {@link shaderModule}), or null for a malformed one. */
export function recipeDescriptor(device: any, recipe: string): { kind: Kind; descriptor: any } | null {
  const colon = recipe.indexOf(":");
  const kind = recipe.slice(0, colon);
  if (kind !== "render" && kind !== "compute") return null;
  try {
    const descriptor = JSON.parse(recipe.slice(colon + 1), (key, value) => {
      if (key === "module" && value && typeof value.$wgsl === "string") return shaderModule(device, { code: value.$wgsl });
      if (key === "layout" && value && value.$layout && Array.isArray(value.$layout.$groups)) {
        return pipelineLayout(device, { bindGroupLayouts: (value.$layout.$groups as object[]).map((g) => bindGroupLayout(device, g)) });
      }
      return value;
    });
    return { kind, descriptor };
  } catch {
    return null;
  }
}

/** Recipes a manifest keeps at most (the most recently used). */
export const MANIFEST_MAX = 512;

export class PipelineCache {
  private readonly made = new Map<string, any>();
  /** Recipes this session's renderers asked for (synchronously), by key, in first-asked order. */
  private readonly used = new Map<string, string>();
  private readonly compiling = new Map<string, Promise<any>>();
  private ready = false;
  private counts = { compiled: 0, compiledAsync: 0, reused: 0, late: 0 };

  constructor(private readonly device: any) {}

  /** A render pipeline: the cached one, or compiled now. */
  render(descriptor: object): any {
    return this.sync("render", descriptor);
  }

  /** A compute pipeline: the cached one, or compiled now. */
  compute(descriptor: object): any {
    return this.sync("compute", descriptor);
  }

  /** A render pipeline compiled off the frame where the device can (else now), cached for later requests. */
  renderAsync(descriptor: object): Promise<any> {
    return this.async("render", descriptor);
  }

  /** A compute pipeline compiled off the frame where the device can, cached for later requests. */
  computeAsync(descriptor: object): Promise<any> {
    return this.async("compute", descriptor);
  }

  /** From now on a synchronous compile counts as late (call when the first frame is shown). */
  markReady(): void {
    this.ready = true;
  }

  /** Whether {@link markReady} has been called. */
  get isReady(): boolean {
    return this.ready;
  }

  /** The recipes this session's renderers asked for: what the next load should warm. */
  manifest(): string[] {
    return [...this.used.values()].slice(-MANIFEST_MAX);
  }

  /**
   * Compile `recipes` off the frame (a recorded warm-up), each into the cache.
   * Resolves with how many compiled; a recipe that no longer compiles (an older
   * build's shader) is skipped.
   */
  async warm(recipes: readonly string[]): Promise<{ compiled: number; failed: number }> {
    let compiled = 0;
    let failed = 0;
    await Promise.all(
      recipes.slice(0, MANIFEST_MAX).map(async (recipe) => {
        const made = recipeDescriptor(this.device, recipe);
        if (!made) {
          failed += 1;
          return;
        }
        try {
          await (made.kind === "render" ? this.renderAsync(made.descriptor) : this.computeAsync(made.descriptor));
          compiled += 1;
        } catch {
          failed += 1;
        }
      }),
    );
    return { compiled, failed };
  }

  /** Resolves when every asynchronous compile started so far has finished (failures included). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.compiling.values()]);
  }

  stats(): PipelineStats {
    return { ...this.counts, pending: this.compiling.size };
  }

  private sync(kind: Kind, descriptor: object): any {
    const key = pipelineKey(kind, descriptor);
    if (!this.used.has(key)) {
      const recipe = pipelineRecipe(kind, descriptor);
      if (recipe) this.used.set(key, recipe);
    }
    const cached = this.made.get(key);
    if (cached !== undefined) {
      this.counts.reused += 1;
      return cached;
    }
    // Still compiling off the frame: the frame can't wait for a promise, so compile it here too.
    const pipeline = kind === "render" ? this.device.createRenderPipeline(descriptor) : this.device.createComputePipeline(descriptor);
    this.counts.compiled += 1;
    if (this.ready) this.counts.late += 1;
    this.made.set(key, pipeline);
    return pipeline;
  }

  private async(kind: Kind, descriptor: object): Promise<any> {
    const key = pipelineKey(kind, descriptor);
    const cached = this.made.get(key);
    if (cached !== undefined) {
      this.counts.reused += 1;
      return Promise.resolve(cached);
    }
    const running = this.compiling.get(key);
    if (running) return running;
    const make = kind === "render" ? this.device.createRenderPipelineAsync : this.device.createComputePipelineAsync;
    if (typeof make !== "function") return Promise.resolve(this.sync(kind, descriptor));
    const promise = (make.call(this.device, descriptor) as Promise<any>).then(
      (pipeline) => {
        this.compiling.delete(key);
        this.counts.compiledAsync += 1;
        // A synchronous request that couldn't wait may have made one meanwhile: keep that one.
        if (!this.made.has(key)) this.made.set(key, pipeline);
        return this.made.get(key);
      },
      (error) => {
        this.compiling.delete(key);
        throw error;
      },
    );
    this.compiling.set(key, promise);
    return promise;
  }
}

/** Where a manifest is kept between loads: a page's localStorage, or a stand-in. */
export interface ManifestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const MANIFEST_KEY = "cartbox.pipelineManifest.v1";

/**
 * A manifest as text (a page's storage, or a file shipped with a map): the
 * recipes with each WGSL source once, since pipelines share their scene shader
 * and whole recipes would repeat it many times over.
 */
export function packPipelineManifest(recipes: readonly string[]): string {
  const wgsl: string[] = [];
  const index = new Map<string, number>();
  const packed = recipes.slice(-MANIFEST_MAX).map((recipe) =>
    recipe.replace(/\{"\$wgsl":("(?:[^"\\]|\\.)*")\}/g, (_, quoted: string) => {
      const code = JSON.parse(quoted) as string;
      let i = index.get(code);
      if (i === undefined) {
        i = wgsl.length;
        wgsl.push(code);
        index.set(code, i);
      }
      return `{"$wgsl":${i}}`;
    }),
  );
  return JSON.stringify({ v: 1, wgsl, recipes: packed });
}

/** The recipes of a packed manifest, or none (missing, unreadable or an older format). Never throws. */
export function unpackPipelineManifest(raw: string | null | undefined): string[] {
  try {
    if (!raw) return [];
    const stored = JSON.parse(raw) as { v?: unknown; wgsl?: unknown; recipes?: unknown };
    if (stored.v !== 1 || !Array.isArray(stored.wgsl) || !Array.isArray(stored.recipes)) return [];
    const wgsl = stored.wgsl as unknown[];
    return (stored.recipes as unknown[])
      .filter((r): r is string => typeof r === "string")
      .slice(-MANIFEST_MAX)
      .map((r) => r.replace(/\{"\$wgsl":(\d+)\}/g, (_, i: string) => JSON.stringify({ $wgsl: typeof wgsl[Number(i)] === "string" ? wgsl[Number(i)] : "" })));
  } catch {
    return [];
  }
}

/** Reads and writes the recorded manifest, never throwing (private mode, a full quota, no storage). */
export class PipelineManifestStore {
  constructor(
    private readonly storage: ManifestStorage | null = defaultStorage(),
    private readonly key = MANIFEST_KEY,
  ) {}

  /** The recorded recipes, or none (a missing, unreadable or older-format manifest). */
  load(): string[] {
    try {
      return unpackPipelineManifest(this.storage?.getItem(this.key) ?? null);
    } catch {
      return [];
    }
  }

  /**
   * Keep `recipes`, each WGSL source once (pipelines share their scene shader,
   * so whole recipes would repeat it many times over a page's storage quota).
   */
  save(recipes: readonly string[]): void {
    try {
      this.storage?.setItem(this.key, packPipelineManifest(recipes));
    } catch {
      // A full or blocked storage: the next load just warms less.
    }
  }
}

function defaultStorage(): ManifestStorage | null {
  try {
    const storage = (globalThis as { localStorage?: ManifestStorage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/**
 * The warm-up a load runs before its renderer's first frame: the recorded
 * manifest compiled asynchronously on `device`, waited for at most `budgetMs`
 * (what isn't done by then keeps compiling, and a frame that needs it first
 * compiles it then). Resolves with what was started and finished.
 */
export async function warmPipelines(
  device: any,
  {
    store = new PipelineManifestStore(),
    budgetMs = 3000,
    shipped = [],
  }: {
    store?: PipelineManifestStore;
    budgetMs?: number;
    /**
     * A manifest shipped with what is being loaded (a map's, recorded from a
     * scripted run of it), warmed with the stored one: so the very first load on
     * a browser, which has no stored manifest, still compiles off the frame.
     */
    shipped?: readonly string[];
  } = {},
): Promise<{ recipes: number; compiled: number; failed: number; timedOut: boolean }> {
  const recipes = mergeManifests(shipped, store.load());
  if (recipes.length === 0) return { recipes: 0, compiled: 0, failed: 0, timedOut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  const result = await Promise.race([pipelineCache(device).warm(recipes), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result ? { recipes: recipes.length, ...result, timedOut: false } : { recipes: recipes.length, compiled: 0, failed: 0, timedOut: true };
}

/** Recipes of several manifests, each once, in first-seen order, at most MANIFEST_MAX. */
export function mergeManifests(...manifests: readonly (readonly string[])[]): string[] {
  return [...new Set(manifests.flat())].slice(0, MANIFEST_MAX);
}

const caches = new WeakMap<object, PipelineCache>();

/** The pipeline cache of `device` (one per device, made on first use). */
export function pipelineCache(device: any): PipelineCache {
  let cache = caches.get(device);
  if (!cache) {
    cache = new PipelineCache(device);
    caches.set(device, cache);
  }
  return cache;
}
