import { MeshSceneInstance, MeshAsset, Mat4, ScenePropValue, PhysicsSpec, AnimatorSpec, SceneLighting, PhysicsWorldSettings, SceneTimeline, SceneLevel, NavMesh, Terrain, SceneStreaming, ParticleEffect, DecalDef, DecalMark, RagdollBox, DebrisDef, LodChain, StreamGroup, JointKind, JointSpec, DecodedTexture, EncodedImage, EnvironmentLight, ShadowInput, ToneMap, SceneLight, LocalShadows, SceneFog, RasterStyle, SurfaceEffect, AnimatorOp, NavGraph, AnimationCue } from '@cartbox/editor';

/**
 * The runtime mesh scene: the cart's mesh sidecar resolved into placed instances
 * the software rasteriser can draw. This is the player-side counterpart to the
 * editor's `MeshSidecar` — it decodes the same stored JSON but yields ready-to-
 * render geometry (a decoded {@link MeshAsset} plus a baked model matrix) rather
 * than the editable envelope.
 *
 * Kept pure and DOM-free so the parse + camera maths are unit-testable: texture
 * decoding (which needs the browser) is the surface's job, not this module's. A
 * malformed sidecar never throws into the run loop — bad entries are dropped, and
 * an empty or unparseable payload yields null (the cart plays without meshes).
 */

/** One placed mesh ready to rasterise: decoded geometry + its baked world matrix. */
interface MeshInstance extends MeshSceneInstance {
    readonly mesh: MeshAsset;
    readonly model: Mat4;
    /**
     * Optional animation frames: alternate meshes a cart selects per frame through
     * a pose's `frame` (1 = frames[0], …; 0 keeps the base mesh). Instances that
     * share frames share the MeshAsset objects.
     */
    readonly frames?: readonly MeshAsset[];
    /**
     * Scene-object data (ENGINE_ROADMAP.md, Phase 1). `model` is the world matrix;
     * `local` is the authored transform relative to `parent` (an index into the
     * scene's instances, -1 for a root). For a root, `local === model`.
     */
    readonly local: Mat4;
    readonly parent: number;
    readonly id: string;
    readonly name: string;
    readonly tags: readonly string[];
    readonly props: Readonly<Record<string, ScenePropValue>>;
    /** The object's physics body, or null (ENGINE_ROADMAP.md, Phase 2). */
    readonly physics: PhysicsSpec | null;
    /** A skinned object's animation state machine (ENGINE_ROADMAP.md, Phase 3), or absent. */
    readonly animator?: AnimatorSpec;
    /**
     * Set on the objects of a prefab copy held in reserve for `cartbox.spawn`: which
     * prefab, which copy, and the copy's root index. Hidden until spawned.
     */
    readonly pooled?: {
        readonly prefab: string;
        readonly copy: number;
        readonly root: number;
    };
    /** The level this object belongs to (an index into the scene's `levels`); absent = always loaded. */
    readonly level?: number;
    /**
     * Set on a terrain's geometry (see terrain.ts in @cartbox/editor): landscape
     * round the play space, so it neither sets the framing bounds nor casts into
     * the shadow map (which frames the play space), and the far plane reaches it.
     */
    readonly terrain?: true;
    /** On a terrain block whose terrain casts shadows ({@link Terrain.castShadows}): it goes into the shadow map. */
    readonly casts?: true;
    /**
     * On a terrain block: how far from it full detail holds (world units). Its
     * `frames` are the half- and quarter-detail versions the renderer swaps to
     * with distance.
     */
    readonly detail?: number;
    /** Kept loaded whatever the distance, when the scene streams (see streaming.ts in @cartbox/editor). */
    readonly alwaysLoaded?: true;
}
/** A prefab's reserve of spawnable copies: each copy's root object index. */
interface PrefabPool {
    readonly prefab: string;
    readonly roots: readonly number[];
}
/** A world-space axis-aligned bounding box with a framing centre + radius. */
interface SceneBounds {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
    readonly center: readonly [number, number, number];
    /** Half the bounding sphere's diameter — the radius the camera frames. */
    readonly radius: number;
}
/** The parsed runtime scene: every placed mesh, their shared world bounds, and the lighting rig. */
interface MeshScene {
    readonly instances: readonly MeshInstance[];
    /** Prefabs code can spawn copies of (their copies are hidden instances at the end). */
    readonly pools?: readonly PrefabPool[];
    readonly bounds: SceneBounds;
    /** The authored Modern-tier lighting rig, or null when the cart set none. */
    readonly lighting: SceneLighting | null;
    /** Scene-wide physics settings (absent = the defaults). */
    readonly physicsWorld?: PhysicsWorldSettings;
    /** Cutscenes and scripted camera moves (objects referred to by instance `id`). */
    readonly timelines?: readonly SceneTimeline[];
    /** Named levels, one loaded at a time (the first at start); see levels.ts in @cartbox/editor. */
    readonly levels?: readonly SceneLevel[];
    /** The baked walkable surface characters find paths over (see navmesh.ts in @cartbox/editor). */
    readonly navmesh?: NavMesh;
    /** Heightfield landscapes, as authored (their geometry is among the instances). */
    readonly terrains?: readonly Terrain[];
    /** Bounds of everything drawn, terrain included — how far the camera must see. */
    readonly extent?: SceneBounds;
    /** Spatial loading: objects load by distance from the streaming focus (absent = all loaded). */
    readonly streaming?: SceneStreaming;
    /** 3D particle effects the cart fires with `cartbox.burst` (see particleEffects.ts in @cartbox/editor). */
    readonly effects?: readonly ParticleEffect[];
    /** Decals the cart lays with `cartbox.decal`, and permanent marks placed in the editor (see decals.ts in @cartbox/editor). */
    readonly decals?: readonly DecalDef[];
    readonly decalMarks?: readonly DecalMark[];
    /** Boxes ragdolls land on (HALO2_STYLE_ROADMAP.md, H9), besides the scene's static bodies. */
    readonly ragdollColliders?: readonly RagdollBox[];
    /**
     * Cosmetic debris the cart throws with cartbox.debris (H10), each with the
     * mesh of the object or prefab it copies (`debrisMeshes[i]` for `debris[i]`;
     * definitions whose source can't be found are dropped).
     */
    readonly debris?: readonly DebrisDef[];
    readonly debrisMeshes?: readonly MeshAsset[];
    /** Each debris mesh's LOD chain (EP9b), or null; absent when none has one. */
    readonly debrisLods?: readonly (LodChain | null)[];
}
/** A view + projection pair ready to hand to `renderMeshScene`. */
interface SceneCamera$1 {
    readonly view: Mat4;
    readonly projection: Mat4;
}
/**
 * Parse a cart's stored mesh sidecar into a runtime {@link MeshScene}. Returns
 * null when there is nothing to render (no payload, unparseable JSON, or every
 * entry dropped as malformed), so the player can skip the mesh surface entirely.
 */
declare function parseMeshScene(raw: string | null | undefined): MeshScene | null;
/**
 * The scene's spatially loaded groups (see streaming.ts in @cartbox/editor):
 * each root object with its children, and the world box they fill. Objects in
 * a level, reserve prefab copies, terrain and those marked always loaded (with
 * their children) aren't spatially loaded.
 */
declare function streamGroups(scene: MeshScene): StreamGroup[];
/**
 * The auto-orbit's pitch, raised as far as it takes (up to nearly overhead) for
 * the auto-fitted eye to clear any terrain beneath it by a few units — a scene
 * set in a valley would otherwise orbit inside its own mountains.
 */
declare function orbitPitchAboveTerrain(scene: MeshScene, yaw: number, pitch: number): number;
/** Optional overrides a cart supplies via `cartbox.meshcam(...)` (see the mailbox). */
interface OrbitCameraOptions {
    /** Vertical field of view, radians; defaults to ~50°. */
    readonly fov?: number;
    /** Explicit distance from the target, world units; omitted/≤0 auto-fits the scene. */
    readonly distance?: number | null;
    /** Offset added to the scene centre to aim the camera, world units. */
    readonly targetOffset?: readonly [number, number, number];
    /**
     * Near clip distance, world units; omitted scales it with the scene (5% of the
     * radius — right for an orbit framing the whole scene, but a first-person eye
     * inside the scene would clip everything within a metre, its own weapon and
     * any wall it stands beside included).
     */
    readonly near?: number;
    /** Everything drawn (terrain included): the far plane reaches past all of it. */
    readonly extent?: SceneBounds;
}
/**
 * Build an orbit camera that frames the scene bounds from `yaw`/`pitch`, fitting
 * the whole scene into the vertical field of view. `aspect` is the framebuffer's
 * width/height, so the projection is undistorted on the runtime's non-square
 * screen. With no options this auto-fits the scene (the player's gentle P2
 * auto-orbit); a cart drives it explicitly through `options` via the mesh camera.
 */
declare function buildOrbitCamera(bounds: SceneBounds, yaw: number, pitch: number, aspect: number, options?: OrbitCameraOptions): SceneCamera$1;

/**
 * Console models. A model is a fixed hardware spec plus the WASM runtime that
 * runs it. Threading a model through the player/engine/replay/thumbnail paths
 * (instead of hard-coding 240x136 / 60fps) is what makes additional models —
 * Pro, Voxel — additive rather than a rewrite.
 *
 * Constraints stay fixed *per model*. There are deliberately no free-form
 * toggles: that would dissolve the aesthetic and break the fixed-spec
 * assumptions the platform layer depends on.
 */
type ModelId = "classic" | "pro" | "portrait" | "voxel" | "ps1" | "n64" | "xbox360" | "modern";
/**
 * How a model rasterises triangles.
 *
 * Display specs (width, palette, channels) distinguish the 2D models from each
 * other. They cannot distinguish the *era* models on the roadmap, which differ
 * almost entirely in rendering semantics: a PS1-era model is defined by having
 * no depth buffer and affine texture mapping, an N64-era model by trilinear
 * filtering and a 4KB texture cache. Those are the traits that make era content
 * look like its era, so they belong in the model descriptor beside the
 * resolution rather than inside a renderer.
 *
 * Every model carries these today because the mesh and world overlay surfaces
 * rasterise triangles over any model's framebuffer, whatever its `kind`. The
 * four shipping models therefore declare identical caps — they all run the same
 * software rasteriser. That is the point: the field exists so that adding an era
 * model is a descriptor change plus a renderer that honours it, not a fork of
 * the rendering path. See ERA_MODELS.md.
 */
interface RenderCaps {
    /** False means painter's-algorithm sorting, so surfaces interpenetrate. */
    zBuffer: boolean;
    /** False means affine texture mapping — the PS1 texture warp. */
    perspectiveCorrect: boolean;
    textureFiltering: "none" | "bilinear" | "trilinear";
    /** Integer vertex coordinates produce the PS1 wobble. */
    vertexPrecision: "integer" | "float";
    /** Texture memory a frame may draw from; 0 means unbounded. */
    textureCacheBytes: number;
    /** Triangles submitted per frame; 0 means unbounded. */
    polyBudget: number;
    /**
     * Whether creators may supply their own shaders. True dissolves the
     * fixed-spec guarantee the platform layer relies on, so it stays false for
     * every fantasy-console model.
     */
    programmableShaders: boolean;
}
/**
 * What the shared software rasteriser behind the mesh/world overlays actually
 * does today: depth-buffered, perspective-correct, unfiltered, float vertices,
 * and unbounded because nothing enforces a ceiling. Era models override this.
 */
declare const SOFTWARE_RASTER_CAPS: RenderCaps;
interface ConsoleModel {
    id: ModelId;
    label: string;
    /**
     * Rasterizer family. Every model presents a 2D RGBA framebuffer for display,
     * whatever it draws into it, so the player's blit path stays model-agnostic.
     *
     * `poly3d` is a model whose games are textured triangle scenes: the core
     * still supplies the 2D frame, script and sound, and the mesh/world overlays
     * composite the 3D over it. The editor uses this to decide whether the
     * spatial authoring tabs apply.
     */
    kind: "raster2d" | "voxel3d" | "poly3d";
    width: number;
    height: number;
    /** Bytes per framebuffer pixel (RGBA = 4). */
    pixelBytes: number;
    /** Fixed frame rate (fixed-timestep loop). */
    fps: number;
    audioChannels: number;
    sampleRate: number;
    /** Editor-enforced creative limits (informational at runtime). */
    paletteSize: number;
    cartSizeBytes: number;
    /**
     * Bytes of content-addressed assets a cart on this model may reference,
     * beyond its cartridge. 0 means none: the cartridge is the whole cart.
     *
     * This is the constraint that lets a 3D era model exist at all. A textured
     * scene does not fit in a cartridge at any resolution, so an era model stores
     * its bulk beside the cart and references it by hash (see
     * `cartAssetStore.ts`). Keeping the allowance *per model* rather than global
     * is the same doctrine as every other limit here: an era model should pick a
     * budget that evokes its generation rather than reproducing a disc, and a
     * cartridge-only model should not silently acquire an asset store.
     */
    assetBudgetBytes: number;
    /** Default runtime URL for this model; overridable per player instance. */
    engineUrl: string;
    inputs: Array<"gamepad" | "mouse" | "keyboard">;
    /** Triangle-rasterisation semantics. See {@link RenderCaps}. */
    renderCaps: RenderCaps;
}
declare const MODELS: Record<ModelId, ConsoleModel>;
/** Model used when a cart or caller does not specify one. */
declare const DEFAULT_MODEL_ID: ModelId;
/**
 * Resolves a model by id. Accepts a plain string (e.g. a `console_model` value
 * from the database) and validates it.
 */
declare function getModel(id?: string): ConsoleModel;
/** Size of one framebuffer, in bytes, for a model. */
declare function framebufferBytes(model: ConsoleModel): number;
/** Duration of one frame, in milliseconds, for a model. */
declare function frameDurationMs(model: ConsoleModel): number;

/**
 * The physics channel between the host (which runs the physics world) and the
 * cart's Lua (ENGINE_ROADMAP.md, Phase 2).
 *
 * pmem is too small for body state, so physics uses an 8 KB block at the very end
 * of the console's RAM — inside TIC-80's free RAM on every core, where Lua reads
 * and writes it with peek/poke and the host with a view of the WASM heap. Only a
 * cart that has physics bodies uses it.
 *
 * Each core has its own RAM layout (the era models enlarge VRAM and the map), so
 * the block's address comes from a per-model table, measured against the real
 * engine builds by a test (physics.test.ts) that fails if a rebuild moves them.
 * The host writes a magic word at load and the cart's first tick checks it, so a
 * mismatch disables physics rather than corrupting memory.
 *
 * All values are little-endian int32; positions, velocities and distances are
 * fixed point with 1/1024 precision (±2 million units of range).
 */

/** Where pmem word 0 sits in Lua's RAM address space, and how big RAM is, per core. */
interface RamLayout {
    readonly pmemAddress: number;
    readonly ramSize: number;
}
/** RAM layout by console model (models sharing a core share its layout). */
declare const RAM_LAYOUTS: Readonly<Record<ModelId, RamLayout>>;
declare const PHYS_BLOCK_BYTES = 8192;
declare const PHYS_MAGIC = 1213219395;
/** One agent as the cart reads it. */
interface AgentState {
    readonly key: number;
    readonly position: readonly [number, number, number];
    readonly facing: number;
    readonly flags: number;
}
/** Where the physics block starts in Lua's RAM space for a model. */
declare function physicsBlockAddress(layout: RamLayout): number;
/** A command the cart wrote this tick. */
interface PhysicsCommand {
    readonly op: number;
    readonly a: number;
    readonly v: readonly [number, number, number, number, number, number];
}
/** One body's state as the cart reads it. */
interface PhysicsBodyState {
    readonly object: number;
    readonly position: readonly [number, number, number];
    readonly velocity: readonly [number, number, number];
    readonly grounded: boolean;
    readonly sleeping: boolean;
}
/** One ray result (slot order), or null for a miss / no request. */
interface PhysicsRayHit {
    readonly object: number;
    readonly point: readonly [number, number, number];
    readonly normal: readonly [number, number, number];
    readonly distance: number;
}
/** A contact that began or ended during the last step, between two scene objects. */
interface PhysicsContactEvent {
    readonly a: number;
    readonly b: number;
    readonly started: boolean;
    /** One of the two is a trigger zone (an overlap, not a collision). */
    readonly trigger: boolean;
}
/** Write the host → Lua half of the block. */
declare function writePhysicsState(block: DataView, tick: number, bodies: readonly PhysicsBodyState[], rays: readonly (PhysicsRayHit | null)[], events?: readonly PhysicsContactEvent[], overlaps?: readonly (readonly [number, number])[], hash?: number): void;
/** One animated object's playback as the cart reads it. */
interface AnimationPlayback {
    readonly object: number;
    /** Clip index, or -1 at rest. */
    readonly clip: number;
    /** Seconds into the clip (wrapped when looping, held at the end otherwise). */
    readonly time: number;
    /** The state machine's current state, or -1 (no machine, or the cart is playing a clip directly). */
    readonly state?: number;
}
/** Read (and clear) the commands the cart wrote this tick. */
declare function takePhysicsCommands(block: DataView): PhysicsCommand[];

/**
 * Runs a cart's physics (ENGINE_ROADMAP.md, Phase 2): builds bodies for the scene
 * objects that have a physics spec, and each tick hands the cart their state,
 * applies the commands it wrote, steps the world, and casts the rays it asked for.
 *
 * The physics engine itself sits behind {@link PhysicsBackend}, so the player
 * stays small: the web app supplies a Rapier backend (loaded only for carts with
 * bodies), and tests can supply the same one in Node.
 *
 * Per tick: `beforeTick` writes the state after the last step (and last tick's
 * ray results) into the shared block; the cart runs, reading state and writing
 * commands; `afterTick` applies those commands, steps the world one fixed 1/60 s
 * step, and casts the requested rays (and shape sweeps) for the next tick to read.
 */

type Vec3$2 = readonly [number, number, number];
type Quat = readonly [number, number, number, number];
/** A collider fitted to a scene object, in its body's local frame (scale applied). */
type PhysicsShape = {
    readonly kind: "box";
    readonly halfExtents: Vec3$2;
    readonly offset: Vec3$2;
} | {
    readonly kind: "sphere";
    readonly radius: number;
    readonly offset: Vec3$2;
} | {
    readonly kind: "capsule";
    readonly halfHeight: number;
    readonly radius: number;
    readonly offset: Vec3$2;
} | {
    readonly kind: "mesh";
    readonly vertices: Float32Array;
    readonly indices: Uint32Array;
};
/** A shape swept through the world by a shape cast (upright, unrotated). */
type CastShape = {
    readonly kind: "sphere";
    readonly radius: number;
} | {
    readonly kind: "box";
    readonly halfExtents: Vec3$2;
} | {
    readonly kind: "capsule";
    readonly radius: number;
    readonly halfHeight: number;
};
/** What a ray or shape cast hit. */
interface CastHit {
    readonly object: number;
    readonly point: Vec3$2;
    readonly normal: Vec3$2;
    readonly distance: number;
}
interface PhysicsBodyDesc {
    readonly kind: PhysicsSpec["body"];
    readonly shape: PhysicsShape;
    readonly position: Vec3$2;
    readonly rotation: Quat;
    readonly mass: number;
    readonly friction: number;
    readonly bounce: number;
    /** A trigger zone: reports overlaps, blocks nothing. */
    readonly trigger?: boolean;
    /** Gravity multiplier (dynamic bodies). */
    readonly gravity?: number;
    /** Linear damping (dynamic bodies). */
    readonly damping?: number;
    /** The scene object this body belongs to (reported back by raycasts). */
    readonly object: number;
}
/**
 * A joint between a body and another (or the world), as local frames on each:
 * at the start the two frames coincide in the world. A hinge turns about its
 * frames' X axis; limits are radians from that start.
 */
interface PhysicsJointDesc {
    readonly kind: JointKind;
    readonly body: number;
    /** The other body's handle, or null for the world (frame2 is then in world space). */
    readonly target: number | null;
    readonly anchor1: Vec3$2;
    readonly frame1: Quat;
    readonly anchor2: Vec3$2;
    readonly frame2: Quat;
    readonly limits?: readonly [number, number];
    /** Spring rest length / rope's longest reach. */
    readonly length: number;
    readonly stiffness: number;
    readonly damping: number;
}
/** What a physics engine must provide. Handles are small integers the backend picks. */
interface PhysicsBackend {
    addBody(desc: PhysicsBodyDesc): number;
    /** Advance the world by `dt` seconds. */
    step(dt: number): void;
    bodyState(handle: number): {
        position: Vec3$2;
        rotation: Quat;
        velocity: Vec3$2;
        sleeping: boolean;
    };
    applyImpulse(handle: number, impulse: Vec3$2): void;
    setVelocity(handle: number, velocity: Vec3$2): void;
    teleport(handle: number, position: Vec3$2): void;
    /** Move a character by `delta`, sliding along what it hits. Returns whether it ended on the ground. */
    moveCharacter(handle: number, delta: Vec3$2): {
        grounded: boolean;
    };
    /**
     * The nearest hit along a unit `direction` within `maxDistance`, or null.
     * `ignore` is a scene object whose body the ray passes through.
     */
    raycast(origin: Vec3$2, direction: Vec3$2, maxDistance: number, ignore?: number): CastHit | null;
    /**
     * Sweep `shape` from `origin` along a unit `direction`: the first hit within
     * `maxDistance` (distance = how far the shape's centre travelled before touching;
     * point and normal are on the surface hit), or null.
     */
    shapecast?(shape: CastShape, origin: Vec3$2, direction: Vec3$2, maxDistance: number, ignore?: number): CastHit | null;
    /** Take a body out of (or back into) the world — a spawnable copy waiting in reserve. */
    setEnabled(handle: number, enabled: boolean): void;
    /** Place a body at a position and rotation at once, at rest. */
    setPose(handle: number, position: Vec3$2, rotation: Quat): void;
    /** Contacts that began or ended during the last step (scene object indices). */
    drainContacts(): PhysicsContactEvent[];
    /** What is inside each trigger now, as (trigger object, other object) pairs. */
    overlaps(): [number, number][];
    /** Joints (optional: a backend without them leaves bodies unjointed). */
    addJoint?(desc: PhysicsJointDesc): number;
    removeJoint?(joint: number): void;
    /** Drive a hinge at `speed` rad/s with at most `force` (0 turns the motor off). */
    setMotor?(joint: number, speed: number, force: number): void;
    destroy(): void;
}
declare const PHYSICS_DT: number;
/** Position, rotation (unit quaternion) and scale of a world matrix without shear. */
declare function splitWorldMatrix(m: Mat4): {
    position: Vec3$2;
    rotation: Quat;
    scale: Vec3$2;
};
/** A world matrix from position, unit quaternion and scale. */
declare function composeWorldMatrix(p: Vec3$2, q: Quat, s: Vec3$2): Mat4;
/**
 * The joint frames for a body posed by world matrix `self`, tied to a target posed
 * by `target` (null: the world). The anchor is in the object's own coordinates, so
 * it's scaled with the object; a spring or rope pulls the object's centre toward it.
 */
declare function jointFrames(spec: JointSpec, self: Mat4, target: Mat4 | null): Omit<PhysicsJointDesc, "body" | "target">;
/** Fit a collider of `spec.shape` to a mesh's bounds (or triangles), scaled. */
declare function fitShape(spec: PhysicsSpec, mesh: MeshAsset, scale: Vec3$2): PhysicsShape;
/** The scene objects with bodies the cart can read and drive (everything but static), in slot order. */
declare function physicsSlots(scene: MeshScene): number[];
/** Whether a scene has any physics bodies at all. */
declare function sceneHasPhysics(scene: MeshScene | null | undefined): boolean;
declare class PhysicsSession {
    private readonly tracked;
    private readonly byObject;
    /** Bodies of reserve prefab copies (static ones too), by object index. */
    private readonly pooledBodies;
    /** Every body's handle, by object index. */
    private readonly handleOf;
    /** Jointed objects: what they're tied to (object, or null for the world) and the live joint. */
    private readonly joints;
    private rayRequests;
    private rayResults;
    private events;
    private overlapPairs;
    private tick;
    private stateHash;
    private readonly backend;
    /** Whether inputs are rounded for cross-browser determinism (the scene's setting unless overridden). */
    readonly deterministic: boolean;
    constructor(scene: MeshScene, backend: PhysicsBackend, { deterministic }?: {
        deterministic?: boolean;
    });
    /** Create `object`'s joint from where it and its target are now (`world` gives world matrices). */
    private join;
    private unjoin;
    /** Write body state and last tick's ray results for the cart to read. */
    beforeTick(block: DataView): void;
    /** Apply the cart's commands, step the world, and cast the rays it asked for. */
    afterTick(block: DataView): void;
    /**
     * Take the bodies of objects in unloaded levels out of the world, and bring the
     * rest back (see levels.ts in @cartbox/editor). Prefab copies aren't in levels.
     */
    setInactive(objects: ReadonlySet<number>): void;
    /**
     * Bring a spawned prefab copy's bodies into the world, placed where the copy's
     * objects now are (`world` gives each object's world matrix), or take them out.
     */
    setCopyActive(objects: readonly number[], world: (object: number) => Mat4 | null, active: boolean): void;
    /** A body's world matrix now (position and rotation from physics; unit scale). */
    private currentWorld;
    /** Apply a tick's commands (already taken from the block), step, and cast rays. */
    run(commands: readonly PhysicsCommand[]): void;
    /**
     * A digest of every moving body's exact state (reserve copies count as absent),
     * equal on two machines exactly when their worlds match — in deterministic mode,
     * across browsers too.
     */
    hash(): number;
    /** Last step's contact events and current trigger overlaps (live inspection, tests). */
    contacts(): {
        events: readonly PhysicsContactEvent[];
        overlaps: readonly (readonly [number, number])[];
    };
    /** Each moving body's live state, by object index (live inspection). */
    inspect(): Map<number, {
        kind: string;
        velocity: Vec3$2;
        grounded: boolean;
        active: boolean;
    }>;
    /** World matrices for every moving body this frame (scene object index → matrix). */
    overrides(): Map<number, Mat4>;
    destroy(): void;
}

/**
 * Data-driven post-processing effect model, shared by the editor's FX tab and
 * the runtime player. Each effect declares its parameters (with ranges and
 * defaults); UIs render them generically and `uniformsFromSettings` folds the
 * whole stack into the flat uniform block the shader consumes — a disabled
 * effect collapses to its neutral value, so the shader needs no per-effect
 * branching and never recompiles.
 *
 * DOM-free so server code (the save API validates with `parsePostFxSettings`)
 * and tests consume it without a browser.
 *
 * The stack divides into two halves. The first seven effects are the console's
 * own signal path — the grade, the tube, the lens. The rest are screen-space
 * looks ported from the Shade Studio shader library, chosen for being
 * single-pass (the no-recompile design has no room for a second target) and for
 * suiting pixel art rather than fighting it: ordered dithering and halftone are
 * how a small palette fakes a gradient, and light shafts and streaks are how a
 * flat 2D scene suggests a light source it cannot actually cast.
 */
type PostFxEffectId = "grade" | "fog" | "bloom" | "tonemap" | "crt" | "chroma" | "vignette" | "posterize" | "dither" | "halftone" | "godrays" | "streaks" | "lensflare" | "splittone" | "reflection" | "tiltshift" | "kaleidoscope" | "grain";
interface PostFxParamDef {
    id: string;
    label: string;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
}
/** A colour an effect exposes, e.g. the fog tint or a split-tone end. */
interface PostFxColorDef {
    id: string;
    label: string;
    /** #rrggbb. */
    defaultValue: string;
}
interface PostFxEffectDef {
    id: PostFxEffectId;
    label: string;
    description: string;
    params: PostFxParamDef[];
    /** Colour pickers this effect exposes, if any. */
    colors?: PostFxColorDef[];
}
declare const POST_FX_EFFECTS: PostFxEffectDef[];
/** Key for one parameter's (or colour's) value in the settings map. */
declare function paramKey(effect: PostFxEffectId, param: string): string;
interface PostFxSettings {
    enabled: Record<PostFxEffectId, boolean>;
    values: Record<string, number>;
    /** Effect colours as #rrggbb, keyed by {@link paramKey}. */
    colors: Record<string, string>;
}
declare function defaultPostFxSettings(): PostFxSettings;
/** Whether any effect in the stack is switched on. */
declare function anyPostFxEnabled(settings: PostFxSettings): boolean;
/**
 * Validate untrusted JSON (a PUT body or a jsonb column) into PostFxSettings,
 * or null when malformed. Lenient about omissions — unknown effects/params are
 * dropped and missing ones take their defaults, so the wire format survives
 * adding effects later — but strict about types and ranges, clamping values
 * into each parameter's declared bounds.
 *
 * A top-level `fogColor` string is still honoured: rows written before effects
 * could declare their own colours carry the fog tint there, and silently losing
 * an artist's fog colour on the next save would be a worse outcome than one
 * branch here.
 */
declare function parsePostFxSettings(value: unknown): PostFxSettings | null;
/** The flat uniform block the post-process shader consumes. */
interface PostFxUniforms {
    brightness: number;
    contrast: number;
    saturation: number;
    fogDensity: number;
    fogHorizon: number;
    fogColor: [number, number, number];
    bloomStrength: number;
    bloomThreshold: number;
    /** Pyramid spread, 0..1: how much the coarse blur levels contribute. */
    bloomRadius: number;
    /** 0 leaves the frame in gamma space; 1 applies the ACES filmic rolloff. */
    toneMap: number;
    /** Pre-tonemap exposure multiplier (only read when {@link toneMap} is on). */
    exposure: number;
    curvature: number;
    scanlines: number;
    aberration: number;
    vignette: number;
    /** 0 disables posterisation; otherwise the level count. */
    posterize: number;
    ditherAmount: number;
    ditherScale: number;
    halftoneStrength: number;
    halftoneScale: number;
    /** Screen angle in radians. */
    halftoneAngle: number;
    godrayStrength: number;
    godrayDensity: number;
    godrayDecay: number;
    godrayOrigin: [number, number];
    streakStrength: number;
    streakLength: number;
    /** Sun glare strength (0 = none). */
    flareGlare: number;
    /** Lens-ghost strength (0 = none). */
    flareGhosts: number;
    /** Glare radius in screen-height units. */
    flareSize: number;
    flareColor: [number, number, number];
    /** The light's screen position (0..1, y down): the source point, or the sun a 3D scene reports. */
    flareOrigin: [number, number];
    /** How much of the light is unblocked, 0..1 (1 unless a 3D scene reports less). */
    flareVisible: number;
    splitStrength: number;
    splitBalance: number;
    splitShadows: [number, number, number];
    splitHighlights: [number, number, number];
    /** Wet-floor reflection strength (0 disables the mirror). */
    reflectionStrength: number;
    /** Screen row of the reflective surface's near edge, 0..1. */
    reflectionHorizon: number;
    /** How far below the horizon the reflection persists, in screen-height units. */
    reflectionFalloff: number;
    /** Sideways ripple amplitude of the reflection. */
    reflectionWobble: number;
    /** Tilt-shift max blur (0 disables the depth of field). */
    tiltStrength: number;
    /** Centre row of the in-focus band, 0..1. */
    tiltFocus: number;
    /** Half-height of the fully-sharp band, in screen-height units. */
    tiltRange: number;
    /** Below 2 the shader leaves the frame alone. */
    kaleidoSegments: number;
    /** Rotation in radians. */
    kaleidoAngle: number;
    grainAmount: number;
    grainSize: number;
}
/** Parse #rrggbb into a 0..1 RGB triplet. */
declare function hexToRgb01(hex: string): [number, number, number];
/**
 * Fold the settings into shader uniforms. Disabled effects map to their
 * neutral values (identity grade, zero density/strength), so toggling an
 * effect never needs a shader recompile.
 */
declare function uniformsFromSettings(settings: PostFxSettings): PostFxUniforms;

/**
 * Graphics quality presets (ENGINE_ROADMAP.md, Phase 4): what the player spends
 * on a frame, chosen per device.
 *
 * - **high**: everything as authored — full-resolution shadow maps, every
 *   post-effect, the 3D at full size (a software-rendered first-person view may
 *   still step itself down to hold the frame rate). This is the player's
 *   behaviour before presets existed.
 * - **medium**: half-resolution shadow maps; the first-person software view
 *   starts at three-quarter size.
 * - **low**: no shadows, no bloom or chromatic aberration (the multi-pass
 *   effects; cheap per-pixel looks like grading, CRT or dithering stay), and the
 *   first-person software view capped at half size.
 *
 * Terrain keeps full detail less far on the lower presets (60% and 30% of the
 * authored distance), so distant ground costs fewer triangles.
 *
 * "auto" picks one from what the browser says about the device: weak hardware
 * (≤ 2 cores or ≤ 2 GB of memory) → low; a phone or tablet, or any device with
 * no GPU renderer (WebGPU or WebGL2, so rendering on the CPU) → medium; otherwise
 * high.
 */

type QualityLevel = "low" | "medium" | "high";
type QualityChoice = QualityLevel | "auto";
declare const QUALITY_LEVELS: readonly QualityLevel[];
interface QualitySettings {
    readonly level: QualityLevel;
    /** Draw shadows at all. */
    readonly shadows: boolean;
    /** Shadow map edge in texels. */
    readonly shadowMapSize: number;
    /** Add a near shadow cascade round the camera (ENGINE_PARITY_ROADMAP.md EP8b): sharp shadows close up. */
    readonly shadowCascades?: boolean;
    /** The largest 3D render scale for a software first-person view (the governor works below it). */
    readonly maxRenderScale: number;
    /** Post-effects this preset turns off (the costly multi-pass ones). */
    readonly disabledEffects: readonly string[];
    /**
     * How far terrain keeps its detail, as a share of each block's authored
     * distance: lower presets drop to the coarser blocks sooner.
     */
    readonly terrainDetail: number;
}
declare const QUALITY_PRESETS: Readonly<Record<QualityLevel, QualitySettings>>;
/** What the browser reveals about the device (all optional: browsers differ). */
interface DeviceHints {
    readonly cores?: number;
    /** navigator.deviceMemory, in GB (Chromium only; rounded down to a power of two). */
    readonly memoryGB?: number;
    readonly mobile?: boolean;
    /** Whether a GPU renderer (WebGPU or WebGL2) came up (else the CPU rasteriser draws). */
    readonly webgpu?: boolean;
}
/** The preset "auto" picks for a device. */
declare function detectQuality(hints: DeviceHints): QualityLevel;
/** Resolve a choice ("auto" included) to its preset's settings. */
declare function resolveQuality(choice: QualityChoice | undefined, hints: DeviceHints): QualitySettings;
/** This browser's hints (in a browser; empty elsewhere). */
declare function browserDeviceHints(webgpu?: boolean): DeviceHints;
/** Post-effect settings with a preset's costly effects switched off (the same object when none apply). */
declare function applyQualityToPostFx(settings: PostFxSettings, quality: QualitySettings): PostFxSettings;

/**
 * Netplay — online multiplayer for carts, relayed by the host page.
 *
 * TIC-80 has no networking, so the browser does it: each player's page runs its
 * own copy of the cart, and a {@link NetSession} relays compact player state and
 * events between them over a {@link NetTransport} (Supabase Realtime broadcast
 * online, BroadcastChannel between tabs, an in-memory hub in tests).
 *
 * The cart and its host page exchange that data through the low 119 words of
 * persistent memory (pmem 0..118) — the words just below the event mailbox,
 * which a netplay cart must therefore not use for save data. The host writes the
 * INBOX before every tick and reads the OUTBOX after it:
 *
 * ```
 * INBOX  (host → cart)
 *   0      header   bits 0-1 mode (0 offline, 1 client, 2 host) · 2-4 my slot ·
 *                   5-7 page status (e.g. matchmaking) · 8-15 slots held by a human ·
 *                   16-23 slots with live remote state
 *   1      the host's match word (opaque to the relay: the host cart's game state)
 *   2      tick sequence
 *   3..26  8 slots × 3 words of remote player state (opaque to the relay)
 *   27     event count (≤ 20)
 *   28..67 20 events × 2 words
 * OUTBOX (cart → host)
 *   70     mask of slots the cart published this tick
 *   71     match word (only the host's is relayed)
 *   72..95 8 slots × 3 words: this player's state (and, on the host, its bots')
 *   96     event count (≤ 10)
 *   97..116 10 events × 2 words
 * (68..69 are the analog sticks' words — see sticks.ts.)
 * ```
 *
 * The relay never interprets state or event words — a cart defines them — so the
 * same channel serves any game: every client is authoritative for its own slot,
 * the lowest slot is the host (it simulates anything no human controls), and
 * events (a hit, a kill) are broadcast to everyone.
 */
/** Words of pmem the netplay channel uses (0..118, just below the mailbox). */
declare const NET_WORDS = 119;
/** Player slots per room. */
declare const NET_SLOTS = 8;
declare const NET_MODE_OFFLINE = 0;
declare const NET_MODE_CLIENT = 1;
declare const NET_MODE_HOST = 2;
/** One slot's opaque state. */
type NetState = readonly [number, number, number];
/** One opaque event. */
type NetEvent = readonly [number, number];
/** What the host page tells the cart before a tick. */
interface NetInbox {
    readonly mode: number;
    readonly mySlot: number;
    /** The page's status for the cart (0 idle; e.g. matchmaking progress), bits 5-7. */
    readonly status?: number;
    /** Bitmask of slots held by a human (including mine). */
    readonly humans: number;
    /** Bitmask of remote slots with live state this tick. */
    readonly live: number;
    readonly match: number;
    readonly seq: number;
    /** Remote state per slot (null when there is none). */
    readonly slots: readonly (NetState | null)[];
    readonly events: readonly NetEvent[];
}
/** What the cart told the host page during a tick. */
interface NetOutbox {
    /** Slot → state for every slot the cart published this tick. */
    readonly states: ReadonlyMap<number, NetState>;
    readonly match: number;
    readonly events: readonly NetEvent[];
}
/** Write an inbox into the net words (a live view of pmem 0..118). */
declare function writeNetInbox(words: Uint32Array, inbox: NetInbox): number;
/** Read what the cart published this tick, then clear the outbox for the next. */
declare function takeNetOutbox(words: Uint32Array): NetOutbox;

/**
 * The host-page side of netplay: joins a room over a {@link NetTransport},
 * assigns player slots, and relays the cart's published state and events to the
 * other players — and theirs into this cart. See netplay.ts for the pmem layout.
 *
 * Slots are assigned deterministically from the room's membership (ordered by
 * join time, then id), so every browser agrees who is in which slot without a
 * server; the lowest slot is the host. Everything is sent in one message every
 * 4 ticks (~15 Hz): the latest state (a snapshot — a lost one is replaced by the
 * next), every event raised since (a hit, a kill: at most 50 ms late), and the
 * host's match word.
 */

/** A room member as the transport's presence reports it. */
interface NetPeer {
    readonly id: string;
    /** When the peer joined (ms since epoch) — orders the slots. */
    readonly joinedAt: number;
    readonly name?: string;
}
/**
 * The one message the session sends, ~15 times a second: the slots this player
 * published ([slot, w0, w1, w2]), the events raised since the last one, and (from
 * the host) the match word. One batched message per player keeps a room well
 * inside a hosted broadcast service's message-rate limits.
 */
interface NetMessage {
    readonly s?: readonly (readonly [number, number, number, number])[];
    readonly e?: readonly NetEvent[];
    readonly m?: number;
}
/** A room-scoped broadcast channel with presence. */
interface NetTransport {
    /** This browser's peer id. */
    readonly selfId: string;
    /** Join the room, announcing when we joined. Resolves once subscribed. */
    connect(joinedAt: number, name?: string): Promise<void>;
    /** Broadcast to every other peer (never echoed back to the sender). */
    send(message: NetMessage): void;
    onMessage(handler: (message: NetMessage, from: string) => void): void;
    /** The full membership, each time it changes (including us). */
    onPeers(handler: (peers: readonly NetPeer[]) => void): void;
    close(): void;
}
/** The session's view of the room, for a lobby UI. */
interface NetRoomStatus {
    readonly connected: boolean;
    readonly peers: readonly NetPeer[];
    readonly mySlot: number;
    readonly isHost: boolean;
}
/**
 * Ticks between messages, by room size: 15 Hz for two players, 10 Hz up to
 * four, 7.5 Hz beyond. A room's traffic grows with players × listeners, so the
 * per-player rate falls as the room fills to keep the total inside a hosted
 * broadcast service's message budget; clients interpolate between snapshots.
 */
declare function netSendInterval(players: number): number;
declare class NetSession {
    private readonly transport;
    private readonly now;
    private peers;
    private connected;
    private readonly joinedAt;
    private readonly remote;
    private readonly pendingEvents;
    private hostMatch;
    private statusCode;
    private tick;
    private readonly outEvents;
    private outStates;
    /** What the last message carried (states + match), and when — to skip repeats. */
    private lastSent;
    private lastSentTick;
    private readonly listeners;
    /** Bytes sent and received so far, as JSON on the wire (for the profiler). */
    private sentBytes;
    private receivedBytes;
    constructor(transport: NetTransport, now?: () => number);
    /** Bytes this session has sent and received, measured as the messages' JSON. */
    traffic(): {
        sent: number;
        received: number;
    };
    /** Forget the current room's state (remote players, queued events, the host's
     *  match word) — for moving to another room without carrying anything over. */
    resetRoom(): void;
    /** A status for the cart (0..7, read as net()'s fifth value) — e.g. matchmaking progress. */
    setStatus(code: number): void;
    /** Join the room. */
    connect(name?: string): Promise<void>;
    close(): void;
    /** This browser's slot (0..7), or -1 while the room is full/unknown. */
    get mySlot(): number;
    get isHost(): boolean;
    status(): NetRoomStatus;
    /** Subscribe to room changes (membership, connection). */
    onStatus(listener: (status: NetRoomStatus) => void): () => void;
    /** Fill the cart's inbox before a tick. `words` is a live view of pmem 0..118. */
    beforeTick(words: Uint32Array): void;
    /** Relay what the cart published during the tick, and clear its outbox. */
    afterTick(words: Uint32Array): void;
    private receive;
    private emit;
}
/**
 * An in-process room: every transport created from one hub hears the others.
 * For tests, and for simulating a match between two players on one machine.
 */
declare class MemoryNetHub {
    private readonly members;
    transport(id: string): NetTransport;
    /** @internal */
    join(id: string, peer: NetPeer): void;
    /** @internal */
    leave(id: string): void;
    /** @internal */
    deliver(from: string, message: NetMessage): void;
    private announce;
}
/**
 * A room shared by the tabs of one browser (BroadcastChannel), with presence
 * from heartbeats. Handy for trying multiplayer on one machine, and the
 * fallback when no online service is configured.
 */
declare class BroadcastChannelTransport implements NetTransport {
    private readonly room;
    readonly selfId: string;
    private channel;
    private messageHandler;
    private peersHandler;
    private readonly seen;
    private heartbeat;
    private self;
    constructor(room: string);
    connect(joinedAt: number, name?: string): Promise<void>;
    send(message: NetMessage): void;
    onMessage(handler: (message: NetMessage, from: string) => void): void;
    onPeers(handler: (peers: readonly NetPeer[]) => void): void;
    close(): void;
    private publishPeers;
}
/**
 * A transport that can be pointed at a different room (or none) while the
 * session using it keeps running — how a game moves from its title screen into
 * a matchmade room, and back out. With no room it reports no peers, so the
 * session plays offline. Each room is joined with a fresh join time, so slot
 * order in the new room is by when you arrived *there*.
 */
declare class SwitchableTransport implements NetTransport {
    private inner;
    private readonly idle;
    private name;
    private messageHandler;
    private peersHandler;
    get selfId(): string;
    /** The room transport in use, or null. */
    get current(): NetTransport | null;
    connect(_joinedAt: number, name?: string): Promise<void>;
    /** Leave the current room (if any) and join `next` (or stay out when null). */
    use(next: NetTransport | null): Promise<void>;
    send(message: NetMessage): void;
    onMessage(handler: (message: NetMessage, from: string) => void): void;
    onPeers(handler: (peers: readonly NetPeer[]) => void): void;
    close(): void;
}

/**
 * Control settings a player can change from a game's Start menu: aim inversion,
 * look sensitivity, button mapping for a controller and the keyboard, and the
 * on-screen pad's size and opacity. Pure data plus the pure transforms the input
 * layer applies, so every piece is testable without a DOM or a gamepad.
 */

/**
 * A standard-mapping gamepad's buttons (an Xbox 360 / Xbox controller), in Gamepad API index order.
 * Guide (the big Xbox button) is reported by some browsers only.
 */
declare const PAD_BUTTONS: readonly ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "LS", "RS", "Up", "Down", "Left", "Right", "Guide"];
type PadButton = (typeof PAD_BUTTONS)[number];
/** What a physical control does: press a console button, open the Start menu, or nothing. */
type ControlTarget = ConsoleButton | "start" | null;
interface ControlSettings {
    /** Invert the right stick's vertical axis (push up to aim down). */
    readonly invertY: boolean;
    /** Look sensitivity, 0.25..3: scales the right stick before the game reads it. */
    readonly lookSensitivity: number;
    /** Controller buttons → what they do. */
    readonly padBindings: Readonly<Record<PadButton, ControlTarget>>;
    /** Keyboard `KeyboardEvent.code` → console button. */
    readonly keyBindings: Readonly<Record<string, ConsoleButton>>;
    /** On-screen pad opacity, 0.2..1. */
    readonly touchOpacity: number;
    /** On-screen pad size, 0.7..1.4. */
    readonly touchScale: number;
}
/** Face buttons to face buttons, the D-pad to the D-pad, and the triggers doubling up. */
declare const DEFAULT_PAD_BINDINGS: Readonly<Record<PadButton, ControlTarget>>;
declare const DEFAULT_KEY_BINDINGS: Readonly<Record<string, ConsoleButton>>;
/** Keys that open the Start menu (unless rebound to a console button). */
declare const START_KEYS: readonly string[];
declare const DEFAULT_CONTROL_SETTINGS: ControlSettings;
/**
 * Read stored settings (e.g. from localStorage), keeping only valid fields and
 * falling back to the defaults for anything missing or malformed.
 */
declare function parseControlSettings(value: unknown, defaults?: ControlSettings): ControlSettings;
/**
 * The sticks as the game should see them: the right stick scaled by the look
 * sensitivity (reaching full lean sooner when it is above 1) and its vertical
 * axis flipped when aim is inverted. The left stick passes through.
 */
declare function applyLookSettings(axes: readonly number[], settings: Pick<ControlSettings, "invertY" | "lookSensitivity">): [number, number, number, number];
/** A physical stick reading with a radial dead zone, rescaled to reach full lean. */
declare function deadZoned(x: number, y: number, deadZone?: number): [number, number];
/** One gamepad snapshot (the fields the reader uses from the Gamepad API). */
interface PadSnapshot {
    readonly axes: readonly number[];
    readonly buttons: readonly {
        readonly pressed: boolean;
        readonly value: number;
    }[];
}
/**
 * A gamepad in the standard layout. Browsers remap most controllers to it
 * (`mapping: "standard"`), but some report a raw layout instead — Firefox on
 * Linux gives an Xbox 360 pad in evdev order (Back 6, Start 7, Guide 8, the
 * triggers and D-pad as axes), where Start would otherwise read as a trigger.
 * Known raw Xbox layouts are translated; anything else passes through as is.
 */
declare function standardizePad<T extends PadSnapshot & {
    readonly mapping?: string;
    readonly id?: string;
}>(pad: T): PadSnapshot;
/**
 * What a gamepad is doing: the console-button mask its bindings press, both
 * sticks (dead-zoned), and whether a control bound to "start" is held.
 */
declare function readPad(raw: PadSnapshot & {
    readonly mapping?: string;
    readonly id?: string;
}, bindings: Readonly<Record<PadButton, ControlTarget>>): {
    mask: number;
    axes: [number, number, number, number];
    start: boolean;
};

/**
 * Deterministic replays.
 *
 * A fantasy console is deterministic — fixed timestep, a host-controlled clock,
 * and a per-frame gamepad bitmask. So a full session is captured by recording
 * the input stream plus enough to reproduce initial state (cart identity + RNG
 * seed). Replaying feeds the same inputs back into a fresh console.
 *
 * Input rarely changes every frame, so the stream is run-length encoded: an
 * entry is stored only when the mask changes. This module is pure (no DOM, no
 * engine), so the recorder/playback machinery is fully unit-testable and can run
 * server-side for score verification.
 *
 * NOTE: bit-exact *engine* reproduction additionally requires the cart's RNG to
 * be seeded from `seed`. The host-side machinery here is complete; wiring the
 * seed into the engine shim (a `cbx_seed`) is the remaining determinism step.
 */

/** Bumped when the serialized shape changes incompatibly. */
declare const REPLAY_VERSION = 1;
/** A fresh non-negative 31-bit seed for a new recording. */
declare function randomSeed(): number;
/** A change in the gamepad bitmask, effective from `frame` onward. */
interface InputChange {
    frame: number;
    mask: number;
}
/** A recorded session. */
interface Replay {
    version: number;
    modelId: ModelId;
    /** Identity of the cart this was recorded against (see {@link hashCart}). */
    cartHash: string;
    seed: number;
    frameCount: number;
    /** Run-length input stream: one entry per mask change. */
    inputs: InputChange[];
}
/** Metadata needed to start a recording. */
interface ReplayMeta {
    modelId: ModelId;
    cartHash: string;
    seed?: number;
}
/** Raised when a serialized replay cannot be parsed or is the wrong version. */
declare class ReplayError extends Error {
    constructor(message: string);
}
/**
 * Records the per-frame input stream as run-length input changes. Call
 * {@link record} exactly once per ticked frame with that frame's gamepad mask.
 */
declare class ReplayRecorder {
    private readonly meta;
    private readonly inputs;
    private frame;
    private lastMask;
    constructor(meta: ReplayMeta);
    record(mask: number): void;
    get frameCount(): number;
    /** Produces the immutable replay captured so far. */
    finish(): Replay;
}
/**
 * Reconstructs the per-frame mask from a recorded input stream. Designed for
 * linear playback (frames queried in order); querying an earlier frame rewinds
 * and re-scans, so seeking still works, just not in constant time.
 */
declare class ReplaySource {
    private readonly inputs;
    private cursor;
    private currentMask;
    private lastFrame;
    constructor(inputs: InputChange[]);
    /** The gamepad mask effective at the given frame. */
    maskForFrame(frame: number): number;
}
/**
 * Stable, non-cryptographic identity hash of cart bytes (FNV-1a, 32-bit). Used
 * to confirm a replay is being applied to the same cartridge it was recorded on.
 */
declare function hashCart(bytes: Uint8Array): string;
/** Serializes a replay to a compact JSON string. */
declare function serializeReplay(replay: Replay): string;
/** Parses and validates a serialized replay. */
declare function parseReplay(json: string): Replay;

/**
 * Public types for the player's dynamic lighting layer. Kept DOM-free so hosts
 * and tests can build lighting scenes without importing the renderer.
 */
/**
 * How a light casts. Defaults to "point" everywhere it is omitted, so a bare
 * `{x, y, z, color, radius}` keeps meaning exactly what it always has.
 *
 * - `point`       an omnidirectional pool at (x, y, z), fading to nothing at `radius`.
 * - `directional` a distant key (sun / moon): parallel rays with no falloff, so
 *                 x/y/z and radius are ignored and only `direction` and `color`
 *                 matter. This is the sun/moon shaft central to the cinematic look.
 * - `spot`        a cone from (x, y, z) opening along `direction`, gated by
 *                 `coneCos` and attenuated by `radius` like a point light.
 */
type LightKind = "point" | "directional" | "spot";
/** A coloured light positioned over the console framebuffer. */
interface Light {
    /** Column in native framebuffer pixels (0 = left). Ignored for directional. */
    x: number;
    /** Row in native framebuffer pixels (0 = top). Ignored for directional. */
    y: number;
    /** Height above the surface, in pixel units; larger = a broader, softer pool. */
    z: number;
    /** Light colour; each channel is a multiplier (may exceed 1 for a hot light). */
    color: readonly [number, number, number];
    /** Reach in pixels; brightness falls to zero at this distance. Ignored for directional. */
    radius: number;
    /** Cast type. Omit for a point light (the historical default). */
    kind?: LightKind;
    /**
     * Unit direction, meaning per kind:
     * - directional: the direction that points *toward* the light (where the sun is).
     * - spot: the cone axis — the direction the beam travels.
     * Its z component is taken as non-negative (a light on the viewer's side of the
     * scene); the runtime derives it when a producer only supplies x and y.
     * Ignored for point lights.
     */
    direction?: readonly [number, number, number];
    /**
     * Spot cone: cosine of the inner (full-bright) half-angle, 0..1. A fixed
     * softness feathers the edge to zero just outside it. Ignored unless spot.
     */
    coneCos?: number;
}
/** Context passed to a per-frame light provider. */
interface LightingFrameContext {
    /** Presented-frame counter since the layer was created. */
    frame: number;
    /** High-resolution timestamp in milliseconds. */
    timeMs: number;
    /** Native framebuffer width in pixels. */
    width: number;
    /** Native framebuffer height in pixels. */
    height: number;
}
/**
 * A material buffer aligned to the framebuffer: one RGBA texel per pixel with
 * R = normal-direction index (0..15), G = height (0..255 -> 0..HEIGHT_MAX),
 * B = specular strength, A = roughness. Optional — without it the layer lights
 * flat pixels (coloured, attenuated pools over the cart's own art).
 */
type MaterialBuffer = Uint8Array;
/**
 * How the player relights a cartridge's frame. The host supplies the lights
 * (typically animated per frame) and, optionally, a material buffer to unlock
 * per-pixel normals, specular glints, and height-field shadows.
 */
interface LightingOptions {
    /** Minimum brightness in shadow, 0..1. Default 0.16. */
    ambient?: number;
    /** Tint of the ambient floor, each channel 0..1. Default a cool dusk. */
    ambientColor?: readonly [number, number, number];
    /** Bloom the bright pixels (emissive + hot speculars). Default true. */
    bloom?: boolean;
    /** Cast height-field shadows. Needs a material buffer with height. Default false. */
    shadows?: boolean;
    /**
     * Bilinearly interpolate the per-pixel material fields instead of using the
     * raw 4-bit quantised values: the 16-direction normals (cinematic gap #2) and
     * the height/specular/roughness ramps alike. Kills the facet banding on curved
     * surfaces and the stair-stepping on painted ramp gradients. A no-op on
     * flat/unmapped materials, whose fields are uniform. Default true.
     */
    smoothNormals?: boolean;
    /**
     * When true, a frame with no lights (neither cart- nor host-provided) is shown
     * unlit — the cart looks exactly as it would without lighting until it emits a
     * light. This is what lets the app enable lighting for every cart safely:
     * ordinary carts are untouched, lighting-aware carts light up on their own.
     * Default false (a frame with no lights is drawn at the ambient floor).
     */
    autoDetect?: boolean;
    /**
     * The per-pixel material buffer, or a provider called each frame. Omit to
     * light flat pixels.
     */
    material?: MaterialBuffer | ((context: LightingFrameContext) => MaterialBuffer | null);
    /**
     * Supersample factor for the lighting pass: 1 disables it (crisp, cheapest),
     * 2 is the smooth default. Higher factors de-band the 4-bit material fields
     * harder — the smoothing only engages when the light pass renders above the
     * material resolution — at an N² fragment-shading cost. Omit to auto-pick: 2
     * for standard-resolution consoles, 1 for large framebuffers (e.g. the Pro
     * core) where the 4× cost is not worth it. Clamped to 1..4.
     */
    supersample?: number;
    /**
     * Returns host-provided lights for a frame, called once per presented frame.
     * Optional: a cart can instead emit its own lights via `cartbox.light(...)`,
     * and when both are present they are combined. Omit both and the frame is lit
     * by ambient alone.
     */
    lights?: (context: LightingFrameContext) => readonly Light[];
}
/** A relightable scene handed to the renderer for a single frame. */
interface LightingScene {
    lights: readonly Light[];
    ambient: number;
    ambientColor: readonly [number, number, number];
    bloom: boolean;
    shadows: boolean;
    /** Bilinearly interpolate the quantised material fields (normals + ramps) to remove banding. */
    smoothNormals?: boolean;
    /** Skip lighting entirely and present the albedo unchanged (see autoDetect). */
    unlit?: boolean;
}

/**
 * Event mailbox decoder (Platform P2).
 *
 * Carts emit platform events (achievements, scores, stats) by writing to a
 * reserved slice of persistent memory via the cartbox SDK. The engine exposes
 * that slice as u32 words; this module decodes new events since the last read.
 *
 * The reserved window is 64 pmem words, shared by two sub-protocols:
 *
 *   Events (words 0..24): word[0] is a monotonic sequence counter; words 1..24
 *   are a ring of {@link EVENT_CAPACITY} 3-word records {type, id, value}. The
 *   host reads the ring every tick, so a small capacity is plenty. A burst that
 *   overflows the ring drops the oldest rather than reading stale data.
 *
 *   Lights (words 25..61): word[25] is a light count; each of up to
 *   {@link LIGHTS_CAPACITY} records is {@link LIGHT_STRIDE} words
 *   {x, y, z, radius, packedRGB, intensity*256}. Unlike events, lights are
 *   per-frame *state*: the cart rewrites the whole block each tick (clear + add),
 *   and the host reads the latest set to relight the frame.
 *
 *   Camera (words 62..63): the parallax-scene backdrop position a cart publishes
 *   via `cartbox.camera(x, y)`, so a gameplay-driven backdrop can pan instead of
 *   only auto-scrolling. Like lights it is per-frame state: two signed
 *   fixed-point words (× {@link CAMERA_SCALE}) for x and y. An unset camera reads
 *   as (0, 0), which adds nothing to the scene's own auto-scroll.
 *
 *   Mesh camera (words 64..71): the orbit camera a cart drives its 3D meshes with
 *   via `cartbox.meshcam(yaw, pitch, distance, fov)`, so runtime meshes stop
 *   auto-orbiting and follow gameplay. Per-frame state like the lights and camera:
 *   word 64 is a control flag (bit 0 = active this frame — an unset block reads 0
 *   and leaves the player's auto-orbit in charge, so existing carts are
 *   unaffected), then yaw/pitch (× {@link MESH_CAM_ANGLE_SCALE}), distance
 *   (× {@link MESH_CAM_DIST_SCALE}, 0 = auto-fit), a target offset x/y/z from the
 *   scene centre (× {@link MESH_CAM_DIST_SCALE}), and fov (× {@link MESH_CAM_ANGLE_SCALE}, 0 = default).
 *
 * This module is pure — no engine, no DOM — so the protocol is unit-testable.
 */

declare const MAILBOX_TYPE_ACHIEVEMENT = 1;
declare const MAILBOX_TYPE_SCORE = 2;
declare const MAILBOX_TYPE_PROGRESS = 3;
/** Total reserved pmem words (mirrors CBX_MAILBOX_WORDS in the engine shim). */
declare const MAILBOX_WORDS = 137;
/** Event ring capacity. Small on purpose: the host drains the ring every tick. */
declare const EVENT_CAPACITY = 8;
/** Word index of the light-count header (just past the event ring). */
declare const LIGHTS_BASE: number;
/** Maximum cart-emitted lights (matches the renderer's light limit). */
declare const LIGHTS_CAPACITY = 6;
/** Words per light record: x, y, z, radius, packedRGB, intensity*256. */
declare const LIGHT_STRIDE = 6;
/** Word index of the cart-published parallax camera, just past the lights block. */
declare const CAMERA_BASE: number;
/**
 * Fixed-point scale for the camera's x/y, stored as signed 32-bit words. 16 gives
 * sub-pixel panning (parallax factors scale it further) with a range of ±134M px
 * — far beyond any cart world.
 */
declare const CAMERA_SCALE = 16;
/** Word index of the cart-driven mesh camera block, just past the parallax camera. */
declare const MESH_CAM_BASE: number;
/** Words in the mesh-camera block: flags, yaw, pitch, distance, targetX/Y/Z, fov. */
declare const MESH_CAM_STRIDE = 8;
/** Fixed-point scale for the mesh camera's yaw/pitch/fov (radians × this), signed. */
declare const MESH_CAM_ANGLE_SCALE = 1024;
/** Fixed-point scale for the mesh camera's distance + target offset (world units × this), signed. */
declare const MESH_CAM_DIST_SCALE = 256;
/** Word index of the mesh-pose block's count header, just past the mesh camera. */
declare const MESH_POSE_BASE: number;
/** Maximum mesh instances a cart can pose per frame. */
declare const MESH_POSE_CAPACITY = 8;
/** Words per pose record: index/flags, posX/Y/Z, yaw/pitch/roll, scale. */
declare const MESH_POSE_STRIDE = 8;
/** Bit 8 of a pose record's index word: hide this instance this frame. */
declare const MESH_POSE_HIDDEN: number;
type MailboxEventKind = "achievement" | "score" | "progress" | "request" | "unknown";
interface MailboxEvent {
    kind: MailboxEventKind;
    /** Raw numeric type code. */
    type: number;
    /** Hashed string id (see {@link hashEventId}); 0 for score events. */
    id: number;
    /** Event payload (e.g. the score). */
    value: number;
}
interface MailboxRead {
    events: MailboxEvent[];
    /** The sequence counter to remember for the next read. */
    seq: number;
}
/**
 * Decodes new events from the mailbox words.
 *
 * @param words The mailbox region (word[0] = sequence counter).
 * @param lastSeq The sequence counter from the previous read.
 * @returns The new events and the sequence to remember next time.
 */
declare function decodeMailbox(words: Uint32Array, lastSeq: number): MailboxRead;
/**
 * Decodes the lights a cart wrote this frame via `cartbox.light(...)`.
 *
 * Lights are per-frame state, not events: the block always holds the latest set
 * the cart published, so there is no sequence to track. Colours are stored as a
 * packed 0xRRGGBB word scaled by a fixed-point intensity; here they become the
 * renderer's per-channel multipliers.
 *
 * @param words The mailbox window (same array {@link decodeMailbox} reads).
 * @returns The decoded lights, clamped to {@link LIGHTS_CAPACITY}.
 */
declare function decodeLights(words: Uint32Array): Light[];
/** A point light in a 3D scene's world units, published with `cartbox.light3d`. */
interface WorldLight {
    readonly position: readonly [number, number, number];
    /** Falloff radius in world units. */
    readonly range: number;
    /** Colour with the intensity folded in. */
    readonly color: readonly [number, number, number];
}
/** Decodes the world-space point lights a cart published this frame (`cartbox.light3d`). */
declare function decodeWorldLights(words: Uint32Array): WorldLight[];
/** A backdrop camera position in cart pixels. */
interface MailboxCamera {
    x: number;
    y: number;
}
/**
 * Decodes the parallax-scene camera a cart published this frame via
 * `cartbox.camera(x, y)`.
 *
 * The two words are signed fixed-point: reinterpreted from u32 to int32 (`| 0`)
 * and divided by {@link CAMERA_SCALE}. A cart that never calls `cartbox.camera`
 * leaves the words zero, so this returns (0, 0) — which the scene adds to its own
 * auto-scroll, leaving auto-scroll-only carts unchanged.
 *
 * @param words The mailbox window (same array {@link decodeMailbox} reads).
 */
declare function decodeCamera(words: Uint32Array): MailboxCamera;
/** An orbit camera a cart drives its 3D meshes with, all fields already de-scaled. */
interface MailboxMeshCamera {
    /** Yaw around the scene centre, radians. */
    yaw: number;
    /** Pitch above the horizon, radians. */
    pitch: number;
    /** Distance from the target, world units; null means auto-fit to the scene. */
    distance: number | null;
    /** Target offset from the scene centre, world units. */
    target: [number, number, number];
    /** Vertical field of view, radians; null means the player's default. */
    fov: number | null;
    /** Composite the cart's 2D frame as a HUD over the 3D scene (first-person mode). */
    hud: boolean;
}
/**
 * Decodes the mesh camera a cart published this frame via `cartbox.meshcam(...)`.
 *
 * Returns null when the block's active flag is clear — the common case for every
 * cart that doesn't drive its meshes — so the player keeps auto-orbiting. Like
 * the lights and parallax camera this is per-frame state, not an event, so there
 * is no sequence to track: the block always holds the latest pose the cart set.
 *
 * @param words The mailbox window (same array {@link decodeMailbox} reads).
 */
declare function decodeMeshCamera(words: Uint32Array): MailboxMeshCamera | null;
/** A per-instance transform a cart applies to one mesh, on top of its authored placement. */
interface MailboxMeshPose {
    /** Which scene instance (index into the mesh sidecar) this poses. */
    index: number;
    /** Hide the instance this frame (skip drawing it). */
    hidden: boolean;
    /** Local translation, world units. */
    position: [number, number, number];
    /** Local rotation as (yaw about Y, pitch about X, roll about Z), radians. */
    rotation: [number, number, number];
    /** Local uniform-ish scale; 1 when the cart omits it. */
    scale: number;
    /** Animation frame (0 = the base mesh, k = the instance's frame k). Optional for old callers. */
    frame?: number;
    /** Tint-palette index for tintable materials (0 = none). */
    tint?: number;
    /** Draw on the front layer, over everything else, so it never clips into walls. */
    front?: boolean;
}
/**
 * Decodes the per-instance mesh poses a cart published this frame via
 * `cartbox.meshpose(...)`. Like the lights, the block is a count header followed
 * by a ring of records the cart rewrites each frame (clear + add), so there is no
 * sequence to track. An empty block (count 0 — the common case) yields no poses,
 * leaving every instance at its authored transform.
 *
 * Rotations come back in radians (the SDK's unit); the player converts to the
 * degrees `composeModelMatrix` expects. Scale 0 is passed through untouched, so a
 * cart can collapse an instance to nothing deliberately (`cartbox.meshpose(i, …, 0)`).
 *
 * @param words The mailbox window (same array {@link decodeMailbox} reads).
 */
declare function decodeMeshPoses(words: Uint32Array): MailboxMeshPose[];
/**
 * FNV-1a 32-bit hash of a string event id. Mirrors the hash in the cartbox SDK
 * so the platform can map a mailbox id back to the achievement/stat key.
 */
declare function hashEventId(id: string): number;

/**
 * The playtest profiler (ENGINE_ROADMAP.md, Phase 5): where each frame's time
 * goes, measured on the host, over the last second or so of frames.
 *
 * Sections (milliseconds of main-thread time per frame):
 * - `cart`: the engine's tick — the cart's Lua, its 2D drawing and the chip
 *   sound synthesis all run inside it, and can't be told apart from outside.
 * - `runtime`: physics, spawning, animation and timelines (the runtime channel).
 * - `audio`: handing the frame's samples to Web Audio.
 * - `net`: the multiplayer session's work before and after the tick.
 * - `render`: presenting the frame, everything included; of it, `shadow` (the
 *   shadow map), `sky` and `scene` (drawing the 3D scene — on the GPU backends,
 *   submitting it and compositing the newest readback) are also shown alone.
 *
 * A frame is one console tick; the render that follows ticks counts toward the
 * last of them. Pure apart from the clock the caller reads.
 */
declare const PROFILE_SECTIONS: readonly ["cart", "runtime", "audio", "net", "render", "shadow", "sky", "scene"];
type ProfileSection = (typeof PROFILE_SECTIONS)[number];
/** Frames the rolling window covers. */
declare const PROFILE_WINDOW = 60;
/** What the 3D renderer did in its last frame. */
interface RenderStats {
    readonly drawCalls: number;
    readonly instances: number;
    readonly triangles: number;
    /** GPU time of the scene pass, when the browser can time it (else null). */
    readonly gpuMs: number | null;
}
interface SectionStats {
    /** Average milliseconds per frame over the window. */
    readonly avg: number;
    /** The slowest frame's. */
    readonly max: number;
}
interface ProfileSnapshot {
    /** Frames in the window. */
    readonly frames: number;
    readonly sections: Readonly<Record<ProfileSection, SectionStats>>;
    /** All sections but the render sub-passes, per frame. */
    readonly total: SectionStats;
    /** The 3D renderer's last frame, when the cart has a 3D scene. */
    readonly render: (RenderStats & {
        readonly backend: string;
    }) | null;
    readonly memory: {
        /** The engine's WebAssembly memory. */
        readonly wasm: number;
        /** The page's JavaScript heap (Chromium only; else null). */
        readonly jsHeap: number | null;
        /** The 3D scene's geometry, textures and render targets (an estimate), when it has one. */
        readonly scene: number | null;
    };
    /** Multiplayer traffic, bytes per second over the window, when the cart is online. */
    readonly net: {
        readonly sentPerSecond: number;
        readonly receivedPerSecond: number;
        readonly sent: number;
        readonly received: number;
    } | null;
}
declare class Profiler {
    private readonly samples;
    /** The slot being filled (the open frame). */
    private slot;
    private filled;
    /** A frame has been opened (the first nextFrame opens one, closing nothing). */
    private open;
    /** Add `ms` to the open frame's `section`. */
    add(section: ProfileSection, ms: number): void;
    /** Close the open frame and start the next. */
    nextFrame(): void;
    /** Averages and peaks over the closed frames in the window. */
    sections(): {
        frames: number;
        sections: Record<ProfileSection, SectionStats>;
        total: SectionStats;
    };
    reset(): void;
}
/**
 * Bytes a 3D scene keeps on the GPU, estimated from what it draws: each mesh's
 * interleaved vertices (32 bytes: position, normal, UV) and 32-bit indices once,
 * each texture's RGBA8 pixels once, and the colour + depth targets.
 */
declare function estimateSceneBytes(instances: readonly {
    readonly mesh: {
        readonly primitives: readonly {
            readonly positions: ArrayLike<number>;
            readonly indices: ArrayLike<number>;
        }[];
    };
    readonly textures?: readonly ({
        readonly width: number;
        readonly height: number;
    } | null | undefined)[];
}[], width: number, height: number): number;

/**
 * The editor's debug channel (ENGINE_ROADMAP.md, Phase 5): a 4 KB block in the
 * console's free RAM, just below the runtime block (see physics/protocol.ts),
 * shared by the cart's Lua and the host.
 *
 * - Console: a prelude replaces `trace()` so each message lands in a ring here
 *   (the engine's own trace callback goes nowhere), and replaces
 *   `debug.traceback` — which the core calls on every runtime error — with one
 *   that names cart lines rather than lines of the merged, SDK-prefixed source
 *   and fits the core's 256-byte error buffer.
 * - Debugger: with the cart's code instrumented (see instrument.ts), `TIC` runs
 *   in a coroutine and the statement hooks yield at a breakpoint or a step. The
 *   Lua then writes where it stopped — the call stack, the paused function's
 *   locals and upvalues, and the watch expressions' values — and the host
 *   stops ticking until it writes a command (continue, step into/over/out).
 * - The host writes a magic word, the cart's line offset and line count, the
 *   breakpoints and the watch expressions before every tick, and reads the
 *   traces and any pause after it.
 *
 * Only the editor's playtest adds this prelude; a published cart never has it.
 * All words are little-endian int32.
 */

/** Commands to a stopped cart. 5 re-reads the pause information (after the watches change) without moving on. */
declare const DebugCommand: {
    readonly continue: 1;
    readonly into: 2;
    readonly over: 3;
    readonly out: 4;
    readonly refresh: 5;
};
type DebugStep = Exclude<keyof typeof DebugCommand, "refresh">;
/** Where the debug block sits in Lua's RAM address space. */
declare function debugBlockAddress(layout: RamLayout): number;
/**
 * Lines of code above the cart's own in the source the engine runs: `final` is
 * the cart's code with preludes stacked on top (see prependLuaCode) and perhaps
 * a postlude after it, so error line N in the merged source is cart line
 * N − offset. 0 when `final` doesn't contain the cart's code past its start
 * (nothing was added, or it isn't Lua).
 */
declare function codeLineOffset(original: string | null, final: string | null): number;
/**
 * Rewrite the core's `[string "…"]:N:` positions to cart lines (`line N:`); a
 * position inside the injected code (N ≤ offset) becomes `cartbox:`, since it
 * has no cart line. Positions the debug prelude already rewrote are left alone.
 */
declare function remapErrorLines(message: string, offset: number): string;
/** One frame of a runtime error's call stack, innermost first. */
interface ErrorFrame {
    readonly name: string;
    readonly line: number;
}
/**
 * The call stack the debug prelude appends to an error (`at update:12 < TIC:40`),
 * innermost first; empty when the message carries none.
 */
declare function errorStack(message: string): ErrorFrame[];
/**
 * The prelude for the playtest, over the block at `address`: trace capture and
 * cart-line tracebacks, and with `debugger` the breakpoint machinery the
 * instrumented code calls (pair it with {@link debugPostlude}).
 */
declare function debugSdkLua(address: number, options?: {
    debugger?: boolean;
}): string;
/** Appended after the cart's code (so its lines don't move): runs TIC through the debugger. */
declare function debugPostlude(): string;
/** Where the cart stopped, as the debugger reads it. */
interface PauseInfo {
    readonly line: number;
    /** Innermost first. */
    readonly stack: readonly ErrorFrame[];
    readonly locals: readonly {
        readonly name: string;
        readonly value: string;
    }[];
    readonly upvalues: readonly {
        readonly name: string;
        readonly value: string;
    }[];
    /** One per watch expression, in order; null value for a blank one. */
    readonly watches: readonly {
        readonly value: string;
        readonly error: boolean;
    }[];
}
/** Parse the pause information the Lua wrote (see {@link DBG_INFO_AT}); `watchCount` sizes the result's watches. */
declare function parsePauseInfo(line: number, text: string, watchCount: number): PauseInfo;
/** Read a pause from the block, or null while the cart runs. */
declare function readPause(block: DataView, watchCount: number): PauseInfo | null;
/** Tell a stopped cart how to go on. */
declare function sendDebugCommand(block: DataView, command: number): void;
/** A trace the cart printed. */
interface TraceLine {
    readonly text: string;
    readonly color: number;
}
/** Arm the block for the next tick: magic, and where the cart's lines are in the merged source. */
declare function armDebugBlock(block: DataView, lineOffset: number, lineCount?: number): void;
/** Write the breakpoint lines (at most {@link DBG_BPS_MAX}) and bump the version so the Lua reloads them. */
declare function writeBreakpoints(block: DataView, lines: readonly number[]): void;
/** Write the watch expressions, one per line; returns how many fit. */
declare function writeWatches(block: DataView, expressions: readonly string[]): number;

/**
 * Gap #3 — a runtime parallax + atmosphere compositor.
 *
 * The editor already has a preview-only layered-scene compositor
 * (packages/editor/src/render/layeredScene.ts) with parallax projection, but no
 * *aerial perspective*: the thing that makes REPLACED / THE LAST NIGHT read as
 * deep space rather than stacked stickers — distant layers go dimmer, bluer,
 * lower-contrast and haze toward the sky. Carts hand-roll parallax scroll in Lua
 * today; the atmosphere is the hard part they can't easily fake.
 *
 * This module is the reusable core of the runtime system: pure, DOM-free,
 * RGBA-in / RGBA-out (same shape as renderLitRgba / the editor compositor), so it
 * can be unit-tested and later driven by a cart-facing SDK/sidecar and composited
 * ahead of the lighting + post-FX passes. Intended app home:
 * packages/player/src/scene/parallaxScene.ts.
 */
type Rgb$1 = readonly [number, number, number];
/** One depth layer of the scene. */
interface ParallaxLayer {
    /** Straight-alpha RGBA pixels, width*height*4 bytes. */
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
    /**
     * Depth, 0 (nearest, on the camera plane) .. 1 (farthest, at the horizon).
     * Drives both how little the layer parallaxes and how much atmosphere it takes.
     */
    depth: number;
    /**
     * How much the layer shifts with the camera: 1 = locked to the world (full
     * parallax), 0 = locked to the screen. Defaults to `1 - depth` so near layers
     * slide under far ones without the author computing anything.
     */
    parallax?: number;
    /** Tile the layer horizontally when the camera scrolls past its edge. Default true. */
    wrapX?: boolean;
    /** Vertical placement in the output, in pixels (align a horizon). Default 0. */
    offsetY?: number;
    /**
     * Horizontal placement in the output, in pixels, ADDED to the parallax shift.
     * Default 0. Lets a layer drift independently of the camera (e.g. animated fog).
     */
    offsetX?: number;
    /** Layer-wide alpha multiplier, 0..1. Default 1 (fully as authored). */
    opacity?: number;
    /**
     * Layer-wide RGB gain. Default 1. Values > 1 brighten the layer's contribution
     * (an animated emissive glow), which the post-FX bloom pass then picks up.
     */
    emissive?: number;
    /**
     * The aerial-perspective haze is already baked into {@link pixels} (see
     * {@link prehazeLayers}), so compositing must not apply it again. A layer's haze
     * is frame-invariant — it depends only on the layer's depth and the scene
     * atmosphere — so the runtime bakes it once and skips it in the per-frame loop.
     */
    hazed?: boolean;
}
/** Aerial-perspective parameters, shared by the whole scene. */
interface AtmosphereParams {
    /** The haze/sky colour distance fades toward (each channel 0..255). */
    fog: Rgb$1;
    /** 0..1 — how strongly the farthest layer is pulled toward `fog`. */
    density: number;
    /** 0..1 — how much colour the farthest layer loses (aerial desaturation). */
    desaturate: number;
    /** 0..1 — how much the farthest layer's contrast flattens (haze lifts blacks). */
    lift: number;
}
/** The camera, in world pixels; only its offset matters for parallax. */
interface ParallaxCamera {
    x: number;
    y: number;
}
/**
 * Bake each layer's aerial-perspective haze into its pixels once, returning new
 * layers flagged {@link ParallaxLayer.hazed} so {@link composeParallax} skips the
 * per-pixel haze in the hot path.
 *
 * A layer's haze depends only on its depth and the (constant) atmosphere, so it
 * is identical every frame — computing it once here instead of per pixel per
 * frame is what keeps an N-layer scene inside the 60fps budget. The input layers
 * are not mutated; a layer that takes no haze is returned with its pixels shared.
 */
declare function prehazeLayers(layers: readonly ParallaxLayer[], atmosphere: AtmosphereParams): ParallaxLayer[];
/**
 * Composite parallax layers into `out` (outW×outH RGBA), far to near, applying
 * per-layer aerial perspective by depth. `out` should already hold the sky /
 * clear colour; layers blend over it by their own alpha.
 *
 * Parallax: a layer shifts by `-camera * parallaxOf(layer)`, so the nearest
 * layers slide fastest. Horizontal wrap tiles a layer seamlessly; vertical uses
 * `offsetY` and clips.
 */
declare function composeParallax(out: Uint8ClampedArray, outW: number, outH: number, layers: readonly ParallaxLayer[], camera: ParallaxCamera, atmosphere: AtmosphereParams): void;

/**
 * Gap #3 part 2 — the cart-facing `scene` model.
 *
 * A cart declares a parallax scene the way it declares fx / rig / materials:
 * a JSON sidecar validated on load. Each layer points at a region of the cart's
 * OWN sprite sheet (authored in the editor), sits at a depth, and the runtime
 * composites the layers with parallax scroll + aerial-perspective atmosphere
 * (see parallaxScene.ts) BEHIND the cart's interactive foreground. This is what
 * turns "hand-roll parallax + fake haze in Lua" into "author art, declare depth".
 *
 * This module is the pure, DOM-free data + validation half (mirrors the defensive
 * parse style of apps/web/src/lib/rig.ts): parse untrusted JSON into a safe
 * SceneSpec, dropping anything malformed rather than throwing. The rendering half
 * is sceneRender.ts. Intended app homes: apps/web/src/lib/scene.ts (parse) +
 * packages/player/src/scene/ (render).
 */

/** A region of the sprite sheet backing one parallax layer. */
interface SpriteRegion {
    /** Sprite page: 0 (fg) or 1 (bg). */
    page: 0 | 1;
    /** Top-left tile index of the region within the page. */
    tile: number;
    /** Region size in tiles. */
    tilesW: number;
    tilesH: number;
}
/** One declared parallax layer. */
interface SceneLayer {
    source: SpriteRegion;
    /** 0 (nearest) .. 1 (horizon) — drives parallax factor + atmosphere. */
    depth: number;
    /** Optional explicit parallax factor (else derived from depth). */
    parallax?: number;
    /** Tile horizontally as the camera scrolls. Default true. */
    wrapX?: boolean;
    /** Vertical placement in the backdrop, in pixels. Default 0. */
    offsetY?: number;
}
/** How the scene camera moves each frame. */
interface SceneCamera {
    /** Auto-scroll in px/frame (a living backdrop with no cart input). Default 0. */
    autoScrollX?: number;
    autoScrollY?: number;
}
/** A full declared scene. */
interface SceneSpec {
    layers: SceneLayer[];
    atmosphere: AtmosphereParams;
    camera: SceneCamera;
    /**
     * The palette index the cart leaves as "background": the runtime shows the
     * parallax backdrop through every pixel the cart drew in this colour, and keeps
     * the rest as the cart's own foreground. Default 0 (TIC-80's conventional
     * background colour).
     */
    keyColor: number;
}
/** The default atmosphere — a cool dusk haze, if a cart omits it. */
declare const DEFAULT_ATMOSPHERE: AtmosphereParams;
/**
 * Parse untrusted sidecar JSON into a SceneSpec, or null when there is no usable
 * scene (no object, or every layer malformed). Layers are validated individually
 * and bad ones dropped — losing one layer beats refusing the whole backdrop.
 */
declare function parseScene(raw: unknown): SceneSpec | null;

/**
 * Cinematic gap #1 (animation timeline) — the cart-facing `anim` model.
 *
 * A cart declares ambient motion the way it declares fx / scene / rig: a JSON
 * sidecar validated on load. The runtime plays it back host-side from the frame
 * clock (no cart Lua, no mailbox words — the mailbox is full), which is exactly
 * what the REPLACED / THE LAST NIGHT look needs: flickering neon, drifting fog,
 * a guttering candle, idle sway. See Working/cinematic-artstyle/anim-timeline-spec.md.
 *
 * This module is the pure, DOM-free data + validation half (mirrors the defensive
 * parse style of scene/sceneModel.ts + apps/web/src/lib/rig.ts): parse untrusted
 * JSON into a safe AnimSpec, dropping anything malformed rather than throwing. The
 * playback half is animPlayer.ts. Intended app homes: apps/web/src/lib/anim.ts
 * (parse) + packages/player/src/anim/ (playback).
 */

/** How a sprite clip repeats. */
type AnimMode = "loop" | "pingpong" | "once";
/** How a property track repeats past its key range. */
type TrackMode = "loop" | "pingpong" | "hold";
/** Interpolation on the segment beginning at a keyframe. */
type Ease = "linear" | "step" | "smooth";
/** A named sprite-frame animation drawn from the cart's own sheet. */
interface AnimClip {
    name: string;
    /** Ordered frames; each a region of the sprite sheet. */
    frames: SpriteRegion[];
    /** Ticks each frame is held; always aligned 1:1 with `frames`. */
    durations: number[];
    mode: AnimMode;
}
/** One control point on a property track. */
interface Keyframe {
    /** Tick position (>= 0). */
    t: number;
    value: number;
    /** Ease applied from this key to the next. */
    ease: Ease;
}
/** Channels a track can drive on a parallax scene layer (by index). */
type LayerChannel = "opacity" | "offsetX" | "offsetY" | "emissive";
/** Channels a track can drive on a foreground placement (by index). */
type PlacementChannel = "x" | "y" | "opacity" | "scale";
/** What a track animates. Loosely coupled: scene layers are addressed by index. */
type AnimTarget = {
    kind: "sceneLayer";
    index: number;
    channel: LayerChannel;
} | {
    kind: "postfx";
    key: string;
} | {
    kind: "placement";
    index: number;
    channel: PlacementChannel;
};
/** A keyframed scalar curve bound to one target channel. */
interface AnimTrack {
    target: AnimTarget;
    /** Sorted ascending by `t`; at least one key. */
    keys: Keyframe[];
    mode: TrackMode;
    /** Loop period in ticks (loop mode only). Defaults to the last key's `t`. */
    loopLength?: number;
}
/** A clip instance drawn OVER the cart frame (animated set-dressing). */
interface AnimPlacement {
    /** References an AnimClip by name. */
    clip: string;
    x: number;
    y: number;
    /** 0 (nearest) .. 1 (far) — for future ordering; not composited in Phase A. */
    depth: number;
    /** Base opacity 0..1 (tracks may override). */
    opacity: number;
    /** Base scale > 0 (tracks may override). */
    scale: number;
}
/** A full declared animation set. */
interface AnimSpec {
    clips: AnimClip[];
    tracks: AnimTrack[];
    placements: AnimPlacement[];
}
/**
 * Parse untrusted sidecar JSON into an AnimSpec, or null when there is nothing
 * usable (no object, or no valid clips/tracks/placements). Entries are validated
 * individually and bad ones dropped — losing one clip beats refusing the whole
 * animation. Order matters: clips first (placements reference clip names), then
 * placements (tracks bounds-check placement indices), then tracks.
 */
declare function parseAnim(raw: unknown): AnimSpec | null;

/**
 * The particle sidecar data model + its defensive parser — cinematic gap #6
 * (weather and atmosphere: rain, snow, drifting embers, rolling fog). Kept DOM-free
 * so the save API validates with the same code the runtime and editor consume, the
 * way the scene and anim sidecars are.
 *
 * A cart declares a small set of emitters; the runtime {@link ./particleField.ts}
 * turns each into a deterministic, host-played particle field and the
 * {@link ./ParticleOverlaySurface.ts} composites them over the frame. Emitters
 * carry only the handful of knobs that read differently per weather — count,
 * colour, opacity, size, fall/rise speed, wind — while the per-kind *motion*
 * (streaking, sway, flicker) is baked into the field, so the sidecar stays small
 * and an author picks a preset and nudges a few sliders.
 */
/** The weather an emitter produces; also selects how the field draws and moves it. */
type ParticleKind = "rain" | "snow" | "embers" | "fog";
/** Every kind, in a stable order (used by the editor's kind picker). */
declare const PARTICLE_KINDS: readonly ParticleKind[];
/** At most this many emitters per cart — a full weather system needs only a few. */
declare const MAX_EMITTERS = 6;
/** Per-emitter particle-count ceiling, bounding worst-case per-frame draw cost. */
declare const MAX_PARTICLES_PER_EMITTER = 600;
/** One weather layer. */
interface ParticleEmitter {
    /** Weather kind — chooses draw style and motion. */
    kind: ParticleKind;
    /** How many particles this layer maintains, 1..{@link MAX_PARTICLES_PER_EMITTER}. */
    count: number;
    /** Particle colour, each channel 0..255. */
    color: readonly [number, number, number];
    /** Base opacity of each particle, 0..1. */
    opacity: number;
    /** Particle size in pixels, 1..8. */
    size: number;
    /** Speed along the kind's axis (fall or rise), in pixels/frame, 0..12. */
    speed: number;
    /** Horizontal drift in pixels/frame, signed, -6..6. */
    wind: number;
    /** Integer seed so the field is reproducible across reloads and replays. */
    seed: number;
}
/** A cart's declared weather: an ordered list of emitters. */
interface ParticleSpec {
    emitters: ParticleEmitter[];
}
/** A ready-to-use emitter for a kind, at that kind's preset with the given seed. */
declare function emitterPreset(kind: ParticleKind, seed: number): ParticleEmitter;
/**
 * Validate untrusted JSON (a PUT body or a jsonb column) into a {@link ParticleSpec},
 * or null when nothing usable is present. Lenient about shape — malformed emitters
 * are dropped and missing fields take their kind's preset — but strict about kind
 * and ranges. Caps at {@link MAX_EMITTERS}. Returns null for an emitter-less result,
 * the same null-on-empty contract the scene and anim routes rely on so an empty
 * declaration clears the column rather than storing a no-op.
 */
declare function parseParticles(raw: unknown): ParticleSpec | null;

/**
 * The HD-2D "world" model: a height-mapped tile grid drawn as real 3D geometry,
 * with 2D character sprites composited into it as camera-facing billboards. This
 * is the piece that makes "the world is 3D, the characters are 2D" expressible in
 * a shipped cart — the gap the first Octopath pass had to fake in Lua.
 *
 * The trick is to lean entirely on the existing z-buffered software rasteriser
 * ({@link renderMeshScene}): terrain cells become textured quads, and each
 * character becomes a textured quad turned to face the camera. Because both flow
 * through one shared depth buffer, a billboard standing behind a raised tile is
 * occluded by it and one standing in front draws over it — correct HD-2D
 * occlusion, for free, with no new rasteriser. Textures come from the cart's own
 * sprite sheet (palette index 0 → transparent), so a character's silhouette is a
 * true alpha cutout.
 *
 * This module is pure geometry: it takes a parsed {@link WorldScene} and a
 * texture lookup and returns {@link MeshSceneInstance}s plus a camera. All WASM
 * reads and frame compositing live in {@link WorldOverlaySurface}. DOM-free and
 * unit-testable.
 */

/** One terrain cell: a stack height (in height units) and the tile sprite on top. */
interface WorldTileCell {
    /** Height of the cell's top face, in height units (0 = floor). */
    readonly h: number;
    /** Sprite id of the tile block drawn on the cell's top (and walls). */
    readonly sprite: number;
}
/** A declarative billboard slot: the sprite art a character instance draws with.
 *  Its position is supplied per-frame by the cart (see WorldOverlaySurface). */
interface WorldBillboard {
    /** Sprite id of the block used as the billboard's texture. */
    readonly sprite: number;
    /** Width in world units (the quad spans this across the camera's right axis). */
    readonly width: number;
    /** Height in world units (the quad rises this along the camera's up axis). */
    readonly height: number;
}
/** A static scenery billboard placed at a fixed spot in the world (a tree, rock,
 *  lantern…). Unlike {@link WorldBillboard} slots, props need no cart code — the
 *  runtime draws them every frame as camera-facing sprites, so a scene can hold
 *  far more scenery than the 8 cart-driven billboards the mailbox allows. */
interface WorldProp {
    readonly sprite: number;
    /** World position of the prop's feet: x/z in grid units, y in height units. */
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly width: number;
    readonly height: number;
}
/** A cart's authored 3D world: a tile grid, static scenery props, and the
 *  billboard slots the cart drives (characters). */
interface WorldScene {
    readonly cols: number;
    readonly rows: number;
    /** Sprite block size in 8px tiles per side (4 → a 32×32 sprite per cell). */
    readonly tilesPerSide: number;
    /** cols×rows cells, row-major (`cells[j * cols + i]`). */
    readonly cells: readonly WorldTileCell[];
    /** Static scenery placed at fixed positions; drawn by the runtime, no cart code. */
    readonly props: readonly WorldProp[];
    /** Declarative billboard slots the cart moves each frame by index. */
    readonly billboards: readonly WorldBillboard[];
    /** Default camera framing when the cart drives none. */
    readonly camera?: WorldCameraSpec;
}
interface WorldCameraSpec {
    /** Orbit yaw around the world centre, radians. */
    readonly yaw: number;
    /** Orbit pitch (downward tilt), radians. */
    readonly pitch: number;
    /** Distance from the framed centre; 0 → auto-fit. */
    readonly distance: number;
    /** Vertical field of view, radians; 0 → default. */
    readonly fov: number;
    /** World-space point (grid x/z units, height units for y) the camera looks at.
     *  Null → frame the whole terrain (its centre). Non-null makes the camera follow
     *  that point — e.g. the player's position — so it tracks the hero as he moves. */
    readonly target?: readonly [number, number, number] | null;
}
/** One world cell spans a unit square in XZ; one height unit raises it this much. */
declare const CELL_WORLD = 1;
declare const HEIGHT_WORLD = 0.6;
/** Look up a decoded texture for a sprite id (cached by the surface). */
type TextureLookup = (sprite: number) => DecodedTexture | null;
/**
 * Parse the stored world sidecar (opaque JSON string) into a {@link WorldScene},
 * or null when absent/invalid — mirroring the other sidecars' defensive parse so
 * a malformed payload makes the cart play without a world rather than crash.
 */
declare function parseWorldScene(raw: string | null | undefined): WorldScene | null;
/** Read a cell, clamping out-of-bounds to a floor cell so edge walls close. */
declare function cellAt(scene: WorldScene, i: number, j: number): WorldTileCell;
/**
 * Build the terrain as one {@link MeshSceneInstance} per distinct tile sprite
 * (each carrying that sprite's texture). Each cell contributes a top quad at its
 * height and vertical wall quads on any side that drops to a lower neighbour, so a
 * raised cell reads as a solid 3D block, not a floating tile.
 */
declare function buildTerrainInstances(scene: WorldScene, textureFor: TextureLookup): MeshSceneInstance[];
/**
 * A camera-facing quad standing at `foot` (its bottom-centre), spanning `width`
 * across the camera's right axis and rising `height` along its up axis. Because
 * it is built from the live camera basis each frame it always squarely faces the
 * viewer, and it shares the scene depth buffer so terrain occludes it correctly.
 * The sprite's palette-0 pixels are transparent, so what draws is the silhouette.
 */
declare function buildBillboardInstance(foot: readonly [number, number, number], width: number, height: number, camRight: readonly [number, number, number], camUp: readonly [number, number, number], texture: DecodedTexture | null): MeshSceneInstance;
/**
 * A soft, round shadow texture. The software rasteriser is opaque-only (it skips
 * transparent texels and never blends), so translucency is faked with a 2×2 dither
 * whose density falls off with radius: a solid dark centre, a stippled ring, then
 * nothing — which reads as a soft contact shadow on the ground.
 */
declare function makeShadowTexture(size?: number): DecodedTexture;
/**
 * A flat, ground-hugging shadow quad centred under `foot` (world units), lifted a
 * hair to avoid z-fighting the terrain top. Foreshortening under the camera turns
 * the square into the expected shadow ellipse.
 */
declare function buildShadowInstance(foot: readonly [number, number, number], radius: number, texture: DecodedTexture | null): MeshSceneInstance;
interface WorldCamera {
    readonly view: Mat4;
    readonly projection: Mat4;
    /** World-space right axis of the camera (for billboard orientation). */
    readonly right: readonly [number, number, number];
    /** World-space up axis of the camera. */
    readonly up: readonly [number, number, number];
}
/** The XZ/height centre and radius the camera frames. */
declare function worldCenter(scene: WorldScene): {
    center: [number, number, number];
    radius: number;
};
/**
 * Build the world camera from an orbit spec, framing the terrain. `aspect` is the
 * framebuffer's width/height so the projection is undistorted; `distance`/`fov`
 * of 0 mean auto-fit / default. Returns the matrices plus the camera basis a
 * billboard needs to face the viewer.
 */
declare function buildWorldCamera(scene: WorldScene, spec: WorldCameraSpec, aspect: number): WorldCamera;

/**
 * The cart-facing collision accessor, as injectable Lua.
 *
 * A cart's collision layer is authored in the editor and stored as a sidecar (a
 * packed per-cell bitmap, see @cartbox/editor's CollisionMap). Unlike the lights
 * SDK — where the cart writes to the host through the mailbox — collision is host
 * data the cart *reads*, and it never changes during play, so the whole bitmap is
 * injected once as Lua data plus a `cartbox.solid(x, y)` / `cartbox.mapsize()`
 * accessor. A cart then does its own physics against it with no per-frame
 * protocol.
 *
 * Pure and import-free so it can be unit-tested on its own inputs and outputs;
 * the player is what prepends the returned string (after the base SDK, so the
 * `cartbox` table already exists when this overrides its solid/mapsize stubs).
 *
 * Every arithmetic operand feeding a bitwise operator is forced to an integer
 * (via math.floor or an integer literal): the Pro core's Lua throws on a bitwise
 * op applied to a float, which would abort TIC() mid-frame (see the
 * `lua-bitwise-float-trap` note).
 */
/** The runtime shape of a collision layer the player consumes. */
interface CollisionField {
    /** Grid width in cells. */
    width: number;
    /** Grid height in cells. */
    height: number;
    /** Base64 of the row-major, LSB-first packed solidity bits (as CollisionMap serialises). */
    bits: string;
}
/**
 * Validate an untrusted value (e.g. a cart row's `collision` column) as a
 * CollisionField, returning null when it is absent or malformed — the same
 * defensive contract as parseScene / parseParticles.
 */
declare function parseCollisionField(value: unknown): CollisionField | null;
/**
 * Build the Lua that exposes a cart's collision layer as `cartbox.solid(x, y)`
 * (true when the cell is solid, false out of bounds) and `cartbox.mapsize()`.
 * Returns an empty string when there is no usable layer, so the caller injects
 * nothing and the base SDK's no-op stubs remain.
 */
declare function collisionSdkLua(collision: CollisionField | null | undefined): string;

/**
 * The cart-facing tile-flags accessor, as injectable Lua.
 *
 * Like the collision accessor (see collisionSdk.ts), a cart's flags layer is host
 * data the cart reads and it never changes during play, so the whole byte grid is
 * injected once as Lua data plus a `cartbox.flag(cx, cy, n)` accessor — no
 * per-frame protocol. Flag `n` is 0..7; the cart decides what each means (hazard,
 * ladder, one-way platform, water, trigger zones, …).
 *
 * Pure and import-free so it can be unit-tested on its own inputs and outputs; the
 * player prepends the returned string after the base SDK, so the `cartbox` table
 * already exists when this overrides its `flag` stub.
 *
 * Every arithmetic operand feeding a bitwise operator is forced to an integer, so
 * the Pro core's bitwise-of-float trap can never abort TIC() mid-frame (see the
 * `lua-bitwise-float-trap` note).
 */
/** The runtime shape of a tile-flags layer the player consumes. */
interface FlagsField {
    /** Grid width in cells. */
    width: number;
    /** Grid height in cells. */
    height: number;
    /** Base64 of the row-major, one-byte-per-cell flag bytes (as TileFlags serialises). */
    bytes: string;
}
/**
 * Validate an untrusted value (e.g. a cart row's `flags` column) as a FlagsField,
 * returning null when it is absent or malformed — the same defensive contract as
 * parseCollisionField / parseScene.
 */
declare function parseFlagsField(value: unknown): FlagsField | null;
/**
 * Build the Lua that exposes a cart's flags layer as `cartbox.flag(cx, cy, n)`
 * (true when flag n is set on that cell, false out of bounds or n outside 0..7).
 * Returns an empty string when there is no usable layer, so the caller injects
 * nothing and the base SDK's no-op stub remains.
 */
declare function flagsSdkLua(flags: FlagsField | null | undefined): string;

/**
 * Which input methods the player wires up.
 * - "auto": keyboard on devices with a fine pointer, on-screen touch controls otherwise.
 * - "keyboard": keyboard only.
 * - "touch": on-screen controls only.
 */
type ControlScheme = "auto" | "keyboard" | "touch";
/**
 * How the console image is sized inside its container.
 * - "fit": largest size that fits, preserving aspect ratio (may be fractional — smooth).
 * - "integer": largest whole-number multiple that fits (crisp, no pixel shimmer).
 * - number: an explicit scale multiplier (e.g. 3 renders at 3x native).
 */
type ScaleMode = "fit" | "integer" | number;
/** The eight face/direction buttons of a TIC-80 gamepad. Values are bit positions. */
declare enum ConsoleButton {
    Up = 0,
    Down = 1,
    Left = 2,
    Right = 3,
    A = 4,
    B = 5,
    X = 6,
    Y = 7
}
/** Options accepted by {@link mount}. Only `cartUrl` is required. */
interface PlayerOptions {
    /** URL of the `.tic` cartridge to load. */
    cartUrl: string;
    /**
     * URL of the engine loader script (the Emscripten glue that instantiates the
     * WASM core). Defaults to the selected model's `engineUrl` when omitted.
     */
    engineUrl?: string;
    /** Console model — selects the runtime and its fixed specs. Defaults to "classic". */
    modelId?: ModelId;
    /** When false (default) a poster is shown and playback starts on the first user gesture. */
    autostart?: boolean;
    /** Input scheme. Defaults to "auto". */
    controls?: ControlScheme;
    /** Display scaling policy. Defaults to "fit". */
    scale?: ScaleMode;
    /** Audio sample rate. Defaults to the model's sample rate. */
    sampleRate?: number;
    /** Record the input stream for replay. Defaults to true (negligible cost). */
    record?: boolean;
    /**
     * Play back a recorded replay instead of live input. When set, user input is
     * ignored and the console is driven by the replay's input stream.
     */
    replay?: Replay;
    /** Called once the cartridge is loaded and the first frame is ready. */
    onReady?: () => void;
    /** Called for any load or runtime error the player cannot recover from. */
    onError?: (error: Error) => void;
    /** Called for each platform event a cart emits via the cartbox SDK. */
    onEvent?: (event: MailboxEvent) => void;
    /**
     * Called with the message when the cart's Lua raises a runtime error mid-frame.
     * The core keeps running (it aborts only that frame's TIC), so this is a report
     * for the creator (e.g. the playtest HUD), not a fatal `onError`. Fires once per
     * new error; no-op on engines built before runtime-error capture.
     */
    onRuntimeError?: (message: string) => void;
    /**
     * Online multiplayer: a joined {@link NetSession} the player feeds before and
     * after every tick (the cart talks to it through pmem 0..118 via the SDK's
     * cartbox.net* functions). Omitted: the cart plays offline.
     */
    netplay?: NetSession;
    /**
     * Creates the physics engine for a cart whose scene objects have bodies
     * (ENGINE_ROADMAP.md, Phase 2). Supplied by the host so the engine (Rapier in
     * the web app) is only downloaded for carts that use it. Omitted, bodies stay
     * where they were placed and the cart's physics calls are no-ops.
     *
     * `deterministic` is set when the scene asks for deterministic physics: the
     * host should then supply an engine that computes the same result on every
     * platform (the player rounds its own inputs to match).
     */
    physics?: (options: {
        deterministic: boolean;
    }) => Promise<PhysicsBackend>;
    /**
     * Loads a KTX2 (Basis Universal) texture decoder. Called only for a mesh scene
     * that has KTX2 textures; without it they render as their flat base colour.
     * The web app passes one that fetches the transcoder on demand.
     */
    ktx2?: () => Promise<(bytes: Uint8Array) => DecodedTexture | null>;
    /**
     * Loads a level's assets before a switch to it (`cartbox.level`), reporting
     * progress 0..1; the switch happens when it settles. Without it, switches are
     * immediate. The web app streams the level's textures.
     */
    levelAssets?: (level: SceneLevel, onProgress: (progress: number) => void) => Promise<void>;
    /**
     * Spatial loading (a scene that streams by distance): called with the ids of
     * objects the focus is coming near, the first time each does, so the host can
     * fetch their assets ahead of them loading. The web app streams their textures.
     */
    streamAssets?: (objectIds: readonly string[]) => void;
    /** Called as the current level changes and while one loads (loading is null once it's in). */
    onLevel?: (state: {
        level: string;
        loading: string | null;
        progress: number;
    }) => void;
    /**
     * Graphics quality: "low" | "medium" | "high", or "auto" (the default) to pick
     * from the device — see quality.ts. High is everything as authored.
     */
    quality?: QualityChoice;
    /**
     * Control settings (aim inversion, look sensitivity, controller and keyboard
     * bindings, touch pad size/opacity). Change them live with
     * {@link PlayerHandle.setControlSettings}. Defaults: DEFAULT_CONTROL_SETTINGS.
     */
    controlSettings?: ControlSettings;
    /**
     * The player pressed Start (a controller's Start/Back, the touch pad's Start,
     * or Enter / P): the host opens its menu. Without it there is no Start button.
     */
    onStart?: () => void;
    /** Master volume, 0..1 (default 1). */
    volume?: number;
    /**
     * Relight the cart's frames with dynamic point lights. When set, the player
     * renders through a WebGL lighting layer (falling back to plain 2D if WebGL is
     * unavailable). See {@link LightingOptions}.
     */
    lighting?: LightingOptions;
    /**
     * Post-process every presented frame through the cart's effect stack (fog,
     * bloom, CRT, …). Composes with `lighting`. Ignored when no effect is
     * enabled or WebGL is unavailable, so it can never stop a cart from playing.
     */
    postFx?: PostFxSettings;
    /**
     * Composite a declared parallax scene behind the cart's frame: layers point at
     * regions of the cart's own sprite sheet at depths, rendered with parallax
     * scroll + aerial-perspective atmosphere and chroma-keyed under the cart's
     * foreground (its background {@link SceneSpec.keyColor}). Runs before lighting
     * and post-FX, so both finish the backdrop and foreground together. Parse a
     * cart's sidecar into a SceneSpec with `parseScene`.
     */
    scene?: SceneSpec;
    /**
     * Play a declared animation set host-side (no cart code): sprite-frame clips as
     * foreground placements, plus keyframed tracks that drive scene-layer channels
     * (opacity/offset/emissive), post-FX values, and placement transforms — the
     * ambient motion (flickering neon, drifting fog, a guttering candle) the
     * REPLACED / THE LAST NIGHT look leans on. Driven off the same frame clock as the
     * scene backdrop. Parse a cart's sidecar into an AnimSpec with `parseAnim`.
     */
    anim?: AnimSpec;
    /**
     * Composite a declared weather system over each frame: rain, snow, drifting
     * embers, or rolling fog, played host-side (no cart code) as a stateless field.
     * Drawn in front of the cart, its backdrop, and any foreground placements, and —
     * with post-FX active — graded and bloomed with the scene. The atmosphere layer
     * of the REPLACED / THE LAST NIGHT look. Parse a cart's sidecar into a
     * ParticleSpec with `parseParticles`.
     */
    particles?: ParticleSpec;
    /**
     * Rasterise a declared 3D mesh scene over each frame: imported triangle meshes
     * (OBJ/glTF/GLB) placed by transforms, drawn by a pure software rasteriser
     * (the runtime has no GPU triangle path). Composited over the cart frame with a
     * shared depth buffer, and — being a decorator — graded and bloomed through the
     * lighting + post-FX stack. The scene auto-orbits for now; a later draw mailbox
     * will let a cart drive the camera. Parse a cart's `mesh` sidecar into a
     * MeshScene with `parseMeshScene`.
     */
    mesh?: MeshScene;
    /**
     * Render a declared HD-2D {@link WorldScene}: a height-mapped 3D tile world with
     * the cart's own 2D character sprites standing in it as camera-facing billboards,
     * all sharing one depth buffer so terrain and characters occlude correctly. The
     * cart drives the camera with `cartbox.worldcam` and places characters with
     * `cartbox.billboard` (both reuse the mesh camera/pose mailbox channels). Parse a
     * cart's `world` sidecar into a WorldScene with `parseWorldScene`.
     */
    world?: WorldScene;
    /**
     * Expose the cart's authored collision layer to its own Lua as
     * `cartbox.solid(x, y)` (true when a map cell is solid) and `cartbox.mapsize()`.
     * The whole bitmap is injected once as cart data — collision never changes
     * during play — so the cart runs its own physics against it with no per-frame
     * protocol. Parse a cart's sidecar into a CollisionField with
     * `parseCollisionField`.
     */
    collision?: CollisionField;
    /**
     * Expose the cart's authored tile-flags layer to its own Lua as
     * `cartbox.flag(cx, cy, n)` (flag n, 0..7, on that map cell). Injected once as
     * static cart data alongside collision. Parse a cart's sidecar into a
     * FlagsField with `parseFlagsField`.
     */
    flags?: FlagsField;
    /**
     * Called once per presented frame (after blit), for lightweight instrumentation
     * — an editor playtest HUD counting these gets the cart's true 60Hz frame rate
     * rather than the browser's paint rate. Keep the handler cheap; it runs every
     * frame.
     */
    onFrame?: () => void;
    /**
     * The editor's console: called with each `trace()` the cart prints, its
     * colour, and the frame it came in. Setting it adds the debug prelude (see
     * debug/debugBlock.ts), which also makes runtime errors name cart lines with
     * a short call stack (`line 12: …` then `at update:12 < TIC:40`). For the
     * editor's playtest; a published cart leaves it unset.
     */
    onTrace?: (text: string, color: number, frame: number) => void;
    /**
     * The editor's Lua debugger (see debug/instrument.ts and debug/debugBlock.ts):
     * the cart's statement lines get breakpoint hooks and TIC runs so it can stop
     * mid-frame. `onPause` is called with where it stopped, and with null when it
     * carries on. Costs a function call per statement while on; for the editor's
     * playtest only.
     */
    debug?: {
        readonly breakpoints?: readonly number[];
        readonly watches?: readonly string[];
        readonly onPause?: (pause: PauseInfo | null) => void;
    };
}
/** Handle returned by {@link mount} for controlling a live player instance. */
interface PlayerHandle {
    /** Halt the run loop and silence audio without tearing down the instance. */
    pause(): void;
    /** Resume a paused instance. */
    resume(): void;
    /** Stop everything and release the canvas, listeners, audio, and WASM instance. */
    destroy(): void;
    /**
     * The replay captured so far, or null when recording is disabled or the player
     * is itself replaying. Safe to call at any time (e.g. when the player ends).
     */
    getReplay(): Replay | null;
    /** Whether the run loop is currently advancing frames. */
    readonly running: boolean;
    /** Apply new control settings at once (bindings, inversion, sensitivity, touch pad). */
    setControlSettings(settings: ControlSettings): void;
    /** Master volume, 0..1. */
    setVolume(volume: number): void;
    /** Hold the game's input neutral (false) while a host menu is open over it, or restore it. */
    setInputEnabled(enabled: boolean): void;
    /**
     * A snapshot of the cart's scene objects as they are this frame (live
     * inspection): where each one is, whether it's shown, and its physics state.
     * Empty when the cart has no 3D scene.
     */
    inspect(): InspectedObject[];
    /** Change the graphics preset live: "low" | "medium" | "high" | "auto" (see quality.ts). */
    setQuality(choice: QualityChoice): void;
    /**
     * Hand the running scene streamed textures, keyed by the `ref` of the
     * placeholder each fills (an asset-backed texture's content hash). Safe to
     * call before the scene is up (nothing changes then); resolves with how many
     * objects changed.
     */
    supplyTextures(images: ReadonlyMap<string, EncodedImage>): Promise<number>;
    /** The graphics preset in effect. */
    quality(): QualityLevel;
    /**
     * Run at a fraction or multiple of normal speed (0.25 … 4; 1 is normal). Sound
     * is muted away from 1×, where it would stretch or pile up.
     */
    setTimeScale(scale: number): void;
    /** The speed set by {@link setTimeScale}. */
    timeScale(): number;
    /** While paused: advance exactly one frame and show it. No-op while running. */
    stepFrame(): void;
    /** Frames the cart has run so far. */
    frame(): number;
    /** The debugger: the cart lines to stop at (a line with no statement stops at the next one that has one). */
    setBreakpoints(lines: readonly number[]): void;
    /** The debugger: expressions to evaluate wherever the cart stops (re-evaluated at once while it's stopped). */
    setWatches(expressions: readonly string[]): void;
    /** The debugger: carry on from a stop, to the next breakpoint ("continue") or by one statement. */
    debugContinue(step?: DebugStep): void;
    /** Where the cart is stopped at a breakpoint, or null. */
    debugPaused(): PauseInfo | null;
    /** The cart lines the debugger can stop at (ascending); empty without the debugger. */
    breakableLines(): readonly number[];
    /** Turn the profiler on or off (off by default; it costs a few clock reads per frame). */
    setProfiling(on: boolean): void;
    /** Where recent frames spent their time, what the 3D scene drew, memory and network use; null while profiling is off. */
    profile(): ProfileSnapshot | null;
    /**
     * Look at the 3D scene through an editor's camera instead of the cart's (an
     * orbit, as cartbox.meshcam takes it), or give the camera back with null —
     * ejecting from the game to look around while it plays (EP5).
     */
    setEditorCamera(camera: MailboxMeshCamera | null): void;
    /**
     * Apply an editor's edits to the running 3D scene — placements, meshes and
     * materials, lighting — without restarting. Resolves false when the edit
     * changed the scene's structure (objects added, removed or re-parented),
     * which takes a fresh run to show.
     */
    updateMeshScene(scene: MeshScene): Promise<boolean>;
}
/** One scene object in a live inspection snapshot. */
interface InspectedObject {
    readonly index: number;
    readonly name: string;
    readonly parent: number;
    /** World position this frame. */
    readonly position: readonly [number, number, number];
    /** Drawn this frame (false for hidden objects and prefab copies in reserve). */
    readonly visible: boolean;
    readonly tags: readonly string[];
    readonly props: Readonly<Record<string, number | string | boolean>>;
    /** The object's physics body, when it has one that moves. */
    readonly body?: {
        readonly kind: string;
        readonly velocity: readonly [number, number, number];
        readonly grounded: boolean;
        readonly active: boolean;
    };
    /** For a prefab copy: its prefab and whether it's spawned. */
    readonly prefab?: {
        readonly name: string;
        readonly spawned: boolean;
    };
    /** For a skinned object: the clip playing (null at rest) and seconds into it. */
    readonly animation?: {
        readonly clip: string | null;
        readonly time: number;
    };
}

/**
 * Cartridge fetching.
 *
 * Single responsibility: turn a cartridge URL into validated bytes. It knows
 * nothing about the engine or rendering, so it can be reused by the gallery,
 * thumbnail renderer, or any other consumer.
 */
/** Raised when a cartridge cannot be fetched or is obviously not a cartridge. */
declare class CartridgeLoadError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}

/**
 * Engine adapter — the single seam between this player and the TIC-80 WASM core.
 *
 * `packages/engine` compiles the TIC-80 core plus a thin C shim to WASM via
 * Emscripten. The shim exports the stable C entry points below (prefixed `cbx_`);
 * keeping the shim contract narrow means struct layout changes in TIC-80 never
 * leak into the TypeScript. Everything WASM-specific lives here and nowhere else.
 *
 * Shim contract (implemented in packages/engine/shim.c, exported via
 * EXPORTED_FUNCTIONS):
 *   int  cbx_create(int sampleRate)                -> opaque console handle
 *   int  cbx_load(int handle, int ptr, int size)   -> 1 on success, 0 on failure
 *   void cbx_tick(int handle, int gamepadMask)      -> advance one 60Hz frame
 *   int  cbx_screen_ptr(int handle)                 -> ptr to RGBA framebuffer
 *   int  cbx_samples_ptr(int handle)                -> ptr to Int16 PCM for this frame
 *   int  cbx_samples_count(int handle)              -> sample count for this frame
 *   void cbx_delete(int handle)                     -> free the console
 */

/** Minimal view of the Emscripten module we depend on. */
interface EmscriptenModule {
    HEAPU8: Uint8Array;
    HEAP16: Int16Array;
    _malloc(size: number): number;
    _free(ptr: number): void;
    _cbx_create(sampleRate: number): number;
    _cbx_load(handle: number, ptr: number, size: number): number;
    _cbx_tick(handle: number, gamepadMask: number): void;
    _cbx_screen_ptr(handle: number): number;
    _cbx_samples_ptr(handle: number): number;
    _cbx_samples_count(handle: number): number;
    _cbx_mailbox_ptr(handle: number): number;
    _cbx_mailbox_words(handle: number): number;
    _cbx_material_ptr(handle: number): number;
    _cbx_emissive_ptr(handle: number): number;
    _cbx_set_material_capture(handle: number, enabled: number): void;
    _cbx_delete(handle: number): void;
    _cbx_error_seq?(): number;
    _cbx_last_error?(): number;
}
/** A loaded console ready to run a single cartridge. */
interface ConsoleInstance {
    /** Loads cartridge bytes. Returns false if the core rejects the cartridge. */
    loadCartridge(bytes: Uint8Array): boolean;
    /** Advances exactly one frame using the given gamepad bitmask. */
    tick(gamepadMask: number): void;
    /** Returns a view of the current RGBA framebuffer (valid until the next tick). */
    readFramebuffer(): Uint8Array;
    /** Returns the PCM samples produced by the most recent tick. */
    readAudioSamples(): Int16Array;
    /** Returns a copy of the event-mailbox words (word[0] = sequence counter). */
    readMailbox(): Uint32Array;
    /**
     * A LIVE view of pmem words 0..118 — the netplay channel just below the
     * mailbox (see net/netplay.ts). Writes land in the cart's pmem. Re-fetch it
     * each tick: WASM memory growth detaches old views. Null when unavailable.
     */
    netWords(): Uint32Array | null;
    /**
     * A LIVE view of `length` bytes of the console's RAM, starting `offsetFromPmem`
     * bytes after pmem word 0 (the physics block, see physics/protocol.ts). Re-fetch
     * it each tick: WASM memory growth detaches old views. Null when out of range.
     */
    ramView(offsetFromPmem: number, length: number): Uint8Array | null;
    /** Enables/disables per-pixel material capture (off by default; unlit carts pay nothing). */
    setMaterialCapture(enabled: boolean): void;
    /**
     * Returns a view of the current material G-buffer (RGBA: normal index, height,
     * specular, roughness), same dimensions as the framebuffer and valid until the
     * next tick. Empty until {@link setMaterialCapture} is enabled.
     */
    readMaterial(): Uint8Array;
    /**
     * Returns a view of the current emissive plane (one byte per pixel of self-
     * illumination; 0 = lit normally), width*height bytes, valid until the next
     * tick. Empty until {@link setMaterialCapture} is enabled.
     */
    readEmissive(): Uint8Array;
    /**
     * The last Lua runtime error the core reported, with a monotonic `seq` so a
     * caller can tell a fresh error from a repeat (baseline `seq` after load, then
     * treat any increase as new). `message` is empty until the VM reports one.
     * Returns null on engines built before the error-capture exports — they simply
     * surface no runtime errors rather than breaking.
     */
    readError(): {
        seq: number;
        message: string;
    } | null;
    /** Bytes of the engine's WebAssembly memory (for the profiler). */
    memoryBytes(): number;
    /** Frees the underlying WASM console. */
    dispose(): void;
}
/**
 * An engine module that could not be fetched or instantiated.
 *
 * Mirrors {@link CartridgeLoadError}: a named error carrying the URL that
 * failed, so a load failure reads as "which engine, and where" rather than as
 * whatever bare message the platform happened to throw.
 */
declare class EngineLoadError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
declare function loadEngineModule(engineUrl: string): Promise<EmscriptenModule>;
/** Wraps an Emscripten module as a {@link ConsoleInstance} for a given model. */
declare function createConsole(module: EmscriptenModule, model: ConsoleModel, sampleRate?: number): ConsoleInstance;

/**
 * Input handling. Both sources (keyboard, touch) write into a shared
 * {@link GamepadState} that the run loop samples once per frame as a bitmask.
 *
 * The key-binding lookup is a pure function so it can be unit-tested without a DOM.
 */

/**
 * Resolves a physical key to a console button, or undefined if unbound.
 * Pure — no DOM access — so callers and tests can use it freely.
 */
declare function resolveButton(keyCode: string, bindings?: Readonly<Record<string, ConsoleButton>>): ConsoleButton | undefined;
/**
 * Holds the current pressed/released state of every button as a bitmask.
 * Bit N (see {@link ConsoleButton}) is set while that button is held.
 */
declare class GamepadState {
    private mask;
    /** D-pad bits the left stick is pressing (kept apart so a key release can't clear them). */
    private stickMask;
    /** What a physical controller is pressing, replaced wholesale each poll. */
    private padMask;
    /** The on-screen sticks and a controller's sticks, kept apart and merged on read. */
    private readonly touchAxes;
    private readonly padAxes;
    /** Analog sticks: left x, left y, right x, right y, each −1..1 (y down-positive) —
     *  per stick, whichever source (touch or controller) is leaning further. */
    get axes(): [number, number, number, number];
    /** A controller's state this frame: its pressed console buttons and sticks. */
    setPad(mask: number, axes: readonly number[]): void;
    press(button: ConsoleButton): void;
    release(button: ConsoleButton): void;
    /**
     * Set a stick's position (0 = left, 1 = right). The left stick also presses
     * the D-pad directions it leans toward, so button-only carts steer with it.
     */
    setStick(index: 0 | 1, x: number, y: number): void;
    /** The engine-facing bitmask for player one. A controller's left stick also
     *  presses the D-pad directions it leans toward, like the on-screen one. */
    get value(): number;
    reset(): void;
}
/**
 * Reads a physical controller (an Xbox 360 or any standard-mapping gamepad)
 * through the Gamepad API once per frame: its bindings press console buttons,
 * its sticks feed the analog channel, and a control bound to "start" opens the
 * Start menu (on press, not while held).
 */
declare class GamepadInput {
    private readonly nav;
    private readonly state;
    private readonly settings;
    private readonly onStart?;
    private startHeld;
    /** The pad index in use, so a second controller plugged in later doesn't take over mid-game. */
    private index;
    constructor(nav: {
        getGamepads?: () => ArrayLike<(PadSnapshot & {
            mapping?: string;
            id?: string;
            connected?: boolean;
            index?: number;
        }) | null>;
    }, state: GamepadState, settings: () => ControlSettings, onStart?: (() => void) | undefined);
    poll(): void;
    /** Whether a controller is connected (for hints like "press Start"). */
    get connected(): boolean;
}

/**
 * Deterministic RNG seeding via cart-code injection.
 *
 * Cart randomness comes from the scripting language's own RNG (e.g. Lua's
 * math.random), which each language auto-seeds non-deterministically. A single
 * engine-level seed can't reach it. The robust, engine-agnostic fix is to seed
 * the language RNG from the cart itself: we inject a `math.randomseed(<seed>)`
 * prologue into the CODE chunk before loading, so a replay that reuses the same
 * seed reproduces the same random sequence.
 *
 * This is pure and testable. It currently covers Lua (TIC-80's default and most
 * common language); carts marked as another language are returned unchanged.
 *
 * .tic chunk header (4 bytes, LE): [type(5 bits) | bank(3 bits)][size lo][size hi][reserved]
 * (a CODE chunk's size 0 means a full 64 KB bank).
 */
/**
 * CODE chunks carrying `code`, split into 64 KB banks the way the engine saves
 * them: the start of the code in the highest bank used, the end in bank 0.
 */
declare function codeChunks(code: Uint8Array): Uint8Array;
/** Returns the cart's source code (all its code banks, joined), or null if absent. */
declare function readCartCode(bytes: Uint8Array): string | null;
/**
 * Returns a copy of the cartridge with `prelude` (plus a newline) prepended to
 * its Lua code. The code is re-split across as many 64 KB banks as it needs, so
 * a large cart still gets its prelude. Non-Lua carts, carts without code, or
 * code that would outgrow the engine's 512 KB are returned unchanged.
 *
 * Shared by RNG seeding and SDK injection.
 */
declare function prependLuaCode(bytes: Uint8Array, prelude: string): Uint8Array;
/**
 * Returns a copy of the cartridge with `postlude` appended to its Lua code, on a
 * line of its own (so the cart's line numbers don't move). Unchanged like
 * {@link prependLuaCode}.
 */
declare function appendLuaCode(bytes: Uint8Array, postlude: string): Uint8Array;
/** Returns a copy of the cartridge with its Lua code replaced by `rewrite(code)`. Unchanged like {@link prependLuaCode}. */
declare function rewriteLuaCode(bytes: Uint8Array, rewrite: (code: string) => string): Uint8Array;
/**
 * Returns a copy of the cartridge with a deterministic RNG seed injected into
 * its Lua code, so a replay reusing the same seed reproduces the randomness.
 *
 * @param bytes Original cartridge bytes.
 * @param seed Seed to make the language RNG reproducible.
 */
declare function seedCartridge(bytes: Uint8Array, seed: number): Uint8Array;

/**
 * Breakpoint hooks for the playtest's Lua debugger (ENGINE_ROADMAP.md, Phase 5).
 *
 * Lua can't pause from a debug hook (a `debug.sethook` function can't yield),
 * so the debugger runs `TIC` in a coroutine and the cart's code calls a hook at
 * the start of each statement line: `__bp(12) x = x + 1`. The hook yields when
 * line 12 has a breakpoint (or a step lands there), which hands control back to
 * the host with the frame half-run. Hooks go on the same line, so every line
 * number stays the cart's own.
 *
 * Where a statement starts is decided from tokens, conservatively: a line gets
 * a hook only when its first token starts a statement, it sits directly in a
 * block (not inside brackets or a loop header), and the line before ends in a
 * way that can end a statement. A line it can't be sure of gets no hook — a
 * breakpoint there moves to the next line that has one. Code it can't tokenize
 * is left alone. Pure.
 */
type TokenType = "name" | "keyword" | "number" | "string" | "symbol";
interface Token {
    readonly type: TokenType;
    readonly value: string;
    readonly line: number;
    readonly start: number;
}
/** Split Lua source into tokens (comments and whitespace dropped); null when it can't. */
declare function tokenizeLua(code: string): Token[] | null;
/**
 * The cart's code with a breakpoint hook at the start of each statement line,
 * and the lines that got one (ascending). Unchanged, with no lines, when the
 * code can't be tokenized or its blocks don't balance.
 */
declare function instrumentLua(code: string): {
    code: string;
    lines: number[];
};
/** The line a breakpoint on `line` actually stops at: it, or the next line with a hook (null past the last). */
declare function breakableLine(line: number, lines: readonly number[]): number | null;
/**
 * The lines to stop at for a list of breakpoints: each on the first line at or
 * after it that has a hook (a breakpoint on a blank line, a comment or an `end`
 * stops at the next statement); ones past the last hook are dropped. Sorted.
 */
declare function effectiveBreakpoints(list: readonly number[], lines: readonly number[]): number[];

/**
 * The cartbox SDK as an injectable string.
 *
 * Kept in sync with sdk/cartbox.lua (that file is the copy creators read/import;
 * this string is what the platform injects into carts that opt in). Both must
 * agree with the mailbox protocol in mailbox.ts (base word 119, event ring
 * capacity 8, lights block at word 144, parallax camera at 181, mesh camera at
 * 183, mesh-pose block at 191, event types 1/2/3, FNV-1a id hash).
 */
/** Lua source of the cartbox SDK. */
declare const CARTBOX_SDK_LUA = "local _MB = 119\nlocal _CAP = 8\nlocal _LB = _MB + 25\nlocal _LCAP = 6\nlocal _CB = _LB + 1 + _LCAP * 6\nlocal _MCB = _CB + 2\nlocal _MPB = _MCB + 8\nlocal _MPCAP = 8\nlocal _ln = 0\nlocal _mn = 0\nlocal function _emit(kind, id, value)\n  local seq = pmem(_MB)\n  local slot = seq % _CAP\n  local base = _MB + 1 + slot * 3\n  pmem(base, kind)\n  pmem(base + 1, id)\n  pmem(base + 2, value)\n  pmem(_MB, seq + 1)\nend\nlocal function _hash(s)\n  local h = 2166136261\n  for i = 1, #s do\n    h = ((h ~ string.byte(s, i)) * 16777619) & 0xffffffff\n  end\n  return h\nend\nlocal function _norm(x, y, z)\n  local m = math.sqrt(x * x + y * y + z * z)\n  if m < 1e-6 then return 0, 0, 1 end\n  return x / m, y / m, z / m\nend\nlocal function _byte(v)\n  local b = math.floor((v or 0) * 127 + 0.5)\n  if b < -127 then b = -127 elseif b > 127 then b = 127 end\n  if b < 0 then b = b + 256 end\n  return b\nend\nlocal function _light(kind, x, y, z, radius, r, g, b, intensity, dx, dy, cone)\n  if _ln >= _LCAP then return end\n  local base = _LB + 1 + _ln * 6\n  pmem(base, x // 1)\n  pmem(base + 1, y // 1)\n  pmem(base + 2, z // 1)\n  pmem(base + 3, radius // 1)\n  local rgb = (math.floor(r or 255) & 0xff) << 16\n  rgb = rgb | ((math.floor(g or 255) & 0xff) << 8)\n  rgb = rgb | (math.floor(b or 255) & 0xff)\n  pmem(base + 4, rgb | (kind << 24) | (cone << 26))\n  local inten = math.floor((intensity or 1) * 256)\n  if inten < 0 then inten = 0 elseif inten > 0xffff then inten = 0xffff end\n  pmem(base + 5, inten | (dx << 16) | (dy << 24))\n  _ln = _ln + 1\n  pmem(_LB, _ln)\nend\ncartbox = {\n  unlock = function(id) _emit(1, _hash(id), 0) end,\n  score = function(v) _emit(2, 0, v // 1) end,\n  progress = function(id, v) _emit(3, _hash(id), v // 1) end,\n  -- request(kind, value): ask the host page for something it provides (e.g. a\n  -- page's matchmaking); kind and value are numbers the page defines.\n  request = function(kind, value) _emit(4, (kind or 0) // 1, (value or 0) // 1) end,\n  clearlights = function() _ln = 0 pmem(_LB, 0) end,\n  light = function(x, y, radius, r, g, b, z, intensity)\n    _light(0, x, y, z or 12, radius, r, g, b, intensity, 0, 0, 0)\n  end,\n  sun = function(dx, dy, dz, r, g, b, intensity)\n    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)\n    _light(1, 0, 0, 0, 0, r, g, b, intensity, _byte(nx), _byte(ny), 0)\n  end,\n  -- light3d(x, y, z, radius, r, g, b, intensity): a point light in a 3D scene's\n  -- world units (signed, fractional), lighting a first-person mesh view -- the\n  -- 2D relight ignores it. E.g. a glow over an objective.\n  light3d = function(x, y, z, radius, r, g, b, intensity)\n    _light(3, (x or 0) * 64, (y or 0) * 64, (z or 0) * 64, (radius or 4) * 64, r, g, b, intensity, 0, 0, 0)\n  end,\n  spot = function(x, y, z, dx, dy, dz, radius, angle, r, g, b, intensity)\n    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)\n    local cone = math.floor(math.cos(math.rad(angle or 30)) * 63 + 0.5)\n    if cone < 0 then cone = 0 elseif cone > 63 then cone = 63 end\n    _light(2, x, y, z or 12, radius, r, g, b, intensity, _byte(nx), _byte(ny), cone)\n  end,\n  camera = function(x, y)\n    pmem(_CB, math.floor((x or 0) * 16 + 0.5) & 0xffffffff)\n    pmem(_CB + 1, math.floor((y or 0) * 16 + 0.5) & 0xffffffff)\n  end,\n  -- Drive the 3D mesh orbit camera this frame: yaw/pitch (radians), distance in\n  -- world units (0 = auto-fit the scene), fov (radians, 0 = default). Call every\n  -- frame; not calling leaves the player's gentle auto-orbit in charge.\n  meshcam = function(yaw, pitch, dist, fov)\n    pmem(_MCB, 1)\n    pmem(_MCB + 1, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)\n    pmem(_MCB + 2, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)\n    pmem(_MCB + 3, math.floor((dist or 0) * 256 + 0.5) & 0xffffffff)\n    pmem(_MCB + 4, 0)\n    pmem(_MCB + 5, 0)\n    pmem(_MCB + 6, 0)\n    pmem(_MCB + 7, math.floor((fov or 0) * 1024 + 0.5) & 0xffffffff)\n  end,\n  -- Start a fresh frame's mesh-pose list. Call once before any meshpose() calls;\n  -- instances you don't pose keep their authored transform.\n  clearposes = function() _mn = 0 pmem(_MPB, 0) end,\n  -- First-person mode: composite the cart's 2D frame as a HUD OVER the 3D scene,\n  -- rather than drawing the meshes over the 2D (the default third-person showcase\n  -- compositing). Call each frame AFTER the camera call with a truthy value to\n  -- enable; near-black (index 0) pixels the cart leaves are the transparent \"world\"\n  -- and everything else the cart draws is the HUD. Rides a spare bit of the\n  -- mesh-camera flag word, so it costs no mailbox space.\n  hud = function(on)\n    local f = pmem(_MCB)\n    if on and on ~= 0 then pmem(_MCB, f | 2) else pmem(_MCB, f & 0xfffffffd) end\n  end,\n  -- Move/rotate/scale one mesh instance (by its sidecar index) this frame, on top\n  -- of its authored placement. x,y,z are world units; yaw (about Y), pitch (about\n  -- X), roll (about Z) radians;\n  -- scale defaults to 1 (pass 0 to hide). math.floor keeps every value integer so\n  -- the bitwise mask never sees a float (the Pro core's Lua throws on that). Must\n  -- match decodeMeshPoses() on the host.\n  -- Optional extras: frame picks one of the instance's animation frames (0 = its\n  -- base mesh, up to 127), tint recolours its tintable materials from the\n  -- 15-colour tint palette (0 = none), and front (true/1) draws it over the\n  -- whole scene \u2014 a held weapon that must never clip into a wall.\n  meshpose = function(index, x, y, z, yaw, pitch, roll, scale, frame, tint, front)\n    if _mn >= _MPCAP then return end\n    local base = _MPB + 1 + _mn * 8\n    local word = math.floor(index or 0) & 0xff\n    word = word | ((math.floor(frame or 0) & 0x7f) << 9) | ((math.floor(tint or 0) & 0xf) << 16)\n    if front and front ~= 0 then word = word | 0x100000 end\n    pmem(base, word)\n    pmem(base + 1, math.floor((x or 0) * 256 + 0.5) & 0xffffffff)\n    pmem(base + 2, math.floor((y or 0) * 256 + 0.5) & 0xffffffff)\n    pmem(base + 3, math.floor((z or 0) * 256 + 0.5) & 0xffffffff)\n    pmem(base + 4, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)\n    pmem(base + 5, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)\n    pmem(base + 6, math.floor((roll or 0) * 1024 + 0.5) & 0xffffffff)\n    pmem(base + 7, math.floor((scale or 1) * 256 + 0.5) & 0xffffffff)\n    _mn = _mn + 1\n    pmem(_MPB, _mn)\n  end,\n  -- HD-2D world (optional): a cart with a world sidecar draws a 3D tile terrain\n  -- and stands its 2D character sprites in it as depth-sorted billboards. The\n  -- world camera and billboards reuse the mesh camera/pose mailbox channels, so\n  -- no engine change is needed \u2014 these are thin aliases with the world's naming.\n  --\n  -- Drive the world camera this frame: yaw/pitch (radians), distance (world units,\n  -- 0 = auto-fit), fov (radians, 0 = default). Optional tx,ty,tz make the camera\n  -- LOOK AT that point (grid x/z units, height units for y) so it follows the\n  -- player; omit them (or pass 0,0,0) to frame the whole terrain. Same mailbox\n  -- layout as meshcam (target rides at _MCB+4..6).\n  worldcam = function(yaw, pitch, dist, fov, tx, ty, tz)\n    pmem(_MCB, 1)\n    pmem(_MCB + 1, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)\n    pmem(_MCB + 2, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)\n    pmem(_MCB + 3, math.floor((dist or 0) * 256 + 0.5) & 0xffffffff)\n    pmem(_MCB + 4, math.floor((tx or 0) * 256 + 0.5) & 0xffffffff)\n    pmem(_MCB + 5, math.floor((ty or 0) * 256 + 0.5) & 0xffffffff)\n    pmem(_MCB + 6, math.floor((tz or 0) * 256 + 0.5) & 0xffffffff)\n    pmem(_MCB + 7, math.floor((fov or 0) * 1024 + 0.5) & 0xffffffff)\n  end,\n  -- Start a fresh frame's billboard list. Call once before billboard() calls each\n  -- frame (an alias of clearposes \u2014 they share the mesh-pose channel).\n  clearbillboards = function() _mn = 0 pmem(_MPB, 0) end,\n  -- Place billboard index (declared in the world sidecar) at world position\n  -- (x,z grid units, y height units) this frame; scale defaults to 1 (0 hides).\n  -- math.floor keeps every value integer so the bitwise mask never sees a float.\n  billboard = function(index, x, y, z, scale)\n    if _mn >= _MPCAP then return end\n    local base = _MPB + 1 + _mn * 8\n    pmem(base, math.floor(index or 0) & 0xff)\n    pmem(base + 1, math.floor((x or 0) * 256 + 0.5) & 0xffffffff)\n    pmem(base + 2, math.floor((y or 0) * 256 + 0.5) & 0xffffffff)\n    pmem(base + 3, math.floor((z or 0) * 256 + 0.5) & 0xffffffff)\n    pmem(base + 4, 0)\n    pmem(base + 5, 0)\n    pmem(base + 6, 0)\n    pmem(base + 7, math.floor((scale or 1) * 256 + 0.5) & 0xffffffff)\n    _mn = _mn + 1\n    pmem(_MPB, _mn)\n  end,\n  -- stick(n) -> x, y: analog stick n (0 left, 1 right), each -1..1, y down-\n  -- positive. Reads 0,0 with no sticks (keyboard); on a touchscreen the pad\n  -- shows its right stick once a cart calls this. Uses pmem 68..69.\n  stick = function(n)\n    if pmem(69) ~= 0x53544b31 then pmem(69, 0x53544b31) end\n    local w = pmem(68)\n    local sh = (n == 1) and 16 or 0\n    local x, y = (w >> sh) & 0xff, (w >> (sh + 8)) & 0xff\n    if x >= 128 then x = x - 256 end\n    if y >= 128 then y = y - 256 end\n    return x / 127, y / 127\n  end,\n  -- Netplay (online multiplayer). The host page relays player state + events\n  -- between browsers through pmem words 0..118 (so a netplay cart must not keep\n  -- save data there); see packages/player/src/net/netplay.ts for the layout.\n  -- net() -> mode (0 offline, 1 client, 2 host), my slot, humans mask, match word,\n  -- and the page's status code (0 idle; the page defines the rest, e.g. searching)\n  net = function()\n    local h = pmem(0)\n    return h & 3, (h >> 2) & 7, (h >> 8) & 0xff, pmem(1), (h >> 5) & 7\n  end,\n  -- netpeer(slot) -> the slot's 3 state words, and whether they are live\n  netpeer = function(slot)\n    local b = 3 + slot * 3\n    return pmem(b), pmem(b + 1), pmem(b + 2), ((pmem(0) >> 16) & (1 << slot)) ~= 0\n  end,\n  -- netpublish(slot, a, b, c): publish a slot's state this tick (your own, or a\n  -- bot's when you are the host)\n  netpublish = function(slot, a, b, c)\n    local base = 72 + slot * 3\n    pmem(base, math.floor(a or 0) & 0xffffffff)\n    pmem(base + 1, math.floor(b or 0) & 0xffffffff)\n    pmem(base + 2, math.floor(c or 0) & 0xffffffff)\n    pmem(70, pmem(70) | (1 << slot))\n  end,\n  -- netmatch(word): the host's shared game-state word (clients read it via net())\n  netmatch = function(w) pmem(71, math.floor(w or 0) & 0xffffffff) end,\n  -- netsend(a, b): broadcast a 2-word event to every other player (\u2264 10/tick)\n  netsend = function(a, b)\n    local n = pmem(96)\n    if n >= 10 then return false end\n    pmem(97 + n * 2, math.floor(a or 0) & 0xffffffff)\n    pmem(98 + n * 2, math.floor(b or 0) & 0xffffffff)\n    pmem(96, n + 1)\n    return true\n  end,\n  -- netevents() -> this tick's incoming events, as a list of {a, b}\n  netevents = function()\n    local n = pmem(27)\n    local out = {}\n    for i = 0, n - 1 do out[#out + 1] = { pmem(28 + i * 2), pmem(29 + i * 2) } end\n    return out\n  end,\n  -- Collision defaults: overridden by the injected layer when the cart has one,\n  -- so cartbox.solid/mapsize are always safe to call (a cart with no collision\n  -- layer simply sees every cell as non-solid).\n  solid = function() return false end,\n  mapsize = function() return 0, 0 end,\n  -- Tile-flags default: overridden by the injected layer when the cart has one.\n  flag = function() return false end,\n  -- Scene objects (the cart's placed meshes by name, with parents, tags and\n  -- properties): overridden by the injected scene table when the cart has meshes.\n  -- An object is the 0-based index cartbox.meshpose takes, or its name.\n  objects = function() return 0 end,\n  find = function() return nil end,\n  objname = function() return nil end,\n  parent = function() return nil end,\n  children = function() return {} end,\n  prop = function(_, _, default) return default end,\n  hastag = function() return false end,\n  tagged = function() return {} end,\n  -- Physics (bodies on scene objects): overridden by the injected physics calls\n  -- when the cart has bodies.\n  physics = function() return false end,\n  body = function() return nil end,\n  impulse = function() end,\n  velocity = function() end,\n  teleport = function() end,\n  move = function() end,\n  ray = function() end,\n  sweep = function() end,\n  hit = function() return false end,\n  contacts = function() return {} end,\n  entered = function() return {} end,\n  exited = function() return {} end,\n  inside = function() return {} end,\n  motor = function() end,\n  unjoin = function() end,\n  physicshash = function() return 0 end,\n  -- Spawning prefab copies: overridden when the cart has prefabs.\n  spawn = function() return nil end,\n  despawn = function() end,\n  alive = function() return false end,\n  -- Skeletal animation: overridden when the scene has skinned objects.\n  play = function() end,\n  anim = function() return nil, 0, false end,\n  clips = function() return {} end,\n  set = function() end,\n  trigger = function() end,\n  state = function() return nil end,\n  setstate = function() end,\n  events = function() return {} end,\n  ik = function() end,\n  lookat = function() end,\n  ragdoll = function() end,\n  unragdoll = function() end,\n  shield = function() end,\n  joint = function() return nil end,\n  joints = function() return {} end,\n  playtimeline = function() end,\n  stoptimeline = function() end,\n  timeline = function() return nil, 0, false end,\n  timelineevents = function() return {} end,\n  -- Navigation agents: overridden when the scene has a baked walkable surface.\n  agent = function() end,\n  obstacle = function() end,\n  moveto = function() end,\n  stopagent = function() end,\n  removeagent = function() end,\n  agentpos = function() return nil end,\n  navigable = function() return false end,\n  -- Spatial loading's focus: overridden when the scene streams by distance.\n  streamfocus = function() end,\n  burst = function() end,\n  decal = function() end,\n  decals = function() return {} end,\n  debris = function() end,\n  debrislist = function() return {} end,\n  effects = function() return {} end,\n}";
/** Injects the cartbox SDK into a Lua cart (returns non-Lua carts unchanged). */
declare function injectSdk(bytes: Uint8Array): Uint8Array;

/**
 * Replay verification (Platform P2).
 *
 * The payoff of deterministic replays + the event mailbox: a submitted score can
 * be trusted by *re-running the replay* headlessly and reading what the cart
 * actually emitted. Because the run is deterministic (recorded inputs + RNG
 * seed), the recomputed score is exactly what the player saw — so a tampered
 * claim can't pass.
 *
 * This module is pure over a {@link ConsoleInstance} (the caller loads the cart,
 * seeded and with the SDK, into the console). It reuses the same input playback
 * and mailbox decoding the live player uses, so verification and play agree.
 */

/**
 * Re-runs a replay into a loaded console and returns every platform event the
 * cart emits. The console must already hold the correct cartridge (seeded with
 * `replay.seed`, SDK present) for the result to match the original session.
 */
declare function runReplayEvents(console: ConsoleInstance, replay: Replay): MailboxEvent[];
/** The best (maximum) score emitted, or null if the cart posted no score. */
declare function extractScore(events: MailboxEvent[]): number | null;
/** The distinct achievement ids unlocked during the run. */
declare function extractUnlocks(events: MailboxEvent[]): number[];
interface VerificationResult {
    /** The score the replay actually produced (null if none). */
    score: number | null;
    /** Achievement ids the replay legitimately unlocked. */
    unlocks: number[];
    /** True when the claimed score equals the recomputed score. */
    verified: boolean;
}
/**
 * Verifies a claimed score by re-running the replay.
 *
 * @param console A console already loaded with the seeded cart + SDK.
 * @param replay The recorded session.
 * @param claimedScore The score the submitter claims.
 */
declare function verifyReplayScore(console: ConsoleInstance, replay: Replay, claimedScore: number): VerificationResult;

/**
 * Achievement resolution (Platform P2).
 *
 * The mailbox carries achievement unlocks as FNV-1a hashes of their string key
 * (see hashEventId / the cartbox SDK). To grant an unlock, the platform maps
 * those hashes back to the achievements registered for the cart. This resolver
 * is the pure core of that mapping; the worker fetches the cart's registered
 * achievements and calls it with the hashes a verified replay produced.
 */
/** An achievement as registered for a cart. */
interface RegisteredAchievement {
    /** Achievement row id. */
    id: string;
    /** FNV-1a hash of the achievement key (matches the mailbox event id). */
    hash: number;
    /** Optional human key (e.g. "first_blood"). */
    key?: string;
}
/**
 * Returns the registered achievements whose hash appears in the unlock hashes.
 * Hashes are compared as unsigned 32-bit values, matching the mailbox encoding.
 */
declare function resolveUnlockedAchievements(unlockHashes: number[], registered: RegisteredAchievement[]): RegisteredAchievement[];

/**
 * Scene rendering: the seam between "what to draw" and "what draws it".
 *
 * Both 3D overlays — {@link MeshOverlaySurface} and {@link WorldOverlaySurface} —
 * called `renderMeshScene` from `@cartbox/editor` directly, which is a pure
 * software rasteriser running on the main thread. That was Phase 2 of the mesh
 * feature and it is why the player has had no GPU triangle path: the renderer
 * was not a dependency the surfaces could swap, it was a function they called.
 *
 * This makes it a dependency. Both overlays now draw through a `SceneRenderer`,
 * of which there are two: the software one (the existing rasteriser, unchanged)
 * and a WebGPU one. `createSceneRenderer` probes for a device and returns the
 * GPU renderer when it can, the software renderer when it cannot — the same
 * probe-and-fall-back shape `createLightingLayer` uses for lighting, for the
 * same reason: a missing or failed device must degrade, never blank the screen.
 *
 * Why an era roadmap needs this: a PS1-era console model is defined by *how* it
 * rasterises (no depth buffer, affine texture mapping), not by its resolution.
 * That is a renderer that honours a `RenderCaps` block — impossible while the
 * rasteriser is a hardcoded call. See ERA_MODELS.md §5.1.
 */

/** One frame's worth of drawing parameters — mirrors `renderMeshScene`'s options. */
interface SceneDraw {
    readonly width: number;
    readonly height: number;
    /** The framebuffer to composite into, RGBA8, `width * height * 4`. */
    readonly out: Uint8ClampedArray;
    /**
     * Depth scratch, `width * height`.
     *
     * Owned by the renderer for the duration of the call and meaningless outside
     * it: the software renderer fills it, the GPU renderer keeps depth on the GPU
     * and never touches this array. No caller reads it back, and none may start —
     * a renderer is free to ignore it entirely.
     */
    readonly depth: Float32Array;
    readonly view: Mat4;
    readonly projection: Mat4;
    /**
     * Clear colour, or null to composite over whatever `out` already holds (the
     * cart's own frame). Null is what makes these surfaces overlays.
     */
    readonly background: readonly [number, number, number, number] | null;
    /**
     * Key light direction, or omitted for the rasteriser's default. The world
     * overlay publishes a cart-driven sun here, so it changes per frame.
     */
    readonly lightDirection?: readonly [number, number, number];
    /** Ambient floor, or omitted for the rasteriser's default (0.35). */
    readonly ambient?: number;
    /**
     * Image-based lighting environment for PBR (Modern-tier) materials, or omitted
     * for the flat ambient stand-in. When present it replaces the flat ambient with
     * directional irradiance + a specular reflection. See {@link EnvironmentLight}.
     */
    readonly environment?: EnvironmentLight | null;
    /**
     * Directional shadow map for PBR (Modern-tier) materials, or omitted for no
     * shadows. The caller fills it with `renderShadowMap` before this call; the
     * renderer samples it to occlude the direct light. See {@link ShadowInput}.
     */
    readonly shadow?: ShadowInput | null;
    /**
     * HDR tone mapping for PBR (Modern-tier) materials, or omitted to write the
     * shaded colour straight to the framebuffer. See {@link ToneMap}.
     */
    readonly tonemap?: ToneMap | null;
    /**
     * Screen-space ambient-occlusion buffer (`width×height`, 0..1), or omitted. The
     * caller builds it from a geometry pre-pass; the renderer multiplies the PBR
     * ambient term by it. The GPU path uploads it and samples per fragment.
     */
    readonly ssao?: Float32Array | null;
    /**
     * Multiple lights for PBR (Modern-tier) materials, replacing the single
     * `lightDirection`. Decoupled from the full 6-slot 2D mailbox. See
     * {@link SceneLight}.
     */
    readonly lights?: readonly SceneLight[] | null;
    /** Shadow maps of the spot and point lights that cast (EP8c), indexed by their `shadowTile`. See {@link LocalShadows}. */
    readonly localShadows?: LocalShadows | null;
    /**
     * Distance fog for PBR (Modern-tier) materials, applied after tone mapping, or
     * omitted for none. Both backends fade by the fragment's eye depth. See
     * {@link SceneFog}.
     */
    readonly fog?: SceneFog | null;
    /** Seconds since the scene started, for animated emissive (scroll and pulse). */
    readonly time?: number;
    /**
     * Skip instances whose world AABB is entirely outside the camera frustum. A
     * correct cull is output-identical, so it is a pure perf win; default off.
     */
    readonly cull?: boolean;
    /** Swap LOD-carrying instances to the mesh their camera distance selects. */
    readonly lod?: boolean;
    /**
     * Drop instances hidden behind nearer geometry. Costs a CPU depth pre-pass, so
     * it is opt-in; conservative, so it never removes visible geometry.
     */
    readonly occlude?: boolean;
}
/**
 * Where a renderer's newest frame stands (see {@link SceneRenderer.settle}):
 * on screen ("current"), its readback still in flight ("pending"), or submitted
 * without a readback, so it needs rendering again to be seen ("stale").
 */
type FrameState = "current" | "pending" | "stale";
interface SceneRenderer {
    /** Human-readable backend name, for diagnostics and tests. */
    readonly backend: "software" | "webgpu" | "webgl2";
    render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void;
    /**
     * Show the newest finished frame in `draw.out` without submitting another, and
     * say whether the newest frame submitted is the one now shown. An editor that
     * draws only when something changes calls this until it reads "current" (and
     * renders again on "stale"), so a slow GPU's late readback still reaches the
     * screen. A renderer that draws synchronously has nothing to settle.
     */
    settle?(draw: SceneDraw): FrameState;
    /** False while a GPU renderer has no finished frame to show yet (just built); absent for one that always has. */
    readonly ready?: boolean;
    dispose(): void;
    /** What the last frame drew, for the profiler (see debug/profiler.ts). */
    readonly lastFrameStats?: RenderStats;
}
/**
 * The existing pure rasteriser, behind the interface. Nothing about it changes:
 * it stays the reference implementation the GPU path is checked against, and
 * the fallback whenever WebGPU is absent.
 */
declare class SoftwareSceneRenderer implements SceneRenderer {
    private readonly style;
    readonly backend: "software";
    /**
     * @param style How to rasterise — the era behaviour a console model asks for.
     *   Defaults to the modern one, so an editor preview or a test that passes
     *   nothing renders exactly as it always has.
     */
    constructor(style?: RasterStyle);
    lastFrameStats: RenderStats;
    render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void;
    dispose(): void;
}
/**
 * Applies a model's scene-level {@link RenderCaps} before delegating.
 *
 * A decorator rather than a branch inside each backend, so the software
 * rasteriser and the GPU enforce a model's limits *identically*. An era model's
 * constraints are part of the model, not of the viewer's graphics stack: a cart
 * that overruns a poly budget must overrun it the same way on both.
 */
declare class CappedSceneRenderer implements SceneRenderer {
    private readonly inner;
    private readonly caps;
    private readonly cache;
    constructor(inner: SceneRenderer, caps: RenderCaps);
    get backend(): SceneRenderer["backend"];
    get lastFrameStats(): RenderStats | undefined;
    render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void;
    settle(draw: SceneDraw): FrameState;
    get ready(): boolean | undefined;
    dispose(): void;
}
/** True when a model's caps constrain the scene, so wrapping would do something. */
declare function capsConstrainScene(caps: RenderCaps): boolean;

/**
 * Enforcing a model's {@link RenderCaps} on a scene, before anything rasterises it.
 *
 * `RenderCaps` landed as a descriptor nothing read — which is the difference
 * between a field and a seam. This reads two of them.
 *
 * Both are enforced *here*, above the renderer, rather than inside either
 * backend. That is deliberate: a constraint applied to the scene is honoured
 * identically by the software rasteriser and the GPU, so an era model's limits
 * do not depend on whether the viewer's browser has WebGPU. The caps that
 * cannot be lifted out this way — no depth buffer, affine texture mapping,
 * integer vertex snapping, texture filtering — live inside the rasteriser and
 * are not honoured yet; see ERA_MODELS.md §4a for why that ordering matters.
 *
 * Pure and DOM-free, so the limits are testable without a GPU.
 */

/**
 * Memo of downsampled textures, keyed by their source.
 *
 * Identity stability is the point, not just the saved work: the GPU renderer
 * caches its uploads by texture object, so returning a fresh object each frame
 * would re-upload every texture on every frame — strictly worse than no cap at
 * all. Held by the caller so it lives as long as the renderer does.
 */
type TextureBudgetCache = WeakMap<DecodedTexture, DecodedTexture>;
declare function createTextureBudgetCache(): TextureBudgetCache;
/**
 * Drop whole instances once the frame's triangle budget is spent.
 *
 * Granularity is the instance, not the triangle, for two reasons. Slicing index
 * buffers mid-mesh would allocate fresh geometry every frame and miss the
 * renderer's upload cache; and half an object is not a thing any real console
 * drew — it ran out of time and dropped the frame.
 *
 * The first instance always draws even if it alone exceeds the budget: a single
 * over-budget object is a content problem for the editor to flag, not something
 * the runtime should silently blank. So this bounds scene *complexity across
 * objects*, which is what a poly budget is actually for.
 */
declare function capTriangles(instances: readonly MeshSceneInstance[], polyBudget: number): readonly MeshSceneInstance[];
/**
 * Halve a texture with a box filter until it fits the budget.
 *
 * This is what a small texture cache actually looked like: the N64's 4KB budget
 * is why its era reads as soft and low-resolution, not because the hardware
 * blurred things for effect. Halving (rather than resampling to an arbitrary
 * size) keeps the filter exact — every output texel is the mean of four inputs —
 * and keeps power-of-two art on its grid.
 */
declare function fitTextureToBudget(source: DecodedTexture, budgetBytes: number): DecodedTexture;
/**
 * Fit every instance's textures into the budget, reusing cached results so a
 * texture is downsampled once rather than once per frame.
 *
 * Returns the original array when nothing needed shrinking, so an unbounded
 * model allocates nothing. When something does shrink, only the instance
 * wrapper is rebuilt — `mesh` keeps its identity, so the renderer's geometry
 * cache still hits.
 */
declare function capTextures(instances: readonly MeshSceneInstance[], budgetBytes: number, cache: TextureBudgetCache): readonly MeshSceneInstance[];
/** Apply every scene-level cap a model declares. */
declare function applyRenderCaps(instances: readonly MeshSceneInstance[], caps: RenderCaps, cache: TextureBudgetCache): readonly MeshSceneInstance[];
/**
 * The rasteriser style a model's caps ask for.
 *
 * `trilinear` maps to bilinear because no mip chain exists yet on either
 * backend. Mapping it the same way in both is the point: an N64-era model then
 * renders identically whether or not the viewer has WebGPU, and gains real
 * trilinear filtering on both at once when mips land.
 */
declare function rasterStyleFor(caps: RenderCaps): RasterStyle;
/**
 * Whether the WebGPU path can reproduce a style, or the software rasteriser has
 * to take the model.
 *
 * Filtering is just a sampler, so the GPU handles it. The other three are not
 * cheap on a GPU:
 *
 * - **No depth buffer** needs a per-*triangle* back-to-front sort across the
 *   whole scene. On the GPU that means rebuilding and re-uploading index
 *   buffers every frame, which destroys the geometry cache the renderer is
 *   built around. Sorting whole draws instead would be coarser than the
 *   software path and break parity, which is worse than not offering it.
 * - **Affine interpolation** and **vertex snapping** are both reachable in WGSL
 *   (`@interpolate(linear)`, and rounding in the vertex shader), but each needs
 *   a shader variant, and shader variants cannot be verified without a device.
 *
 * Falling back is not a loss for the models that need them: a console with no
 * depth buffer and integer vertices is a low-polygon, low-resolution machine,
 * which is exactly the workload the software rasteriser already handles. An
 * N64-era model — depth-buffered, perspective-correct, filtered — is the tier
 * that actually needs the GPU, and it keeps it.
 */
declare function webgpuCanHonour(style: RasterStyle): boolean;

/**
 * The player's WebGL2 triangle path (ENGINE_ROADMAP.md, Phase 4): the GPU
 * renderer for browsers without WebGPU, so they no longer drop to the software
 * rasteriser — Safari before 26, Firefox on most platforms, older Android.
 *
 * It is a port of {@link WebgpuSceneRenderer} and keeps its contract: the same
 * shading, term for term (byte-identical to the software rasteriser on the
 * fantasy tiers, a visual match on the Modern PBR branch), the same instanced
 * batching, and the same asynchronous readback — the frame composited is the
 * newest one the GPU has finished, one or two behind, with the software
 * rasteriser drawing until the first lands.
 *
 * What differs is only how WebGL2 spells it:
 *
 * - The per-draw uniforms and per-instance transforms are the very buffers the
 *   WebGPU path fills (`writeInstanceUniform`, `writeInstanceTransform`): the
 *   WGSL layouts are std140, so they bind as uniform blocks unchanged. A block
 *   holds 64 instances (16 KB is WebGL2's guaranteed block size), so a larger
 *   batch goes out as several instanced draws.
 * - The shadow map, SSAO buffer and environment map are read with `texelFetch`
 *   (nearest, like `textureLoad`); the material maps through one sampler whose
 *   filter follows the era.
 * - WebGL's window origin is bottom-left, so the vertex stage flips Y: the
 *   framebuffer then holds the image top row first — what `readPixels` returns
 *   and what the SSAO lookup by `gl_FragCoord` expects — with no CPU flip.
 * - The readback is a pixel-pack buffer guarded by a fence, polled at the start
 *   of each frame, so `readPixels` never stalls the run loop.
 * - The projection is GL's own clip convention, so near-plane clipping matches
 *   the software rasteriser's.
 */

/** Instances per uniform block (and so per draw call): 64 × 240 bytes fits WebGL2's guaranteed 16 KB. */
declare const WEBGL_INSTANCES_PER_DRAW = 64;
/** Modern-tier lights the shader loops over at most. */
declare const WEBGL_MAX_LIGHTS = 128;
/** Makes the WebGL2 context the renderer draws with (injectable for tests); null when there is none. */
type GlContextProvider = () => any | null;
declare class WebglSceneRenderer implements SceneRenderer {
    private readonly gl;
    private readonly width;
    private readonly height;
    private readonly program;
    private readonly framebuffer;
    private readonly attachments;
    private readonly sampler;
    private readonly blankTexture;
    private readonly blankFloat;
    /** Floats between instance-block starts (the block offset alignment, in floats). */
    private readonly instanceAlignFloats;
    readonly backend: "webgl2";
    private readonly software;
    private readonly meshes;
    private readonly textures;
    private latest;
    private destroyed;
    /** The context was lost: the software rasteriser draws from here on. */
    private lost;
    private uniformBuffer;
    private uniformCapacity;
    private uniformData;
    private instanceBuffer;
    private instanceFloats;
    private instanceData;
    private readonly lightBuffer;
    private shadowTexture;
    private shadowSize;
    private shadowUploaded;
    private envTexture;
    private envSource;
    private probeTexture;
    private probeSource;
    private probeData;
    private ssaoTexture;
    private readonly readback;
    /** Readbacks in flight, oldest first. */
    private readonly pending;
    /** Frames submitted, the one `latest` holds, and the newest that got a readback (see settle). */
    private submitted;
    private latestSeq;
    private readSeq;
    /** What the last submitted frame drew (for the profiler and tests); GPU time when the browser can time it. */
    lastFrameStats: RenderStats;
    private readonly timer;
    /** Whether the era samples nearest (it shapes every program variant). */
    private readonly nearest;
    private constructor();
    /**
     * Build the renderer for one framebuffer size, or null when WebGL2 is missing,
     * the era's style needs the software rasteriser, or anything fails to build.
     */
    static create(width: number, height: number, style?: RasterStyle, contextProvider?: GlContextProvider): WebglSceneRenderer | null;
    render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void;
    /** Take the newest finished readback, if any (never waits). */
    private collect;
    /** Whether a finished GPU frame exists to show (false until the first readback lands). */
    get ready(): boolean;
    settle(draw: SceneDraw): FrameState;
    private submit;
    /** The clustered lights' params and info this frame (EP8; see the shader's clusterParams/clusterInfo). */
    private readonly clusterParams;
    private readonly clusterInfo;
    /** The near shadow cascade this frame (EP8b; see the shader's nearShadowMvp/nearShadow). */
    private readonly nearShadowMvp;
    private readonly nearShadow;
    /** Maps side by side in the shadow texture (2 with a near cascade), and the near map last uploaded in full. */
    private shadowCascades;
    private nearUploaded;
    /** The cell table and index list as integer textures, made on first use. */
    private clusterTextures;
    /** The per-frame uniforms a program needs (probes, clusters), set when it's put to use. */
    private frameUniforms;
    /** The light-probe grid (EP9): its uniforms, its 3D texture, and the grid it holds. */
    private readonly probeGridMin;
    private readonly probeGridScale;
    private readonly probeGridCount;
    private gridTexture;
    private gridSource;
    /** Point the probe uniforms at a frame's grid (uploading it once per grid), and bind it (a blank when there's none). */
    private uploadProbeGrid;
    private gridBlank;
    /** A 1×1×1 stand-in so the 3D sampler always has a complete texture. */
    private blankProbe;
    /** The spot/point shadows this frame (EP8c): on/biases, each tile's view, and the atlas (made on first use). */
    private readonly localShadowInfo;
    private readonly shadowTileMvp;
    private readonly shadowTileParams;
    private localAtlas;
    /** Upload a frame's shadow tiles into the atlas, and bind it (a blank stands in when there are none). */
    private uploadLocalShadows;
    /** Upload a frame's cells (only the index rows in use), and bind both textures. */
    private uploadClusters;
    /** Programs by material graph (EP7), linked on first use. */
    private readonly graphPrograms;
    /** The program a material draws with: the plain one, or its graph's variant. */
    private programOf;
    /** The opaque depth, as a texture the transparent pass can read (EP6b): made on first use. */
    private sceneDepth;
    /** Copy the main framebuffer's depth into {@link sceneDepth} and bind it, leaving the main framebuffer bound. */
    private copySceneDepth;
    private ensureCapacity;
    private bindTexture;
    private textureFor;
    private uploadShadow;
    private uploadEnv;
    private uploadProbes;
    private uploadSsao;
    /** Upload (once) a mesh's primitives; a live skinned primitive re-uploads when its revision moves on. */
    private uploadMesh;
    dispose(): void;
}

/**
 * Chooses and builds the 3D scene renderer: WebGPU when a device is available,
 * else WebGL2 (the GPU path for browsers without WebGPU), else the software
 * rasteriser.
 *
 * The same shape as `createLightingLayer`, deliberately — one memoised adapter
 * probe per page, a provider that returns null rather than throwing, and a
 * caller that never has to know which backend it got. The one difference is the
 * return type: lighting can genuinely fail to build (the cart then shows unlit),
 * but there is always a scene renderer, because the software path needs nothing
 * from the platform. This never returns null, so no caller needs a third branch.
 */

/** Resolves a shared WebGPU device, or null. Injectable for tests. */
type DeviceProvider$1 = () => Promise<any | null>;
/**
 * Build the best available renderer for one framebuffer size, under one model's
 * {@link RenderCaps}.
 *
 * Caps are required rather than optional: a renderer exists to draw *some
 * model's* scenes, and leaving its limits implicit is how an era model ends up
 * silently rendering with another era's rules. The caps wrapper is only applied
 * when it would do something, so an unbounded model pays nothing for it.
 *
 * Pass providers returning null to force the software path — which is how the
 * fallback stays tested rather than becoming code nobody runs until a browser
 * without a GPU finds the bug.
 */
declare function createSceneRenderer(width: number, height: number, caps: RenderCaps, deviceProvider?: DeviceProvider$1, glProvider?: GlContextProvider): Promise<SceneRenderer>;

/**
 * The player's WebGPU triangle path.
 *
 * The runtime had no GPU renderer for 3D: both overlays rasterised meshes on the
 * CPU, on the main thread, every presented frame. That capped how much geometry
 * a cart could carry far below what the World and Mesh editors let people
 * author, and it is the reason no era console model beyond a 2D one was
 * possible (ERA_MODELS.md §5.1).
 *
 * This draws the same instances in hardware. For the fantasy tiers it matches
 * the software rasteriser's shading *exactly* — two-sided Lambert with an
 * ambient floor, nearest-sampled wrapped textures, glTF's flipped V, and the
 * same alpha-discard threshold. Parity is the contract there: the fallback must
 * be indistinguishable, not merely similar, or a cart looks different depending
 * on the viewer's browser.
 *
 * The Modern (AAA) tier adds a metallic-roughness Cook-Torrance BRDF, gated on
 * `pbr.z` and mirroring the software rasteriser's PBR branch term for term (see
 * `meshRasterizer.ts`). That branch cannot be *byte*-identical — GGX and `pow`
 * differ slightly between the GPU's float32 and the CPU's float64 — so the
 * contract there is a visual match, validated in-browser (and on a real device
 * by `webgpu-parity.test.ts`), not the zero-tolerance fantasy parity. Both the
 * gate and the maths that decide byte placement live in the pure, tested
 * `scenePacking.ts`. (Tangent-space normal maps and the fantasy material-map
 * specular are not yet on this GPU path — a known follow-up; the software
 * rasteriser remains the reference for those.)
 *
 * ## Why the readback, and why it lags
 *
 * `DisplaySurface.blit` is synchronous and the overlays are decorators: their
 * output has to flow onward through the lighting and post-FX stack, so this
 * cannot present to its own swapchain and be done. It must land RGBA bytes back
 * in the framebuffer. GPU readback is asynchronous, so the renderer submits work
 * for the current frame and composites the most recently *completed* readback —
 * in practice one to two frames old on the overlay only. The cart's own 2D frame
 * is never delayed. Until the first readback lands, the software rasteriser
 * draws instead, so there is no pop-in on the opening frames.
 *
 * A stale overlay is the deliberate trade for not stalling the run loop: waiting
 * on `mapAsync` inside `blit` would convert a GPU win into a pipeline bubble
 * worse than the CPU path it replaces.
 *
 * ## Instancing
 *
 * Every copy of a primitive that binds the same textures goes out as one
 * instanced draw: a forest of one tree mesh, a pool of spawned crates or a
 * level's repeated pillars costs one draw call per primitive rather than one per
 * copy. The material uniforms are shared by the batch; each copy's transforms
 * (mvp, light mvp, model, normal basis) live in a storage buffer indexed by
 * `instance_index`. They are still composed on the CPU in float64 and handed
 * over as the same float32s the per-draw uniforms carried, so batching changes
 * nothing on screen. The one ordering it does change is between exactly
 * coplanar copies (which one wins the depth tie), where draw order was already
 * an accident.
 *
 * WebGPU is not in this project's TS DOM lib and we do not want the
 * @webgpu/types dependency, so the handles are loosely typed — the same
 * convention the editor's GPU renderers use. Everything with real logic in it
 * (layout, packing, the parity maths) is pure and tested without a GPU.
 */

declare class WebgpuSceneRenderer implements SceneRenderer {
    private readonly device;
    private readonly width;
    private readonly height;
    private readonly pipeline;
    /** Build the pipelines for a shader variant (a material graph's, EP7). */
    private readonly pipelinesFor;
    private readonly bindGroupLayout;
    private readonly colourTexture;
    private readonly depthTexture;
    /** Group 1 (EP6b): the opaque depth for the see-through pass, or a blank for the opaque one. */
    private readonly depthGroups;
    private readonly sampler;
    private readonly blankTexture;
    /** 1x1 r32float, bound to the shadow slot when no shadow map is active. */
    private readonly blankShadow;
    private readonly readback;
    private readonly bytesPerRow;
    readonly backend: "webgpu";
    /** Draws the opening frames, and any frame before the first readback lands. */
    private readonly software;
    private readonly meshes;
    private readonly textures;
    private bindGroups;
    /** Most recent completed readback, or null before the first one lands. */
    private latest;
    /** Frames submitted, the one `latest` holds, and the newest that got a readback (see settle). */
    private submitted;
    private latestSeq;
    private readSeq;
    /** The shadow depth array last uploaded in full, so a frame that changed only
     *  a region of it (its `dirty` rect) uploads just that region. */
    private shadowUploaded;
    private uniformCapacity;
    private uniformBuffer;
    private uniformData;
    private destroyed;
    /**
     * The bound shadow map — the 1x1 blank when no shadow this frame, else an
     * r32float sized to the shadow input and uploaded from the CPU-generated map.
     * Its identity only changes on a size change, so the bind-group cache holds.
     */
    private shadowTexture;
    private shadowMapSize;
    /** Maps side by side in the shadow texture: 1, or 2 with a near cascade (EP8b). */
    private shadowCascades;
    /** The near cascade's depth array last uploaded in full (as shadowUploaded is the main map's). */
    private nearUploaded;
    /**
     * The bound equirectangular environment map — the 1x1 blank (reusing the white
     * texture) when the frame has none, else an rgba8unorm upload of the decoded
     * panorama. Keyed by the source object so it uploads once per distinct map.
     */
    private envTexture;
    private envMapSource;
    /** The SSAO buffer: a lazily-created width×height r32float upload target, and
     *  what binding 8 currently references (that upload, or the 1x1 blank). */
    private ssaoTexture;
    private ssaoBound;
    /** The Modern-tier light storage buffer, grown as needed; always ≥ 1 light. */
    private lightBuffer;
    private lightBufferFloats;
    /** The reflection-probe atlas (binding 12, the 1x1 blank when none) and its source. */
    private probeTexture;
    private probeSource;
    /** The probe boxes (binding 13): room for every probe a scene may carry. */
    private probeBuffer;
    /** Per-instance transforms (binding 10), grown as needed. */
    private instanceBuffer;
    private instanceCapacity;
    private instanceData;
    /** What the last submitted frame drew (for the profiler and tests); GPU time when the device can time it. */
    lastFrameStats: RenderStats;
    private readonly timer;
    private constructor();
    /**
     * Point the SSAO slot at a width×height r32float upload of `ao` (created once,
     * lazily), or the 1x1 blank when there is none; a change invalidates cached
     * bind groups (binding 8 moved).
     */
    private bindSsao;
    /**
     * Upload the packed light list, growing the storage buffer when it needs more
     * room (a grow changes identity, so invalidate cached bind groups). The buffer
     * always holds at least one light so binding 9 is never empty.
     */
    private uploadLights;
    /**
     * Build the renderer for one framebuffer size. Returns null on any failure, so
     * the factory falls back to software rather than the caller seeing an
     * exception mid-frame.
     */
    static create(device: any, width: number, height: number, style?: RasterStyle): Promise<WebgpuSceneRenderer | null>;
    /**
     * Point the shadow slot at an r32float sized to `size`, (re)creating it on a
     * size change and invalidating cached bind groups (binding 6 identity moved).
     * `size` 0 restores the 1x1 blank for a frame with no shadow.
     */
    private ensureShadowTexture;
    /**
     * Point the env-map slot at an rgba8unorm upload of `map`, once per distinct
     * source object; null restores the 1x1 blank. A change invalidates cached bind
     * groups (binding 7 moved).
     */
    private ensureEnvTexture;
    /** The same for the reflection-probe atlas (binding 12), plus the boxes (binding 13). */
    private ensureProbes;
    /** A one-off rgba8unorm upload of a decoded image. */
    private uploadRgba;
    render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void;
    /** Whether a finished GPU frame exists to show (false until the first readback lands). */
    get ready(): boolean;
    settle(draw: SceneDraw): FrameState;
    /** Encode and submit one frame, and start a readback if a buffer is free. */
    private submit;
    /** Shader variants by material graph (EP7), built on first use. */
    private readonly graphPipelines;
    /** The pipelines a material draws with: the plain shader's, or its graph's variant. */
    private pipelinesOf;
    /**
     * Order the frame's lights (global first), build the clustered cells, and
     * write both and their params. An orthographic view (no cells) loops every light.
     */
    private clusterLights;
    /** Upload a probe grid (EP9) as a 3D texture, once per grid, rebuilding group 1 to point at it. */
    private uploadProbeGrid;
    /** Upload the spot/point shadow tiles (EP8c): each tile into its atlas cell, and every tile's view. */
    private uploadLocalShadows;
    /** Await one readback and publish it as the newest frame. */
    private drain;
    /** Grow the per-draw uniform buffer to hold at least `count` draws. */
    private ensureUniformCapacity;
    /** Grow the per-instance transform buffer to hold at least `count` instances. */
    private ensureInstanceCapacity;
    /**
     * Upload (once) a mesh's primitives as interleaved vertex + index buffers. A
     * live skinned primitive (`dynamic`) re-uploads its vertices into the same
     * buffer whenever its revision moves on.
     */
    private uploadMesh;
    /** The bind group for one primitive, rebuilt if any of its textures changed. */
    private bindGroupFor;
    /** Upload (once) a decoded texture. */
    private uploadTexture;
    dispose(): void;
}

/**
 * The pure half of the WebGPU scene renderer: memory layout and buffer packing.
 *
 * A GPU renderer is mostly untestable in CI — there is no adapter on a build
 * machine. What *is* testable is everything that decides where a byte goes, and
 * that is also where a GPU renderer's bugs actually live: a uniform written at
 * the wrong offset, a vertex stride that disagrees with the pipeline layout, a
 * readback row copied without removing WebGPU's 256-byte padding. Keeping all
 * of it here, pure and DOM-free, means the parts that break silently on a GPU
 * are the parts covered by tests.
 */

/**
 * WGSL uniform layout, in bytes:
 *
 * ```
 *   0  mvp        mat4x4<f32>  64
 *  64  nrm        mat3x3<f32>  48   (three vec3 columns, each padded to 16)
 * 112  base       vec4<f32>    16
 * 128  light      vec4<f32>    16   xyz = direction, w = ambient
 * 144  view       vec4<f32>    16   xyz = direction towards the viewer (Modern PBR), w = alpha cutoff
 * 160  pbr        vec4<f32>    16   x = metallic, y = roughness, z = 1 when PBR, w = alpha mode (0 opaque, 1 cut out, 2 blended, 3 added)
 * 176  emissive   vec4<f32>    16   xyz = emissive factor
 * 192  texflags   vec4<f32>    16   x = base, y = mr, z = occlusion, w = emissive
 * 208  envSky     vec4<f32>    16   xyz = sky colour, w = 1 when an environment is set
 * 224  envHorizon vec4<f32>    16   xyz = horizon colour, w = intensity
 * 240  envGround  vec4<f32>    16   xyz = ground colour
 * 256  lightMvp   mat4x4<f32>  64   world→light-clip for this draw (shadow mapping)
 * 320  shadow     vec4<f32>    16   x = 1 when shadowed, y = map size, z = bias, w = strength
 * 336  envMeta    vec4<f32>    16   xyz = env-map mean radiance, w = 1 when an env map is bound
 * 352  tonemap    vec4<f32>    16   x = 1 when tone-mapping, y = exposure,
 *                                    z = soft-edge distance (EP6b; 0 = hard)
 * 368  ssao       vec4<f32>    16   x = 1 when an SSAO buffer is bound, y = light count,
 *                                    z = 1 when a baked light map is bound,
 *                                    w = reflection-probe count
 * 384  model      mat4x4<f32>  64   this draw's world matrix (point-light world pos)
 * 448  fog        vec4<f32>    16   rgb = fog colour, w = density
 * 464  fogParams  vec4<f32>    16   x = 1 when fogged, y = start distance, z = max amount,
 *                                    w = 1 when the fog has height/volume/glow layers
 * 480  shadow2    vec4<f32>    16   x = slope-scaled shadow bias, y = 1 for 2x2 PCF,
 *                                    zw = projection[10], [14]: depth → view distance
 *                                    as zw.y / (ndcZ + zw.x) (soft edges, EP6b)
 * 496  surface0   vec4<f32>    16   x = detail scale, y = detail strength (0 = none),
 *                                    z = reflectivity, w = 1 when the MR alpha masks it
 * 512  surface1   vec4<f32>    16   xy = emissive UV offset (its scroll this frame)
 * 528  surface2   vec4<f32>    16   rgb = rim colour × strength, w = rim power
 * 544  surface3   vec4<f32>    16   rgb = blend-surface colour, w = its roughness (< 0 = keep)
 *                                    (surface1.z = 1 when the primitive carries blend weights,
 *                                    surface1.w = 1 when the blend surface has a texture)
 * 560  fogCam     vec4<f32>    16   xyz = eye (world), w = fog volume count
 * 576  fogHeight  vec4<f32>    16   x = height-fog density, y = base, z = falloff, w = glow strength
 * 592  fogGlow    vec4<f32>    16   rgb = sun-glow colour
 * 608  fogVol     vec4<f32>×8 128   per volume: min xyz + density, max xyz + falloff
 * 736  effect0    vec4<f32>    16   rgb = surface-effect glow, w = camo amount (H11)
 * 752  effect1    vec4<f32>    16   rgb = surface-effect bands, w = time (seconds)
 *                                    (an effect's rim adds into surface2, at its power)
 * ```
 *
 * 768 bytes used — exactly the stride to a 768-byte stride (a 256-byte multiple a dynamic
 * uniform offset can address), so one buffer still holds every draw in a
 * frame — uniforms are written per batch, not per copy, so the stride costs
 * little. The metallic-roughness inputs and the environment carry the Modern
 * (AAA) tier's shading; a fantasy draw leaves `pbr.z` at 0 and the shader takes
 * the byte-identical Lambert path, `envSky.w` at 0 falls back to flat ambient,
 * `envMeta.w` at 0 uses the analytic gradient instead of a panorama, and
 * `shadow.x` at 0 skips the shadow test.
 */
declare const UNIFORM_STRIDE = 768;
/**
 * Bytes the struct actually occupies, before the stride padding. This is what a
 * bind group layout's `minBindingSize` must be: it makes a WGSL struct that
 * grows past what this module writes fail at pipeline creation.
 */
declare const UNIFORM_BYTES_USED = 768;
/** The same stride counted in float32s, which is how `writeBuffer` sizes it. */
declare const UNIFORM_FLOATS: number;
/**
 * Floats per light in the storage buffer: four vec4s —
 *   d0: xyz = direction (directional) or world position (point, spot), w = kind (0 directional, 1 point, 2 spot)
 *   d1: rgb = colour, w = intensity
 *   d2: x = range (0 = no falloff), y = spot cone's outer cosine, z = its inner cosine,
 *       w = first shadow tile (EP8c), −1 when it casts none
 *   d3: xyz = spot beam axis (unit, the way it points)
 * Matches the `Light` struct in the WGSL and GLSL scene shaders.
 */
declare const LIGHT_FLOATS = 16;
/** A minimal light for {@link packLights} (mirrors editor's SceneLight). */
interface PackableLight {
    readonly kind: "directional" | "point" | "spot";
    readonly direction?: readonly [number, number, number];
    readonly position?: readonly [number, number, number];
    readonly color: readonly [number, number, number];
    readonly intensity: number;
    readonly range?: number;
    readonly innerAngle?: number;
    readonly outerAngle?: number;
    readonly shadowTile?: number;
}
/**
 * Pack a light list into the storage-buffer layout the WGSL loop reads. Always
 * returns at least one (zeroed) light so the binding is never empty; the draw's
 * `lightCount` uniform, not the buffer length, bounds the loop.
 */
declare function packLights(lights: readonly PackableLight[]): Float32Array;
/** The rasteriser's defaults, restated so an unlit draw shades identically. */
declare const DEFAULT_LIGHT: readonly [number, number, number];
declare const DEFAULT_AMBIENT = 0.35;
interface ResolvedLight {
    /** Unit direction; the shader dots against it without normalising. */
    readonly direction: readonly [number, number, number];
    readonly ambient: number;
}
/**
 * Apply the rasteriser's light defaulting and normalisation.
 *
 * The world overlay drives both per frame — a cart-published sun direction, and
 * an ambient level that differs by whether a sun is set at all — so this cannot
 * be a constant. It reproduces `renderMeshScene`'s exact handling, including its
 * degenerate-vector guard (a zero-length direction divides by 1, not by 0).
 */
declare function resolveLight(direction?: readonly [number, number, number] | null, ambient?: number | null): ResolvedLight;
/** Bytes per row in a texture-to-buffer copy: WebGPU requires a 256 multiple. */
declare function alignBytesPerRow(width: number): number;
/**
 * The upper-left 3x3 of a model matrix, column-major — what re-bases an object
 * normal into world space.
 *
 * This applies the rotation and scale rather than their inverse-transpose,
 * matching the software rasteriser exactly: correct for rotation and uniform
 * scale, slightly skewed under non-uniform scale, which two-sided Lambert
 * tolerates. Diverging here would make the two backends shade differently on
 * precisely the geometry most likely to be imported.
 */
declare function normalBasis3x3(model: Mat4): readonly number[];
/**
 * The Modern (AAA) tier's metallic-roughness inputs for one draw, mirroring the
 * software rasteriser's `buildPbrFrag` gate exactly (see `meshRasterizer.ts`): a
 * material is PBR when it carries any metallic-roughness signal — a map, or an
 * explicit metallic/roughness/emissive factor — and otherwise the fantasy path
 * runs. Keeping the gate here, pure and tested, is what keeps the two backends
 * from disagreeing about which materials light with the BRDF.
 */
interface ResolvedPbr {
    readonly isPbr: boolean;
    readonly metallic: number;
    readonly roughness: number;
    readonly emissive: readonly [number, number, number];
}
/** Just the material fields the PBR gate reads. */
interface PbrMaterial {
    readonly metallicFactor?: number;
    readonly roughnessFactor?: number;
    readonly emissiveFactor?: readonly [number, number, number];
    /** A material graph (EP7) always takes the PBR path. */
    readonly graph?: unknown;
}
/**
 * Resolve a draw's PBR inputs, matching `buildPbrFrag`. `hasMr`/`hasOcc`/`hasEmis`
 * say whether the instance bound each map for this primitive. The factor defaults
 * (metallic 1, roughness 1, emissive 0) are the glTF defaults the software path
 * uses too.
 */
declare function resolvePbr(material: PbrMaterial, hasMr: boolean, hasOcc: boolean, hasEmis: boolean): ResolvedPbr;
/**
 * The world-space direction *towards* the viewer, matching the software path
 * (`normalizeVec3(view[2], view[6], view[10])`): a look-at view maps this world
 * direction to view +Z, so it is the third row of the view rotation, treated as
 * directional (camera at infinity). The degenerate guard returns +Z, as the
 * rasteriser's `normalizeVec3` does.
 */
declare function viewDirection(view: Mat4): readonly [number, number, number];
/**
 * A draw's surface effects (HALO2_STYLE_ROADMAP.md H3; materialEffects.ts in
 * @cartbox/editor), resolved for this frame exactly as the software
 * rasteriser's `buildPbrFrag` does.
 */
interface ResolvedSurface {
    readonly detailScale: number;
    /** 0 when no detail map is bound. */
    readonly detailStrength: number;
    readonly reflect: number;
    readonly reflectMask: boolean;
    readonly emisOffset: readonly [number, number];
    /** Multiplies the emissive factor (the pulse). */
    readonly emisGain: number;
    /** Rim colour × strength (zeros for none) and power. */
    readonly rim: readonly [number, number, number];
    readonly rimPower: number;
    /** The blend surface (H4): on when the primitive carries weights; its colour, roughness (null = keep), and whether it has a texture. */
    readonly blend: {
        readonly color: readonly [number, number, number];
        readonly roughness: number | null;
        readonly textured: boolean;
    } | null;
}
interface InstanceUniform {
    readonly mvp: Mat4;
    /** Column-major 3x3 from {@link normalBasis3x3}. */
    readonly normalBasis: readonly number[];
    readonly baseColor: readonly [number, number, number, number];
    readonly hasTexture: boolean;
    /** This frame's light, from {@link resolveLight}. */
    readonly light: ResolvedLight;
    /** This frame's view direction, from {@link viewDirection} (Modern PBR). */
    readonly viewDir: readonly [number, number, number];
    /** This draw's PBR inputs, from {@link resolvePbr}. */
    readonly pbr: ResolvedPbr;
    /** Whether each PBR map is bound for this primitive. */
    readonly hasMrMap: boolean;
    readonly hasOcclusionMap: boolean;
    readonly hasEmissiveMap: boolean;
    /** This frame's image-based lighting environment, or null for flat ambient. */
    readonly environment: EnvironmentLight | null;
    /** World→light-clip for this draw (`shadow.lightViewProj · model`), or null. */
    readonly lightMvp: Mat4 | null;
    /** Shadow-map sampling parameters, or null when no shadow map is bound. */
    readonly shadow: {
        readonly size: number;
        readonly bias: number;
        readonly strength: number;
        /** Slope-scaled bias (0 = constant bias only). */
        readonly slopeBias?: number;
        /** 2x2 percentage-closer filtering. */
        readonly pcf?: boolean;
    } | null;
    /** HDR tone-map exposure, or null to write the shaded colour straight through. */
    readonly tonemap: {
        readonly exposure: number;
    } | null;
    /** Whether a screen-space AO buffer is bound (sampled per fragment on the GPU). */
    readonly hasSsao: boolean;
    /** A baked light map is bound (it scales the ambient/IBL term, PBR draws only). */
    readonly hasLightmap?: boolean;
    /** This draw's world matrix, for point-light world position in the shader. */
    readonly model: Mat4 | null;
    /** Number of lights in the shared storage buffer, or 0 for the single key light. */
    readonly lightCount: number;
    /** This draw's surface effects, or omitted for none. */
    readonly surface?: ResolvedSurface;
    /** Fog for PBR draws (distance, height, volumes, sun glow), or null/omitted for none. */
    readonly fog?: SceneFog | null;
    /** The eye in world space — height and volume fog trace the ray from it. */
    readonly eye?: readonly [number, number, number];
    /** A surface effect over the draw (shield flare, shimmer, camo — PBR draws only), or null/omitted for none. */
    readonly effect?: SurfaceEffect | null;
    /** Seconds, for the effect's bands and camo crawl. */
    readonly time?: number;
    /** The material's transparency (EP6): 0 opaque, 1 cut out below `cutoff`, 2 blended, 3 added. */
    readonly alpha?: {
        readonly mode: number;
        readonly cutoff: number;
    };
    /**
     * Soft edges (EP6b): the distance a see-through surface fades over as it
     * meets the opaque scene, and the projection terms that read depth back as distance.
     */
    readonly soft?: {
        readonly distance: number;
        readonly linear: readonly [number, number];
    };
}
/**
 * Floats per instance in the transform storage buffer (GPU instancing): the WGSL
 * `InstanceXf` struct — mvp, lightMvp and model (mat4x4 each) then the normal
 * basis (mat3x3, columns padded to vec4) — is 240 bytes, which is also its array
 * stride (a multiple of its 16-byte alignment).
 */
declare const INSTANCE_FLOATS = 60;
/** One instance's transforms, computed on the CPU so the GPU sees the same float32s the uniform path did. */
interface InstanceTransform {
    readonly mvp: Mat4;
    /** World→light-clip for this instance, or null when the frame casts no shadow. */
    readonly lightMvp: Mat4 | null;
    readonly model: Mat4;
    readonly normalBasis: readonly number[];
}
/**
 * Write one instance's transforms into the staging array at `index` (see
 * {@link INSTANCE_FLOATS}), or at float offset `base` when the caller lays
 * instances out itself (WebGL2 aligns each block's start).
 */
declare function writeInstanceTransform(target: Float32Array, index: number, transform: InstanceTransform, base?: number): void;
/**
 * Write one draw's uniforms into the shared staging array at `index`.
 *
 * The mat3x3 is the fiddly part: WGSL pads each column to 16 bytes, so the nine
 * values are written at float offsets 0,1,2 / 4,5,6 / 8,9,10 within the field
 * and never packed tight. Getting this wrong does not error — it silently shears
 * every normal, which reads as bad lighting rather than as a layout bug.
 */
declare function writeInstanceUniform(target: Float32Array, index: number, uniform: InstanceUniform): void;
/** Floats per vertex in the interleaved buffer: position(3) + normal(3) + uv(2) + light-map uv(2) + blend weight(1). */
declare const VERTEX_FLOATS = 11;
/**
 * Interleave the separate attribute streams into the single buffer the pipeline
 * declares (arrayStride 44). A primitive with no UVs (or no light-map UVs, or no blend weights) gets
 * zeros, which is what the software path effectively uses — and the shader
 * ignores them anyway because the matching texture flag is off.
 */
declare function interleaveVertices(positions: Float32Array, normals: Float32Array, uvs: Float32Array | null, uvs2?: Float32Array | null, blend?: Float32Array | null): Float32Array;
/**
 * Strip WebGPU's row padding from a mapped readback.
 *
 * `copyTextureToBuffer` writes each row at a 256-byte stride, so a 240-wide
 * frame arrives with 1024 bytes per row carrying 960 of image. Copying it
 * blindly shears the picture diagonally. `reuse` avoids allocating a fresh
 * frame buffer every readback.
 */
declare function unpadRows(padded: Uint8Array, width: number, height: number, bytesPerRow: number, reuse?: Uint8Array | null): Uint8Array;

/**
 * The backend-agnostic contract for the lighting renderer. Two implementations
 * satisfy it — {@link WebgpuLightingLayer} (preferred) and the WebGL
 * {@link LightingLayer} (fallback) — so the display surface and the factory can
 * treat them identically. Both run the same passes and the same lighting model
 * ({@link shade}); only the graphics API differs.
 */

/** Which graphics API a renderer is running on. */
type LightingBackend = "webgpu" | "webgl";
interface LightingRenderer {
    /** The backend this instance is using — for diagnostics and telemetry. */
    readonly backend: LightingBackend;
    /**
     * Relight one frame and present it to the canvas.
     *
     * @param albedo   The cart's RGBA framebuffer (width*height*4 bytes).
     * @param material Optional per-pixel material (normal/height/spec/rough); when
     *                 null, pixels are lit flat.
     * @param scene    The lights and ambient for this frame.
     */
    render(albedo: Uint8Array, material: MaterialBuffer | null, scene: LightingScene): void;
    /** Releases all GPU resources held by this renderer. */
    dispose(): void;
}
/**
 * A flat material: normal index 0 (facing camera), height 0, specular 0,
 * roughness full. Lighting a frame with this gives coloured, attenuated pools
 * over the cart's own art — the "no per-pixel material" path both backends share.
 */
declare function createFlatMaterial(width: number, height: number): Uint8Array;

/**
 * LightingLayer — a reusable, framework-agnostic WebGL renderer that relights a
 * console framebuffer. It is the LUMEN demo's pipeline lifted into the player so
 * any cart's output can be lit dynamically:
 *
 *   Pass 1  lighting  : albedo + material -> a scene texture
 *                       (Lambert diffuse from the 16-direction normals, plus
 *                        Blinn-Phong specular and height-field cast shadows).
 *   Pass 2  bright    : keep the glowing pixels, at half resolution.
 *   Pass 3  blur      : separable Gaussian, horizontal then vertical.
 *   Pass 4  composite : scene + bloom -> the canvas (this pass flips Y).
 *
 * The material buffer is optional: without it the layer lights flat pixels,
 * giving coloured, distance-attenuated pools over the cart's own art. With a
 * material buffer (from a lighting-aware cart or the editor's normal bank) it
 * upgrades to full per-pixel normals, specular, and shadows.
 *
 * The diffuse term matches {@link shade} in lightingModel.ts by construction.
 */

/** A minimal canvas shape — the real `HTMLCanvasElement` satisfies it, and so
 * can a fake in tests. */
interface RenderCanvas {
    width: number;
    height: number;
    getContext(contextId: string, options?: unknown): unknown;
}
declare class LightingLayer implements LightingRenderer {
    private readonly renderCanvas;
    private readonly width;
    private readonly height;
    private readonly supersample;
    readonly backend: LightingBackend;
    private readonly gl;
    private readonly quad;
    private readonly pLight;
    private readonly pBright;
    private readonly pBlur;
    private readonly pComposite;
    private readonly albedoTex;
    private readonly matTex;
    private readonly scene;
    private readonly bright;
    private readonly blurA;
    private readonly blurB;
    private readonly flatNormals;
    private readonly lightPos;
    private readonly lightColor;
    private readonly lightRadius;
    private readonly lightKind;
    private readonly lightDir;
    private readonly lightCone;
    private flatMaterial;
    /** Whether a WebGL lighting context can be created on this canvas. */
    static isSupported(canvas: RenderCanvas): boolean;
    constructor(renderCanvas: RenderCanvas, width: number, height: number, supersample?: number);
    /**
     * Relight one frame and present it to the canvas.
     *
     * @param albedo   The cart's RGBA framebuffer (width*height*4 bytes).
     * @param material Optional per-pixel material (normal/height/spec/rough); when
     *                 null, pixels are lit flat.
     * @param scene    The lights and ambient for this frame.
     */
    render(albedo: Uint8Array, material: MaterialBuffer | null, scene: LightingScene): void;
    /** Releases all GL resources. */
    dispose(): void;
    private flatMaterialBuffer;
    private uni;
    private bindQuad;
    private bindSampler;
    private build;
    private makeDataTexture;
    private makeTarget;
}

/**
 * WebgpuLightingLayer — the WebGPU implementation of the lighting pipeline, the
 * preferred backend. It runs the same four passes as the WebGL {@link
 * LightingLayer} (lighting → bright → blur → composite) and the same lighting
 * model, in WGSL. `create` is async (WebGPU device acquisition is) and returns
 * null on any failure, so the factory can fall back to WebGL — never a blank
 * screen.
 *
 * WebGPU isn't in the TS DOM lib here and we avoid the @webgpu/types dependency
 * (matching the editor's WebGpuLitRenderer), so GPU handles are loosely typed.
 * WebGPU keeps a consistent top-left texture/framebuffer origin across render
 * targets, so — unlike the WebGL path — no pass needs a Y-flip.
 */

declare class WebgpuLightingLayer implements LightingRenderer {
    private readonly device;
    private readonly context;
    private readonly width;
    private readonly height;
    private readonly textures;
    private readonly targets;
    private readonly pipelines;
    private readonly binds;
    private readonly buffers;
    readonly backend: LightingBackend;
    private flatMaterial;
    private readonly lightData;
    private readonly compData;
    private constructor();
    static create(canvas: RenderCanvas, width: number, height: number, device: any, supersample?: number): Promise<WebgpuLightingLayer | null>;
    render(albedo: Uint8Array, material: MaterialBuffer | null, scene: LightingScene): void;
    dispose(): void;
    private runPass;
    private flatMaterialBuffer;
}

/**
 * Acquires a shared WebGPU device, memoised so a page with many players probes
 * the adapter only once. Returns null (never throws) when WebGPU is unavailable
 * or the adapter/device can't be obtained, which is the signal the factory uses
 * to fall back to WebGL.
 */
declare function getWebgpuDevice(): Promise<any | null>;

/**
 * Chooses and builds the lighting renderer: WebGPU when a device is available,
 * otherwise the WebGL fallback. Because a canvas is locked to one context type
 * once `getContext` is called, this owns canvas creation — it hands back the
 * canvas it configured alongside the renderer, and uses a fresh canvas for the
 * WebGL attempt so a failed WebGPU probe can't poison it. Returns null only when
 * neither backend works (the caller then shows the cart unlit in plain 2D).
 */

interface BuiltLightingRenderer {
    renderer: LightingRenderer;
    canvas: HTMLCanvasElement;
}
/** Resolves a shared WebGPU device, or null. Injectable for tests. */
type DeviceProvider = () => Promise<any | null>;
/**
 * The supersample factor to actually use: an explicit request clamped to 1..4,
 * or — when unset — 2 for standard-resolution framebuffers and 1 for large ones.
 * Exposed so both the layer factory and its tests resolve it the same way.
 */
declare function resolveSupersample(width: number, height: number, requested?: number): number;
declare function createLightingLayer(doc: Document, width: number, height: number, deviceProvider?: DeviceProvider, supersample?: number): Promise<BuiltLightingRenderer | null>;

/**
 * Display surface: owns the <canvas>, computes scaling, and blits engine
 * framebuffers. The scaling math is a pure function so it can be unit-tested
 * without a DOM.
 */

/**
 * A display surface the player can present frames to. Both the plain 2D
 * {@link CanvasSurface} and the WebGL {@link LitCanvasSurface} implement it, so
 * the run loop presents frames the same way regardless of lighting.
 */
interface DisplaySurface {
    /** Present one RGBA framebuffer. */
    blit(rgba: Uint8Array): void;
    /** Release the canvas and any observers. */
    destroy(): void;
}

/**
 * LitCanvasSurface — a display surface that relights each frame through the
 * lighting renderer before showing it. It is a drop-in for {@link CanvasSurface}:
 * the run loop still calls `blit(albedo)`; this surface pulls the frame's lights
 * (and optional material) from the host's {@link LightingOptions} and renders
 * them over the cart's own art.
 *
 * Construction is async ({@link create}) because choosing the backend may need
 * to await a WebGPU device. The factory prefers WebGPU and falls back to WebGL;
 * if neither is available this surface falls back to plain 2D, so enabling
 * lighting can never stop a cart from playing.
 */

declare class LitCanvasSurface implements DisplaySurface {
    private readonly container;
    private readonly scaleMode;
    private readonly model;
    private readonly options;
    private readonly performanceNow;
    private readonly resizeObserver;
    private readonly renderer?;
    private readonly canvas?;
    private readonly fallback?;
    private frame;
    private cartLights;
    private albedoCopy;
    private cartMaterial;
    private cartMaterialCopy;
    private cartEmissive;
    private constructor();
    /** Builds the surface, choosing the best available lighting backend. */
    static create(container: HTMLElement, scaleMode: ScaleMode, model: ConsoleModel, options: LightingOptions): Promise<LitCanvasSurface>;
    /** Whether the lit path is active (false means it fell back to plain 2D). */
    get isLit(): boolean;
    /** The active backend: "webgpu", "webgl", or "2d" when unlit. */
    get backend(): LightingBackend | "2d";
    /**
     * Sets the lights the running cart emitted this frame (via `cartbox.light`).
     * They are combined with any host-provided lights on the next {@link blit}.
     */
    setCartLights(lights: readonly Light[]): void;
    /**
     * Sets the per-pixel material buffer the engine emitted for this frame's
     * sprites (RGBA: normal index, height, specular, roughness). Copied into a
     * stable buffer on {@link blit}; an empty buffer falls back to host material.
     */
    setCartMaterial(material: Uint8Array): void;
    /**
     * Sets the per-pixel emissive plane (one byte each) the engine emitted this
     * frame. It is folded into the albedo copy's alpha channel on {@link blit},
     * which both lighting backends read as self-illumination. An empty buffer
     * leaves the framebuffer's own alpha untouched.
     */
    setCartEmissive(emissive: Uint8Array): void;
    blit(albedo: Uint8Array): void;
    destroy(): void;
    private resolveMaterial;
    private applyScale;
}

/**
 * The Cartbox lighting model, in pure TypeScript — DOM-free and side-effect
 * free so it can be unit-tested and reused on the server. It is the exact model
 * the editor authors against (packages/editor/src/model/normals.ts and
 * lighting.ts): a per-pixel normal chosen from 16 directions, shaded by Lambert
 * diffuse lifted over an ambient floor. The runtime {@link LightingLayer} runs
 * the same maths in a shader; keeping this here lets both agree by construction.
 */

/** A 3-component vector. */
type Vec3$1 = readonly [number, number, number];
/** An RGB colour, each channel 0..255. */
type Rgb = readonly [number, number, number];
/** A pixel stores one of this many normal-direction indices (4 bits). */
declare const NORMAL_DIRECTION_COUNT = 16;
declare const NORMAL_VECTORS: readonly Vec3$1[];
/** The unit surface normal for a direction index (flat when out of range). */
declare function normalVector(direction: number): Vec3$1;
/** The direction index whose stored normal is closest to an arbitrary vector. */
declare function nearestDirection(vector: Vec3$1): number;
/**
 * Bilinearly blend four corner normals — decoded unit *vectors*, never the
 * direction indices — by fractional weights and renormalise. Interpolating the
 * vectors is the whole point: the 16 stored directions are an unordered palette,
 * so blending their indices would be meaningless, but blending the vectors they
 * decode to turns the quantised, facet-banded field into a smooth one. This is
 * cinematic gap #2 — the fix for the Mach banding that betrays the 16-direction
 * normals on any curved surface. The shaders (WebGL + WebGPU) run this exact
 * blend per fragment from four material-texel lookups; keeping it here lets a
 * test pin the behaviour the GLSL only shows on a GPU.
 *
 * @param corner00 Normal at the top-left texel.
 * @param corner10 Normal at the top-right texel.
 * @param corner01 Normal at the bottom-left texel.
 * @param corner11 Normal at the bottom-right texel.
 * @param fractionX Horizontal blend weight, 0 (left) .. 1 (right).
 * @param fractionY Vertical blend weight, 0 (top) .. 1 (bottom).
 */
declare function interpolateNormal(corner00: Vec3$1, corner10: Vec3$1, corner01: Vec3$1, corner11: Vec3$1, fractionX: number, fractionY: number): Vec3$1;
/**
 * The smoothed surface normal at a continuous pixel position, bilinearly blended
 * from the four surrounding material texels' normals. `indexAt(x, y)` returns the
 * stored direction index for an integer pixel (implementations clamp to the
 * material's bounds); this decodes the four corners around `(sampleX, sampleY)`
 * to vectors and hands them to {@link interpolateNormal}. A region of uniform
 * index returns exactly that index's normal, so flat and unmapped surfaces are
 * untouched — only genuinely varying normals get de-banded.
 *
 * @param indexAt  Reads the stored normal index at an integer pixel.
 * @param sampleX  Continuous column (pixel centres at integer coordinates).
 * @param sampleY  Continuous row.
 */
declare function sampleNormalBilinear(indexAt: (x: number, y: number) => number, sampleX: number, sampleY: number): Vec3$1;
/**
 * A material ramp channel (height, specular, or roughness) bilinearly sampled at
 * a continuous pixel position, the scalar twin of {@link sampleNormalBilinear}.
 * `valueAt(x, y)` returns the stored 0..1 level at an integer texel (clamped by
 * the implementation); this blends the four texels around `(sampleX, sampleY)`.
 *
 * The ramp channels are 4-bit (16 levels), so a smooth gradient painted across a
 * surface reads back as visible steps. Blending them here — exactly as the normal
 * field is blended — dissolves that banding without touching the stored art. The
 * normal channel cannot use the GPU's linear filter (its bytes are an unordered
 * direction index), so the shaders keep the material texture NEAREST and blend
 * both the normals and these ramps by hand; this is the reference for the ramp
 * half of that, and the shaders must match it per channel.
 *
 * A uniform region returns its constant exactly, so flat materials are untouched.
 *
 * @param valueAt  Reads the stored 0..1 ramp value at an integer texel.
 * @param sampleX  Continuous column (texel centres at integer coordinates).
 * @param sampleY  Continuous row.
 */
declare function sampleScalarBilinear(valueAt: (x: number, y: number) => number, sampleX: number, sampleY: number): number;
/**
 * Shade an albedo colour by a surface normal and a direction toward the light:
 * Lambert diffuse lifted by an ambient floor, so a surface never drops below
 * `ambient` of its base colour. Each channel is clamped to 0..255.
 */
declare function shade(albedo: Rgb, normal: Vec3$1, toLight: Vec3$1, ambient: number): Rgb;

/**
 * Single-pass WebGL1 post-process renderer shared by the editor's FX tab and
 * the runtime player. Takes one frame — either raw RGBA bytes at native cart
 * resolution or a source canvas — as a nearest-filtered texture and draws it
 * through one fragment shader implementing the whole effect chain; per-effect
 * intensity arrives as uniforms (neutral when disabled), so the pipeline
 * compiles once. WebGL1 is used (not WebGPU) because this is a one-texture
 * full-screen quad — maximum compatibility, no async device setup.
 *
 * Effect order mirrors a physical signal path. The frame is folded and bowed
 * first (kaleidoscope, then CRT curvature), sampled through chromatic
 * aberration, and lit (bloom, god rays, streaks). The composed colour is then
 * graded and split-toned, quantised (dither feeding posterize), screened
 * (halftone), and finally passed through the things that sit in front of the
 * picture rather than in it: fog, vignette, grain, scanlines.
 *
 * Everything stays in one pass. That constraint is why the effects here are the
 * ones they are — a separable blur or a depth-aware effect would need a second
 * render target, and the whole point of the flat-uniform design is that there is
 * exactly one program, compiled once, whatever the artist switches on.
 */

/** A frame to post-process: raw RGBA bytes or a canvas to sample. */
type PostFxSource = Uint8Array | Uint8ClampedArray | TexImageSource;
declare class PostFxPass {
    private readonly gl;
    private readonly program;
    private readonly texture;
    private readonly quad;
    private readonly positionLocation;
    /** Null when render-to-texture is unavailable; the shader then falls back
     * to its inline 3x3 bloom rather than the multi-scale pyramid. */
    private readonly bloom;
    private readonly uniformLocations;
    private constructor();
    /** Returns null when WebGL is unavailable or the shaders fail to compile. */
    static create(canvas: HTMLCanvasElement): PostFxPass | null;
    private location;
    /**
     * Upload one frame and draw it through the effect chain.
     *
     * `time` (seconds) drives the only effect that moves, the grain. It is a
     * parameter rather than a clock read inside the pass so a still preview — the
     * editor's FX tab, a test — renders deterministically, and only a caller that
     * actually has a running frame loop supplies one.
     */
    render(source: PostFxSource, width: number, height: number, uniforms: PostFxUniforms, time?: number): void;
    dispose(): void;
}

/**
 * PostFxSurface — a display surface that draws every presented frame through
 * the post-process shader chain. It decorates the real surface (plain 2D or
 * the lighting surface): the inner surface renders into a detached, offscreen
 * container, and each `blit` re-samples its canvas GPU-side into the visible
 * FX canvas. Decorating (rather than merging into the lighting pipeline) keeps
 * lighting and FX orthogonal — any combination of the two just works.
 *
 * Construction can fail (no WebGL, no inner canvas); the factory returns null
 * and the caller mounts the inner surface directly, so enabling FX can never
 * stop a cart from playing.
 */

/** Builds the inner (decorated) surface into the given offscreen container. */
type InnerSurfaceFactory = (container: HTMLElement) => Promise<DisplaySurface> | DisplaySurface;
/** Where a 3D scene's sun is on screen (0..1, y down) and how much of it is unblocked (0..1). */
interface ScreenSun {
    readonly x: number;
    readonly y: number;
    readonly visible: number;
}
declare class PostFxSurface implements DisplaySurface {
    private readonly container;
    private readonly scaleMode;
    private readonly model;
    private readonly inner;
    private readonly innerCanvas;
    private readonly canvas;
    private readonly pass;
    private readonly resizeObserver;
    private uniforms;
    /** When this surface started, so animated effects get a monotonic clock. */
    private readonly startedAt;
    /** The sun a 3D scene reports this frame; the lens flare follows it. Null = use the source point. */
    private sun;
    private constructor();
    /**
     * Builds the FX surface, or returns null when post-processing cannot run
     * (the caller should then mount the inner surface directly). The inner
     * factory is only invoked once the FX pass itself is viable.
     */
    static create(container: HTMLElement, scaleMode: ScaleMode, model: ConsoleModel, settings: PostFxSettings, makeInner: InnerSurfaceFactory): Promise<PostFxSurface | null>;
    /** Swap the effect stack without rebuilding the pipeline. */
    setSettings(settings: PostFxSettings): void;
    /**
     * Follow a 3D scene's sun with the lens flare (HALO2_STYLE_ROADMAP.md, H8),
     * or null to go back to the effect's own source point.
     */
    setSun(sun: ScreenSun | null): void;
    blit(rgba: Uint8Array): void;
    destroy(): void;
    private applyScale;
}

/**
 * Sun glare and lens flare (HALO2_STYLE_ROADMAP.md, H8): the maths the
 * post-process shader's flare is a port of, DOM-free so it is unit-tested
 * headlessly — the pattern bloomModel.ts and lensModel.ts set.
 *
 * Two parts, both additive light keyed to one bright source on screen:
 *
 * - Glare: a soft glow round the source with a six-pointed starburst, the
 *   aperture's diffraction spikes — how a camera sees the sun.
 * - Ghosts: reflections between the lens elements, strung along the line from
 *   the source through the frame centre and out the other side, each a soft
 *   disc with its own tint.
 *
 * `visible` (0..1) scales the whole flare: the 3D scene reports how much of the
 * sun is unblocked, so a flare fades out as a tower slides across the sun
 * rather than shining through it. UVs have a top-left origin, as in the shader.
 */
/** One lens ghost: where it sits on the source→centre axis and how it looks. */
interface FlareGhost {
    /** Position along the axis: 1 = on the source, 0 = frame centre, negative = past it. */
    readonly along: number;
    /** Radius in screen-height units. */
    readonly radius: number;
    /** Tint, times its brightness. */
    readonly tint: readonly [number, number, number];
}
/** The ghosts, spread across the axis with cool Halo-era tints and one warm one. */
declare const FLARE_GHOSTS: readonly FlareGhost[];
/** Brightness of each ghost at ghost strength 1. */
declare const FLARE_GHOST_GAIN = 0.45;
/** Tightness of the starburst spikes: |cos 3θ|^power. */
declare const FLARE_SPIKE_POWER = 48;
interface FlareParams {
    /** Glare strength (0 = none). */
    readonly glare: number;
    /** Ghost strength (0 = none). */
    readonly ghosts: number;
    /** Glare radius in screen-height units. */
    readonly size: number;
    /** 0 (hidden) .. 1 (fully unblocked). */
    readonly visible: number;
}
/**
 * The flare's light at `uv` for a source at `origin` (both 0..1, y down), in
 * a frame `aspect` wide per unit high. The shader multiplies by the tint colour.
 */
declare function lensFlareAt(uv: readonly [number, number], origin: readonly [number, number], aspect: number, params: FlareParams): [number, number, number];

/**
 * A true multi-pass bloom: the wide, soft, energy-preserving glow the old
 * single-pass 3x3 tap could not produce (cinematic gap #4). The frame's bright
 * pixels are extracted through a soft knee, then blurred across a pyramid of
 * successively halved render targets using the dual-Kawase filter — a downsample
 * chain followed by an additive upsample chain — so light spreads across many
 * scales in a handful of cheap passes rather than one fixed-width kernel.
 *
 * The targets are half-float when the GPU can render and linearly filter them
 * (`OES_texture_half_float` + its linear and colour-buffer companions), which is
 * the other half of gap #4: bright light accumulates past 1.0 in the pyramid and
 * only comes back into range at the tonemap, so emissives keep their colour
 * instead of clipping to white. Where half-float is unavailable it falls back to
 * 8-bit targets — still a wide multi-scale blur, just clamped in range.
 *
 * The arithmetic (level count, soft-knee prefilter) lives in {@link bloomModel},
 * which has headless tests; the shaders here are a direct port of it. Creation
 * returns null on any GL failure so {@link PostFxPass} can fall back to its
 * inline bloom and a cart never stops playing.
 */
declare class BloomPyramid {
    private readonly gl;
    private readonly quad;
    private readonly prefilter;
    private readonly downsample;
    private readonly upsample;
    /** The pixel type of the render targets: half-float for HDR, else 8-bit. */
    private readonly textureType;
    private levels;
    private baseWidth;
    private baseHeight;
    private constructor();
    /** Whether the pyramid can hold light past 1.0 (true HDR) or clamps at it. */
    get isHdr(): boolean;
    /**
     * Build the pyramid against an existing GL context, or return null if any
     * shader/buffer allocation fails. The context is shared with the owning pass;
     * this class only ever renders into its own framebuffers and leaves the
     * default framebuffer bound when it is done.
     */
    static create(gl: WebGLRenderingContext): BloomPyramid | null;
    /**
     * Generate the bloom for one frame and return the finest pyramid level (a
     * half-resolution texture holding the accumulated glow), ready to be sampled
     * and added by the composite pass. Targets are reallocated only when the base
     * resolution changes, so steady-state playback allocates nothing.
     */
    generate(source: WebGLTexture, baseWidth: number, baseHeight: number, threshold: number, radius: number): WebGLTexture | null;
    dispose(): void;
    /** Bind a program and its target framebuffer, and point the shared quad at the
     * program's attribute — GLSL ES 1.00 has no VAOs, so this repeats per draw. */
    private begin;
    private allocate;
    private makeLevel;
    private freeLevels;
}

/**
 * The pure arithmetic behind the HDR bloom + tonemap stage, split out from the
 * WebGL plumbing so the algorithm can be validated headlessly (no GL context)
 * and so {@link BloomPyramid}'s shaders are a faithful port of code that has
 * tests rather than the other way round.
 *
 * Three pieces model gap #4's two halves — a real multi-scale bloom and an HDR
 * rolloff: how deep the blur pyramid goes for a given frame, the soft-knee
 * bright pass that seeds it, and the ACES filmic curve that maps the summed HDR
 * light back into the displayable 0..1 range. Every function here has an exact
 * GLSL twin in {@link BloomPyramid} and {@link PostFxPass}; keeping them in step
 * is the whole point of testing this layer.
 */
/** Below this many pixels a further halving has nothing left to blur. */
declare const MIN_PYRAMID_DIMENSION = 4;
/** The pyramid never grows past this many levels, whatever the resolution. */
declare const MAX_PYRAMID_LEVELS = 6;
/**
 * The soft-knee half-width of the bright pass, as a fraction of the 0..1 range.
 * A hard threshold makes bloom pop on and off as a pixel crosses it; the knee
 * fades contribution in across `threshold ± knee` so motion stays smooth.
 */
declare const BLOOM_KNEE = 0.5;
/**
 * How many downsample levels a frame of the given size supports: each level
 * halves both dimensions, stopping once the shorter side would fall below
 * {@link MIN_PYRAMID_DIMENSION} or {@link MAX_PYRAMID_LEVELS} is reached. Always
 * at least one, so a bloom is drawn even for a tiny frame.
 */
declare function pyramidLevelCount(width: number, height: number, maxLevels?: number): number;
/** The pixel size of pyramid level `index` (0 = half the base resolution). */
declare function pyramidLevelSize(baseWidth: number, baseHeight: number, index: number): {
    width: number;
    height: number;
};
/**
 * The soft-knee bright pass (Unity's bloom prefilter). Returns the input colour
 * scaled by how far its brightest channel sits above `threshold`: nothing below
 * `threshold - knee`, the full colour above `threshold + knee`, a quadratic ramp
 * between. Scaling the whole colour rather than each channel keeps the hue of a
 * bright pixel intact instead of tinting the glow toward whichever channel
 * crossed first.
 */
declare function softKneePrefilter(rgb: readonly [number, number, number], threshold: number, knee?: number): [number, number, number];
/**
 * The ACES filmic tonemap for one channel: an S-curve that is near-linear in the
 * shadows and rolls asymptotically toward 1 in the highlights, so summed HDR
 * light compresses into range instead of clipping flat to white. Narkowicz's
 * fitted approximation of the full ACES curve.
 */
declare function acesFilmicChannel(x: number): number;
/**
 * Apply the ACES rolloff to an RGB colour after an exposure multiply. The result
 * is always within 0..1, so however bright the pre-tonemap light was, nothing
 * clips — it rolls off instead.
 */
declare function acesFilmic(rgb: readonly [number, number, number], exposure?: number): [number, number, number];

/**
 * Pure lens-and-surface maths the single-pass post-process shader is a port of,
 * kept DOM-free so the same arithmetic the GLSL runs can be unit-tested headlessly
 * — the pattern {@link ./bloomModel.ts} established for bloom.
 *
 * Two screen-space effects for the cinematic 2.5D look share this file because
 * both key their behaviour off the vertical screen coordinate — the only "depth"
 * a flat frame has:
 *
 * - Tilt-shift depth of field: a horizontal band of the frame stays sharp and
 *   everything above/below it blurs, the miniature-diorama look REPLACED and THE
 *   LAST NIGHT lean on. Screen row stands in for distance.
 * - Screen-space reflection: the picture above a horizon line is mirrored down
 *   into the floor below it and faded with distance, the wet-street reflection
 *   those games use everywhere (and that Neon City hand-rolled per cart).
 *
 * The UV convention matches the shader: y = 0 is the top row, y = 1 the bottom.
 */
/** Feather distance (in screen-height units) over which DoF ramps to full blur. */
declare const TILT_SHIFT_FEATHER = 0.35;
/**
 * Blur weight, 0..1, for a pixel at screen row `y` given a tilt-shift focus band.
 *
 * Inside the band — within `range` of `focus` — the weight is 0 (perfectly
 * sharp). Outside it, the weight ramps up linearly over {@link TILT_SHIFT_FEATHER}
 * and saturates at 1, so the transition from focus to full blur is smooth rather
 * than a hard edge. The shader multiplies this by the effect strength to get the
 * sampling radius, so a returned 0 costs nothing and reads as untouched.
 *
 * @param y      Screen row, 0 (top) .. 1 (bottom).
 * @param focus  Centre of the in-focus band, 0..1.
 * @param range  Half-height of the fully-sharp band, in screen-height units.
 */
declare function tiltShiftBlur(y: number, focus: number, range: number): number;
/**
 * The source row to sample for a mirror reflection of `y` about `horizon`.
 *
 * A pixel `d` below the horizon reflects the pixel `d` above it, so the world
 * standing on the floor appears upside-down in it. Returned unclamped; the shader
 * clamps to the frame and the {@link reflectionFade} of an off-frame sample is
 * already near zero.
 */
declare function reflectionSampleY(y: number, horizon: number): number;
/**
 * Reflection opacity, 0..1, for a pixel at screen row `y`.
 *
 * Zero at and above the horizon (nothing reflects into the scene itself), then
 * fading linearly from full strength at the horizon to zero `falloff` below it —
 * a wet floor mirrors what is close to the waterline sharply and loses the far
 * scene, which is what sells it as a surface rather than a flip of the image.
 *
 * @param y        Screen row, 0 (top) .. 1 (bottom).
 * @param horizon  Row of the reflective surface's near edge, 0..1.
 * @param falloff  How far below the horizon the reflection persists, in screen-height units.
 */
declare function reflectionFade(y: number, horizon: number, falloff: number): number;

/**
 * Gap #3 part 2 — rendering a declared scene.
 *
 * Turns a {@link SceneSpec} (sceneModel.ts) into a composited parallax backdrop:
 * each layer's sprite-sheet region is read to RGBA through a {@link
 * SpriteRegionSource}, becomes a {@link ParallaxLayer}, and the whole set is
 * composited with parallax scroll + aerial-perspective atmosphere by
 * composeParallax. The camera is driven by the scene's auto-scroll plus an
 * optional cart-supplied offset (so gameplay can pan the world).
 *
 * Pure and DOM-free: the sprite source is a tiny interface the real engine (or a
 * test) satisfies, so this is unit-testable without a WASM core or a canvas.
 * Intended app home: packages/player/src/scene/.
 */

/** An RGBA image read out of the cart's sprite sheet. */
interface RegionImage {
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
}
/** Reads a rectangular tile region of the cart's sprite sheet as straight-alpha RGBA. */
interface SpriteRegionSource {
    readRegion(page: 0 | 1, tile: number, tilesW: number, tilesH: number): RegionImage;
}
/**
 * Resolve a scene's layers to renderable {@link ParallaxLayer}s by reading each
 * region's pixels once. Call this when the scene or the cart's art changes, not
 * every frame — the images are static; only the camera moves.
 */
declare function resolveSceneLayers(spec: SceneSpec, source: SpriteRegionSource): ParallaxLayer[];
/**
 * The camera for a given presented frame: the scene's constant auto-scroll plus
 * an optional cart-supplied base offset (e.g. the player's world position, which
 * a cart can publish for the backdrop to follow).
 */
declare function cameraAt(spec: SceneSpec, frame: number, base?: ParallaxCamera): ParallaxCamera;
/**
 * Fill `out` with a vertical sky gradient (dark zenith → the atmosphere's fog
 * colour at the horizon), so distant layers hazing toward fog meet a matching
 * sky. Convenience for the common case; a cart can paint its own sky instead.
 */
declare function fillSky(out: Uint8ClampedArray, width: number, height: number, atmosphere: AtmosphereParams, horizonY?: number): void;
/**
 * Render the full backdrop for one frame into `out`: sky, then the parallax
 * layers with atmosphere at the frame's camera. `layers` come from
 * {@link resolveSceneLayers} (resolved once and reused).
 */
declare function renderSceneBackdrop(out: Uint8ClampedArray, width: number, height: number, layers: readonly ParallaxLayer[], spec: SceneSpec, frame: number, base?: ParallaxCamera): void;

/**
 * Gap #3 part 3 — composite a cart's live frame over the parallax backdrop.
 *
 * A TIC-80 cart draws an opaque, full-screen framebuffer, so a backdrop can only
 * show if the cart LEAVES it room: the runtime treats every pixel the cart drew
 * in its background "key" colour as transparent and shows the backdrop there,
 * keeping the rest as the cart's foreground. This is chroma-keying on the cart's
 * own palette background (index 0 by convention; configurable via the scene's
 * keyColor) — the standard, zero-cost way to layer a backdrop behind sprite art.
 *
 * It runs on the RAW cart frame, before lighting + post-FX, so the composited
 * image (backdrop + foreground) is what those later passes finish together.
 *
 * Pure and DOM-free (RGBA in / RGBA out). Intended app home:
 * packages/player/src/scene/.
 */

/**
 * Composite `cartFrame` over `backdrop`: where the cart pixel matches `keyRgb`
 * (its background colour, resolved from the cart palette), show the backdrop;
 * everywhere else keep the cart's own pixel.
 *
 * @param cartFrame The cart's raw RGBA framebuffer (width*height*4).
 * @param backdrop  The rendered scene backdrop, same dimensions.
 * @param width     Framebuffer width.
 * @param height    Framebuffer height.
 * @param keyRgb    The background colour to key out (the cart palette's keyColor).
 * @param tolerance Per-channel match tolerance (0 = exact). Default 0.
 * @param out       Optional target buffer; defaults to a fresh one.
 * @returns The composited RGBA (the same array as `out` when supplied).
 */
declare function compositeOverBackdrop(cartFrame: Uint8ClampedArray, backdrop: Uint8ClampedArray, width: number, height: number, keyRgb: Rgb$1, tolerance?: number, out?: Uint8ClampedArray): Uint8ClampedArray;

/**
 * A {@link SpriteRegionSource} that reads a loaded cart's sprite sheet at runtime.
 *
 * The scene backdrop's layers reference regions of the cart's OWN sprite art; to
 * render them the player reads those tiles out of a cart object created from the
 * same .tic bytes (the `cbx_cart_*` authoring API the engine exposes), resolves
 * each pixel through the cart palette, and returns straight-alpha RGBA — palette
 * index 0 (the sheet's transparent colour) becomes a hole so sky shows through.
 *
 * Bit depth is derived from the model's palette size (Classic packs 4bpp, Pro and
 * the rest are 8bpp), mirroring the editor's tile codec, so no engine change is
 * needed. Pure apart from the WASM reads; the module handle is loosely typed
 * because the engine glue is (matching engine.ts).
 */

/** A region source plus the cart palette lookup + teardown the player needs. */
interface CartSpriteSource {
    source: SpriteRegionSource;
    /** The RGB of a cart palette index (e.g. the scene's background keyColor). */
    paletteRgb(index: number): Rgb$1;
    /** Free the cart object. */
    dispose(): void;
}
type EngineModule = any;
/**
 * Build a region source over a cart's bytes. Returns the source plus a `dispose`
 * that frees the cart object; call it when the player tears down. Returns null if
 * the engine lacks the cart API or the cart fails to load, so the caller can skip
 * the backdrop rather than crash.
 */
declare function createCartSpriteSource(module: EngineModule, bytes: Uint8Array, paletteSize: number): CartSpriteSource | null;

/**
 * SceneBackdropSurface — a display surface that draws a parallax scene backdrop
 * behind the cart's live frame, then presents the result through an inner surface.
 *
 * It decorates any {@link DisplaySurface} (plain 2D, lit, or the FX chain's base):
 * each frame it renders the declared backdrop (parallax layers + aerial-perspective
 * atmosphere) at the scene camera, chroma-keys the cart's own frame over it (the
 * cart's background colour shows the backdrop, its foreground is kept), and blits
 * the composite to the inner surface. Because it runs on the RAW frame before the
 * inner surface, any lighting / post-FX the inner surface applies finishes the
 * backdrop and foreground together.
 *
 * The layers are resolved once (their pixels are static); only the camera advances
 * per frame, so per-frame cost is one composite pass.
 */

/**
 * Per-frame animation overrides for one layer, addressed by its index in the
 * declared scene. Offsets ADD to the layer's authored placement (sway around a
 * base); opacity/emissive are absolute. Deliberately structural — the scene does
 * not depend on the anim module — and deliberately pixel-free, so the pre-hazed
 * layer cache stays valid (sprite-frame swaps, which would invalidate it, are the
 * foreground surface's job, not a scene layer's).
 */
interface SceneLayerOverride {
    opacity?: number;
    offsetX?: number;
    offsetY?: number;
    emissive?: number;
}
declare class SceneBackdropSurface implements DisplaySurface {
    private readonly inner;
    private readonly width;
    private readonly height;
    private readonly spec;
    private readonly keyRgb;
    private frame;
    /** The cart-published camera base, added to the scene's auto-scroll each frame. */
    private cameraBase;
    /** Per-layer animation overrides for this frame, keyed by layer index (or null). */
    private layerOverrides;
    /** Layers with aerial haze baked in once (see prehazeLayers) — the per-frame win. */
    private readonly hazedLayers;
    /** The sky gradient, computed once (it depends only on the constant atmosphere). */
    private readonly sky;
    private readonly backdrop;
    private readonly composited;
    private readonly presented;
    constructor(inner: DisplaySurface, width: number, height: number, layers: readonly ParallaxLayer[], spec: SceneSpec, keyRgb: Rgb$1);
    /**
     * Set the backdrop camera the cart published this frame (via `cartbox.camera`).
     * Added to the scene's own auto-scroll, so an auto-scroll-only cart that never
     * sets it keeps panning as before with the default (0, 0).
     */
    setCameraBase(base: ParallaxCamera): void;
    /**
     * Set this frame's per-layer animation overrides (or null for none). Applied on
     * top of the pre-hazed layers without touching their baked pixels, so the
     * frame-invariant haze cache is preserved.
     */
    setLayerOverrides(overrides: Record<number, SceneLayerOverride> | null): void;
    /** The layers to composite this frame: the cached ones, plus any overrides. */
    private frameLayers;
    blit(rgba: Uint8Array): void;
    destroy(): void;
}

/**
 * Cinematic gap #1 (animation timeline) — pure, deterministic playback.
 *
 * The host feeds the frame clock (the same counter scene auto-scroll uses) and
 * gets back the resolved animation state for that tick: which sprite frame each
 * clip is on, each track's sampled value routed to its target, and each foreground
 * placement's current transform. No engine, no DOM, no time — same tick in, same
 * state out — so the wiring half (Phase B) and the editor preview can share it and
 * it is fully unit-testable.
 *
 * Combine semantics (how a sampled value meets the thing it drives) are the
 * wiring's job, not this module's: `evaluate` returns absolute sampled numbers.
 */

/** The frame a clip shows at a given tick. */
interface ClipSample {
    region: SpriteRegion;
    /** Index into the clip's original `frames` array. */
    frameIndex: number;
}
/** A foreground placement resolved for one tick. */
interface ResolvedPlacement {
    region: SpriteRegion;
    frameIndex: number;
    x: number;
    y: number;
    opacity: number;
    scale: number;
    depth: number;
}
/** Everything animated at one tick. */
interface AnimState {
    /** Scene-layer channel overrides, keyed by layer index. */
    layers: Record<number, Partial<Record<LayerChannel, number>>>;
    /** Post-FX value overrides, keyed by effect value key (e.g. "bloom.strength"). */
    postfx: Record<string, number>;
    placements: ResolvedPlacement[];
}
/**
 * Which frame a clip shows at `frame` ticks, honoring per-frame durations and the
 * clip's repeat mode. `once` clamps at the last frame; loop/pingpong wrap.
 * Assumes a non-empty clip with durations aligned to frames (parseAnim guarantees).
 */
declare function sampleClipFrame(clip: AnimClip, frame: number): ClipSample;
/**
 * A track's value at `frame`, folded into its key range by mode. `hold` clamps to
 * the end values; `loop` wraps over `loopLength` (defaulting to the key span);
 * `pingpong` reflects over the key span into a triangle wave.
 */
declare function sampleTrack(track: AnimTrack, frame: number): number;
/**
 * Resolve the whole animation set at one tick. Tracks are routed to their targets
 * (scene layer / post-fx / placement channel); placements resolve their clip's
 * current frame and apply any placement-channel track overrides over their base
 * transform. Placements whose clip is missing are skipped (parseAnim already drops
 * unknown-clip placements; this is belt-and-braces).
 */
declare function evaluate(spec: AnimSpec, frame: number): AnimState;

/**
 * Cinematic gap #1 (animation timeline) — procedural track generators.
 *
 * The artist-friendly path: instead of hand-placing dozens of keyframes for a
 * neon buzz or a drifting cloud, call a generator and get a ready `keys`/`mode`
 * shape to drop onto a target. Output is plain keyframes (not a hidden analytic
 * evaluator) so the sidecar stays self-describing and the editor can show and tweak
 * the generated curve — Phase-A pragmatism over the spec's analytic option, which
 * can come later if periodic-noise JSON size ever bites.
 *
 * All generators are deterministic (flicker is seeded), so preview == reload.
 */

/** A generated track shape: merge with a target to form an AnimTrack. */
interface GeneratedTrack {
    keys: Keyframe[];
    mode: TrackMode;
    loopLength?: number;
}
/**
 * A breathing glow: smoothly rises from `min` to `max` and back over `period`
 * ticks. Pingpong makes the return automatic, so two keys suffice.
 */
declare function pulse(period: number, min: number, max: number): GeneratedTrack;
/**
 * A sinusoid-like sway of `±amplitude` around `center` over `period` ticks — for
 * idle bob, gentle offset drift on a foreground element, or a swaying sign.
 */
declare function sway(period: number, amplitude: number, center?: number): GeneratedTrack;
/**
 * Linear travel from 0 to `distance` over `period` ticks, then a seamless jump
 * back to 0 — for drifting fog/clouds on a wrapX scene layer (the wrap hides the
 * reset). Bind to a layer's offsetX/offsetY.
 */
declare function drift(period: number, distance: number): GeneratedTrack;
/**
 * Erratic buzz between `min` and `max` — for neon flicker or a failing lamp.
 * `steps` random hard-switch levels are spread over `period` ticks and loop; the
 * same `seed` always yields the same pattern. Bind to a layer's emissive/opacity.
 */
declare function flicker(period: number, min: number, max: number, steps?: number, seed?: number): GeneratedTrack;

/**
 * AnimatedForegroundSurface — a display surface that draws animated placements
 * (foreground set-dressing) over the presented frame, then hands off to an inner
 * surface.
 *
 * Each placement is one frame of an AnimClip drawn from the cart's OWN sprite
 * sheet (via a {@link SpriteRegionSource}) at a position, scale, and opacity the
 * animation resolved for this tick (see animPlayer's `evaluate`). It decorates any
 * {@link DisplaySurface} and sits INSIDE the scene backdrop but OUTSIDE lighting/
 * post-FX: placements land in front of the cart + parallax backdrop, and the
 * inner surface's lighting/FX finish them together with the rest of the frame.
 *
 * Region pixels are static for the cart's life, so they are read once and cached;
 * per-frame cost is a frame copy plus the composited placement footprints (nothing
 * when there are no placements — the pass-through fast path).
 */

declare class AnimatedForegroundSurface implements DisplaySurface {
    private readonly inner;
    private readonly width;
    private readonly height;
    private readonly source;
    private placements;
    /** Static region pixels cached by region key (page:tile:tilesW:tilesH). */
    private readonly regionCache;
    private readonly output;
    private readonly presented;
    constructor(inner: DisplaySurface, width: number, height: number, source: SpriteRegionSource);
    /** Set the placements resolved for this frame (empty for none). */
    setPlacements(placements: readonly ResolvedPlacement[]): void;
    private region;
    blit(rgba: Uint8Array): void;
    /** Nearest-neighbour scale + straight-alpha composite of one placement. */
    private drawPlacement;
    destroy(): void;
}

/**
 * The cart-facing animation-clip accessor, as injectable Lua (upgrade #4).
 *
 * The Anim tab already lets a creator author named sprite-frame clips (an ordered
 * set of sprite-sheet regions with per-frame durations and a loop/pingpong/once
 * mode). Until now those clips only drove host-played set-dressing; a gameplay
 * entity that wanted to animate had to swap sprite ids by hand in Lua. This
 * exposes the SAME authored clips to the cart's own code as
 * `cartbox.clip(name, tick) -> id, w, h`, so a cart draws the current frame with
 * `spr(id, x, y, key, 1, flip, 0, w, h)` and never re-derives the timing.
 *
 * Like the collision/flags accessors this is host data the cart *reads* and it
 * never changes during play, so the whole clip table is injected once as Lua data
 * (after the base SDK, so `cartbox` already exists). Pingpong is baked into a
 * forward+reverse loop sequence here so the Lua only needs loop/once logic, and
 * every value feeding an integer op is floored (the Pro core's Lua throws on a
 * bitwise/`%` of a float — see the lua-bitwise-float-trap note).
 *
 * Pure and import-free apart from the AnimSpec types, so it is unit-testable on
 * its own inputs and outputs.
 */

/** The encoded playback table for one clip — the exact data the Lua drives from. */
interface ClipTableEntry {
    readonly name: string;
    /** Total cycle length in ticks. */
    readonly total: number;
    /** Once clips clamp to the last frame past the end; loops wrap. */
    readonly once: boolean;
    /** Sprite id per (flattened) frame. */
    readonly tile: readonly number[];
    readonly w: readonly number[];
    readonly h: readonly number[];
    /** Cumulative end-tick of each frame (cum[i-1] <= t < cum[i] selects frame i). */
    readonly cum: readonly number[];
}
/**
 * Build the per-clip playback tables from an AnimSpec — the pure step the Lua
 * generator and the tests share. Pingpong is flattened to a forward+reverse loop
 * sequence here, so the frame table is the single source of truth for timing.
 */
declare function buildClipTable(anim: AnimSpec | null | undefined): ClipTableEntry[];
/**
 * The frame index (1-based, as the Lua uses) an entry shows at `tick` — the exact
 * selection the emitted Lua implements. Exposed so the timing contract is tested
 * against real inputs without executing Lua (mirroring the collision SDK tests).
 */
declare function clipFrameIndex(entry: ClipTableEntry, tick: number): number;
/**
 * Build the Lua that exposes a cart's authored clips as
 * `cartbox.clip(name, tick)`. Returns an empty string when there are no usable
 * clips, so the caller injects nothing.
 *
 * `cartbox.clip(name, tick)` returns the current frame's top-left sprite id and
 * its width/height in tiles; an unknown clip returns `0, 1, 1`. `tick` is the
 * cart's own frame counter (durations are authored in ticks at 60Hz).
 */
declare function animClipsSdkLua(anim: AnimSpec | null | undefined): string;

/**
 * The deterministic particle field — cinematic gap #6. Turns one
 * {@link ParticleEmitter} into the set of particles visible at a given frame,
 * with zero retained state: a particle's whole trajectory is a closed-form
 * function of its index and the frame counter, so the same frame always yields
 * the same field (matching the editor preview to playback and to a replay) and
 * there is nothing to advance or reset. This is the classic stateless
 * screen-wrapping particle field, and being pure it can be unit-tested headlessly
 * the way the scene and anim models are.
 *
 * The per-kind character lives here, not in the sidecar: rain streaks and slants,
 * snow drifts and sways, embers rise and flicker and fade as they climb, fog
 * crawls sideways in large soft blobs. An emitter only supplies the handful of
 * knobs those share (count/colour/opacity/size/speed/wind).
 */

/** One drawable particle at a moment in time. */
interface Particle {
    /** Column in framebuffer pixels. */
    x: number;
    /** Row in framebuffer pixels. */
    y: number;
    /** Footprint size in pixels. */
    size: number;
    /** Composite alpha, 0..1. */
    alpha: number;
    /** Colour, each channel 0..255. */
    color: readonly [number, number, number];
    /** Vertical streak length in pixels (rain); 0 draws a dot. */
    streak: number;
}
/**
 * The particles an emitter shows at `frame`, wrapped into a `width`×`height` field.
 *
 * Every particle is placed from its hashed spawn point and advanced by the frame
 * clock along its kind's motion; screen-wrapping keeps the field full forever
 * without spawning or retiring anything. Positions are always inside the field.
 */
declare function simulateEmitter(emitter: ParticleEmitter, frame: number, width: number, height: number): Particle[];

/**
 * ParticleOverlaySurface — a display surface that composites a declared weather
 * system (rain/snow/embers/fog) over each presented frame, then hands off to an
 * inner surface. Cinematic gap #6.
 *
 * It decorates any {@link DisplaySurface} and is placed as the INNERMOST decorator
 * (wrapping the base terminal surface, inside the animated foreground and scene
 * backdrop): the weather is drawn last into the framebuffer, so it lands in front
 * of the cart, its parallax backdrop, and any foreground set-dressing — and when a
 * post-FX stack is active it wraps the whole base, so the weather is graded and
 * bloomed with the scene rather than pasted on flat.
 *
 * The field is stateless ({@link simulateEmitter}): each blit advances a frame
 * counter — kept in lockstep with the run loop, one tick per present — and redraws
 * the particles that frame implies, with no simulation to retain. A spec with no
 * emitters is a straight pass-through.
 */

declare class ParticleOverlaySurface implements DisplaySurface {
    private readonly inner;
    private readonly width;
    private readonly height;
    private readonly spec;
    private frame;
    private readonly output;
    private readonly presented;
    constructor(inner: DisplaySurface, width: number, height: number, spec: ParticleSpec);
    blit(rgba: Uint8Array): void;
    destroy(): void;
    /** Straight-alpha composite one particle: a vertical streak, or a square dot. */
    private draw;
    /** Alpha-blend a particle's colour onto one framebuffer pixel (bounds-checked). */
    private blend;
}

/**
 * MeshOverlaySurface — a display surface that rasterises a cart's declared 3D
 * mesh scene over each presented frame, then hands off to an inner surface. This
 * is Phase 2 of the mesh asset feature: the runtime has no GPU triangle path, so
 * the same pure software rasteriser the editor previews with (`renderMeshScene`
 * in `@cartbox/editor`) draws the meshes straight into the framebuffer here.
 *
 * It decorates any {@link DisplaySurface}, compositing the meshes *over* the cart
 * frame with a shared depth buffer so the instances occlude each other correctly.
 * Because it is a decorator, its output flows through the lighting and post-FX
 * stack that wrap the base surface — the meshes are graded and bloomed with the
 * rest of the scene rather than pasted on flat.
 *
 * The scene auto-orbits at a gentle rate by default, so a declared mesh is
 * visibly rendered even with no cart code. A cart can take over the camera each
 * frame via `cartbox.meshcam(...)`: the player decodes that from the mailbox and
 * feeds it to {@link setCameraOverride}, which wins for that frame; clearing the
 * override drops back to the auto-orbit.
 *
 * Textures are decoded once, asynchronously, at construction (the browser owns
 * image decoding), which is why the surface is built through a static async
 * `create`, mirroring `LitCanvasSurface.create`.
 */

/** Options for {@link MeshOverlaySurface.create}. */
interface MeshOverlayOptions {
    /**
     * Let a software-rendered first-person view drop its 3D resolution to keep
     * the frame rate up (default true). Off renders every frame at full size.
     */
    readonly adaptiveResolution?: boolean;
    /**
     * Loads a decoder for KTX2 (Basis Universal) textures, which browsers can't
     * decode natively. Called only when the scene has one; without it such
     * textures render as their flat base colour.
     */
    readonly ktx2?: Ktx2DecoderLoader;
}
/** Loads a KTX2 → RGBA decoder (see {@link MeshOverlayOptions.ktx2}). */
type Ktx2DecoderLoader = () => Promise<(bytes: Uint8Array) => DecodedTexture | null>;
declare class MeshOverlaySurface implements DisplaySurface {
    private readonly inner;
    private readonly width;
    private readonly height;
    private scene;
    /** The authored instances (baked placement); per-frame poses compose on top. */
    private readonly instances;
    /** Each instance's animation frames (textured), or null when it has none. */
    private readonly frames;
    /**
     * What actually draws the triangles. Owned by whoever passed it — a renderer
     * is typically shared with the world overlay, so destroying this surface must
     * not dispose it. The default software renderer holds no resources.
     */
    private readonly renderer;
    /** The baked sky-dome panorama drawn behind a first-person view, or null. */
    private skyMap;
    /** The environment the PBR shading samples (with the dome as its map), or null. */
    private environment;
    private readonly options;
    private frame;
    private cartCamera;
    private poses;
    private readonly output;
    private readonly presented;
    private readonly depth;
    /** The sun's shadow maps (see buildShadow): the whole scene, and the near cascade round the camera (EP8b). */
    private farShadow;
    private nearShadow;
    /** Each casting spot/point light's cached still tiles and this frame's copies (EP8c), in tile order. */
    private localShadowCache;
    /** Instances ever posed on the front layer (a held weapon): never part of the static shadow. */
    private readonly everFront;
    /** Each mesh's local bounding box, for projecting shadow footprints. */
    private readonly meshBounds;
    /** Software-path resolution governor (see SOFTWARE_SCALES): current step and smoothed frame ms. */
    private scaleStep;
    private frameMs;
    private framesAtStep;
    private low;
    /** The last sky backdrop and the view it was painted for (it depends only on
     *  where the camera points, so walking without turning reuses it). */
    private skyCache;
    /**
     * Told each frame where the sky dome's sun is on screen and how much of it is
     * unblocked, for the post-FX glare and lens flare (H8); null without a sky dome.
     */
    onSun: ((sun: ScreenSun | null) => void) | null;
    /** The sun's eased visibility and last place on screen (0..1). */
    private sunSeen;
    private sunAt;
    /** Reused buffers for the sun-shaft pass. */
    private shaftScratch;
    /** The cart's world lights this frame (cartbox.light3d), added to the rig's in first person. */
    private cartLights;
    /** Tinted mesh copies, per source mesh and tint index. */
    private readonly tintCache;
    /** Draws the front layer (a held weapon) over the finished scene. */
    private readonly frontRenderer;
    /** First-person mode: draw the meshes first, then the cart's 2D frame as a HUD on top. */
    private hud;
    /**
     * The scene-object hierarchy: each instance's parent index (-1 for a root), its
     * children, and its authored local transform. Null when no instance has a parent,
     * which keeps the flat scene on its original code path.
     */
    private readonly hierarchy;
    /** The same shape for a flat scene, built on first use when physics bodies move it. */
    private flat;
    /** World matrices of the objects physics moved this frame (see setBodyOverrides). */
    private bodies;
    /** Shield effects (H11): object index → the surface effect it and everything under it wear (see setShields). */
    private effects;
    private readonly shieldCache;
    /** Spawned prefab copies: root object index → the root's world matrix (see setSpawned). */
    private spawned;
    /** Graphics quality (see quality.ts): shadows on/off and their map size, the first-person scale cap. */
    private quality;
    /** Skinned instances' live meshes (their buffers are rewritten for each pose). */
    private readonly live;
    /** The skinning matrices each live mesh was last posed with (skip re-skinning the same pose). */
    private readonly lastSkin;
    /** Instances animated this frame: they move for the shadow cache. */
    private animated;
    /** Each object's reserve-copy root (-1 when it isn't part of a prefab reserve). */
    private readonly pooledRoot;
    /** The authored instances without the reserve copies (drawn when nothing moves). */
    private unpooled;
    /** Objects in a level that isn't the current one: not drawn, not in the static shadow (see setInactive). */
    private inactive;
    private inactiveKey;
    /** Each object's world matrix as last drawn (null = hidden), or null when nothing moved. */
    private lastPlacement;
    /** Copy of the cart frame kept as the HUD layer while the 3D renders into `output`. */
    private hudFrame;
    /** The playtest profiler, when it's on: shadow, sky and scene time go to it. */
    private profiler;
    private constructor();
    /**
     * Set the world matrices of the objects physics moves (object index → matrix),
     * replacing their authored placement; their children follow, and a cart pose
     * still composes on top. The player calls this each frame from the physics session.
     */
    setBodyOverrides(bodies: ReadonlyMap<number, Mat4>): void;
    /**
     * Set the prefab copies the cart has spawned (root object index → world matrix).
     * Reserve copies not in the map stay hidden; a spawned copy's children follow
     * its root, and its physics bodies (if any) take over from there.
     */
    setSpawned(spawned: ReadonlyMap<number, Mat4>): void;
    /**
     * Set the shield effects the cart has standing (cartbox.shield: object →
     * flare, shimmer, camo). Each is drawn on the object and everything under it,
     * as a surface effect over its PBR materials (see shieldEffect).
     */
    setShields(shields: ReadonlyMap<number, {
        readonly flare: number;
        readonly shimmer: number;
        readonly camo: number;
    }>): void;
    /**
     * Pose the skinned objects (object index → skinning matrices, see
     * AnimationSession). Each listed object's live mesh is re-skinned when its
     * matrices changed, and it counts as moving this frame for the shadow cache.
     */
    setSkinning(skinning: ReadonlyMap<number, Float32Array>): void;
    /**
     * Apply an editor's edits to the running scene (ENGINE_PARITY_ROADMAP.md EP5):
     * objects' placements, their meshes and materials, and the lighting rig, shown
     * from the next frame without restarting the cart. `next` must be the same
     * scene structure — the same objects, parents and prefab reserves in the same
     * order — or nothing changes and this answers false (the editor then says the
     * change applies on the next run). Physics bodies keep simulating where they are.
     */
    applySceneEdits(next: MeshScene): Promise<boolean>;
    /** Apply a graphics quality preset (takes effect on the next frame). */
    setQuality(quality: QualitySettings): void;
    /**
     * The objects of levels that aren't loaded (see levels.ts in @cartbox/editor):
     * they're hidden, and left out of the shadow, until the set changes again.
     */
    setInactive(objects: ReadonlySet<number>): void;
    /** Posed instances plus, in a hierarchy, everything below them: what moves this frame. */
    private withChildren;
    /**
     * Decode every instance's base-colour textures, then build the surface. Any
     * texture that fails to decode falls back to null (flat base colour), so a
     * bad image never blocks the cart — the mesh still renders, just untextured.
     */
    static create(inner: DisplaySurface, width: number, height: number, scene: MeshScene, renderer?: SceneRenderer, options?: MeshOverlayOptions): Promise<MeshOverlaySurface>;
    /** Decodes a KTX2 texture (loading the decoder on first use); set by create. */
    private decodeKtx2;
    /**
     * Swap streamed textures in (see sceneStreaming.ts in @cartbox/editor): every
     * texture placeholder whose `ref` is in `images` is decoded and takes the
     * place of the flat colour it stood in for, from the next frame. Returns how
     * many objects changed.
     */
    supplyImages(images: ReadonlyMap<string, EncodedImage>): Promise<number>;
    /**
     * Set the cart-driven camera for the next frame(s), or null to auto-orbit. The
     * player calls this each frame from the decoded mesh-camera mailbox, so a cart
     * that stops publishing (null) smoothly hands the camera back to the auto-orbit.
     */
    setCameraOverride(camera: MailboxMeshCamera | null): void;
    /**
     * First-person mode: when true, the cart's 2D frame is composited as a HUD over
     * the 3D scene instead of the meshes being drawn over the 2D. The player sets it
     * each frame from the decoded mesh-camera HUD flag.
     */
    setHudMode(on: boolean): void;
    /**
     * Set the per-instance poses a cart published this frame (empty to leave every
     * instance at its authored transform). The player calls this each frame from the
     * decoded mesh-pose mailbox; a pose composes on top of the instance's authored
     * placement, and a hidden pose drops the instance from the frame.
     */
    setPoseOverrides(poses: readonly MailboxMeshPose[]): void;
    /**
     * Where a top-level object has been moved to this frame — by its physics
     * body, by being spawned, or by the cart posing it — whether or not it's
     * drawn; null when it's where it was placed (or its pose hides it).
     * Spatial loading measures a moving object here rather than where it began.
     */
    movedModel(i: number): Mat4 | null;
    /**
     * The world-space point lights the cart published this frame (`cartbox.light3d`
     * — an objective's glow, a muzzle flash). They light a first-person view on
     * top of the authored rig's lights.
     */
    setCartLights(lights: readonly WorldLight[]): void;
    /** Report per-pass times to `profiler` (null: stop). */
    setProfiler(profiler: Profiler | null): void;
    /** What the renderer drew last frame. */
    renderStats(): RenderStats | null;
    /** Bytes the scene keeps for drawing (geometry, textures, targets), estimated. */
    sceneBytes(): number;
    blit(rgba: Uint8Array): void;
    /** Report the sun to {@link onSun}: its place on screen and its eased visibility. */
    private reportSun;
    /** Paint the sky backdrop, or copy it from last frame when the view direction hasn't changed. */
    private paintSky;
    /** The 3D render scale this frame: 1, unless the software governor has stepped down. */
    private renderScale;
    /** Whether the resolution governor applies: a large first-person view on the CPU rasteriser. */
    private governed;
    /** Step the software render scale by how long frames are taking. */
    private pace;
    /** Scratch buffers for a reduced-size render. */
    private lowTarget;
    /**
     * The instances to draw this frame. With no poses, the authored set (the fast,
     * allocation-free path). Otherwise each authored instance with any matching
     * pose composed on top — a hidden pose drops it; a pose's `frame` swaps in one
     * of its animation frames, `tint` recolours its tintable materials, and `front`
     * moves it to the front layer. A pose's transform is applied in the instance's
     * LOCAL space (authored · pose), so a cart moves an object relative to where
     * the editor placed it. `moved` lists the posed main-layer instances — the
     * only part of the shadow map that has to be redrawn each frame.
     */
    private posedInstances;
    /**
     * {@link posedInstances} for a scene with parents. A child follows its parent:
     * its world matrix is the parent's (posed) world matrix times its own local
     * transform, then its own pose. Hiding a parent hides its children and putting
     * it on the front layer brings them along; anything under a posed object counts
     * as moved for the shadow cache. Unposed objects under unposed parents keep
     * their baked world matrix.
     */
    private posedHierarchy;
    /**
     * Each object's world matrix as last drawn, null where it was hidden (live
     * inspection). Before anything has moved, the authored placement.
     */
    /**
     * Each object's world matrix for the poses, bodies and spawns set so far this
     * frame (null = hidden), worked out now rather than read from the last draw —
     * what inverse kinematics aims with before the frame is skinned.
     */
    currentPlacements(): readonly (Mat4 | null)[];
    placements(): readonly (Mat4 | null)[];
    /** A tinted instance's mesh and LOD levels (each level tinted alike). */
    private tintedLook;
    /** A tinted copy of `mesh`, cached so its identity (and any GPU upload) is stable. */
    private tinted;
    /** The camera's eye this frame (terrain blocks pick their detail by distance from it). */
    private eye;
    /** Where the camera was last drawn from (null before the first frame). */
    eyePosition(): readonly [number, number, number] | null;
    /** Each terrain block's world bounds, measured on first use. */
    private readonly blockBounds;
    /**
     * A terrain block at the detail its distance from the eye calls for: full
     * within its `detail` range, half out to twice that, quarter beyond. Anything
     * else is returned as it is.
     */
    private atDetail;
    /** The engine's gentle auto-orbit round the scene, kept above any terrain. */
    private autoOrbitCamera;
    /**
     * Render the scene's directional shadow map for this frame, or null when the
     * rig has shadows off / no directional light.
     *
     * Everything the cart did not pose this frame is static, so its depth is
     * rendered once and cached; each frame copies that cache and rasterises only
     * the posed (`moved`) instances over it. The cache is rebuilt when the set of
     * posed instances changes. For an arena whose map never moves, this turns a
     * full-scene shadow pass per frame into a memcpy plus a few characters.
     */
    private buildShadow;
    /**
     * What the static shadow maps depend on: *which* instances are posed (not
     * whether a posed one is hidden this frame — a character dying must not
     * re-render the whole arena's shadow); a held weapon never casts, so
     * anything ever posed in front is out too.
     */
    private staticShadowKey;
    /** Everything that casts and never moves: what the static shadow maps hold. */
    private stillCasters;
    /**
     * Shadows from the spot and point lights that cast (EP8c): each light's
     * tiles of everything still, cached until the light or the still set
     * changes, copied each frame with the movers drawn over them. Returns the
     * lights with their tiles assigned, or null when none casts.
     */
    private buildLocalShadows;
    /**
     * One shadow map for this frame: the layer's cached static depth (redrawn
     * when `key` or the rig changes), copied, with this frame's movers drawn over
     * it — and the texels that changed since last frame, for a GPU's partial upload.
     */
    private renderShadowLayer;
    /**
     * The shadow-map texels an instance can cover: its bounding box through the
     * light's (orthographic) projection, padded for filtering and rounding.
     */
    private shadowFootprint;
    destroy(): void;
    private destroyed;
    /** The scene's 3D particle effects in flight, or null when it defines none. */
    private particles;
    /** The scene's decals on its surfaces, or null when it defines none. */
    private decals;
    /** Debris in flight and at rest (H10), what it lands on, and each source mesh with its textures. */
    private debris;
    private debrisBoxes;
    private readonly debrisLooks;
    /** Throw a copy of debris `debris` (see cartbox.debris). */
    throwDebris(debris: number, at: readonly [number, number, number], velocity: readonly [number, number, number], scale: number): void;
    /** Lay decal `decal` on a surface (see cartbox.decal). */
    decal(decal: number, at: readonly [number, number, number], normal: readonly [number, number, number], scale: number): void;
    /** Fire particle effect `effect` (see cartbox.burst). */
    burst(effect: number, at: readonly [number, number, number], dir: readonly [number, number, number], scale: number): void;
    /** Settles once the scene's reflection probes are baked and in use (tests await it). */
    probesReady: Promise<void>;
}

/**
 * Scene objects for the cart's Lua (ENGINE_ROADMAP.md, Phase 1): the authored
 * names, parents, tags and properties of the cart's placed meshes, injected as a
 * table behind `cartbox.find` / `cartbox.prop` / `cartbox.tagged` and friends, so
 * code finds an object by name instead of hard-coding its slot number.
 *
 * Objects are identified by the same 0-based index `cartbox.meshpose` takes (the
 * instance's position in the runtime scene), so `cartbox.meshpose(cartbox.find("door"), ...)`
 * moves the door. The SDK ships no-op defaults for every call (see sdk.ts), so a
 * cart without meshes can call them safely; this overrides them when it has some.
 */

/**
 * The Lua that defines the scene-object calls for `scene`, or "" when there is no
 * scene (the SDK's defaults then stand).
 */
declare function sceneObjectsSdkLua(scene: MeshScene | null | undefined): string;

/**
 * WorldOverlaySurface — draws a cart's declared HD-2D {@link WorldScene} over the
 * frame: a height-mapped 3D terrain with the cart's 2D character sprites standing
 * in it as camera-facing billboards, all sharing one depth buffer so terrain and
 * characters occlude each other correctly.
 *
 * Like {@link MeshOverlaySurface} it decorates a {@link DisplaySurface}, so its
 * output flows through the lighting and post-FX stack. The terrain geometry is
 * built once (it is static); billboards are rebuilt each frame from the camera
 * basis (so they always face the viewer) at positions the cart supplies.
 *
 * To avoid a new engine mailbox channel, the world reuses the generic 3D-scene
 * channels the mesh feature already ships: the camera rides `cartbox.meshcam`
 * (exposed to carts as `cartbox.worldcam`) and each billboard's position rides a
 * `cartbox.meshpose` slot (exposed as `cartbox.billboard`). The player decodes
 * both and hands them here via {@link setCameraOverride} / {@link setBillboards}.
 *
 * Textures come from the cart's own sprite sheet through a {@link TextureLookup}
 * (built over `createCartSpriteSource`), decoded once per sprite and cached.
 */

/** A billboard the cart placed this frame: which slot, and where its feet stand. */
interface WorldBillboardPose {
    /** Index into the scene's declared billboard slots. */
    readonly index: number;
    /** World position of the billboard's feet (grid units in x/z, height units in y). */
    readonly x: number;
    readonly y: number;
    readonly z: number;
    /** Uniform scale on the slot's authored size (1 = as authored, 0 = hidden). */
    readonly scale: number;
}
declare class WorldOverlaySurface implements DisplaySurface {
    private readonly inner;
    private readonly width;
    private readonly height;
    private readonly scene;
    /**
     * What actually draws the triangles. Owned by the caller — typically shared
     * with the mesh overlay — so destroying this surface must not dispose it.
     */
    private readonly renderer;
    private cartCamera;
    private billboards;
    /** The cart's key light direction (points toward the sun), for terrain shading. */
    private sunDirection;
    private readonly output;
    private readonly presented;
    private readonly depth;
    private readonly terrain;
    /** Per-slot billboard texture, index-aligned to `scene.billboards`. */
    private readonly billboardTextures;
    /** Per-prop texture, index-aligned to `scene.props`. */
    private readonly propTextures;
    /** Shared soft contact-shadow texture, drawn under characters and props. */
    private readonly shadowTexture;
    constructor(inner: DisplaySurface, width: number, height: number, scene: WorldScene, textureFor: TextureLookup, 
    /**
     * What actually draws the triangles. Owned by the caller — typically shared
     * with the mesh overlay — so destroying this surface must not dispose it.
     */
    renderer?: SceneRenderer);
    /** Set the cart-driven camera for the next frame(s), or null to auto-frame. */
    setCameraOverride(camera: MailboxMeshCamera | null): void;
    /**
     * Set the key-light direction the terrain is shaded by (the cart's `cartbox.sun`,
     * pointing toward the light), or null to fall back to a default top-down key.
     * Colour is left to the post-FX grade, so this only steers the directional
     * light/shadow that makes the 3D blocks read as solid geometry.
     */
    setSun(direction: readonly [number, number, number] | null): void;
    /**
     * Set the billboard positions the cart published this frame. Reuses the mesh-pose
     * mailbox: each pose's index selects a billboard slot and its position places the
     * billboard's feet; a hidden or zero-scale pose drops the billboard.
     */
    setBillboards(poses: readonly MailboxMeshPose[]): void;
    blit(rgba: Uint8Array): void;
    private cameraSpec;
    destroy(): void;
}

/**
 * The cart-facing physics calls (ENGINE_ROADMAP.md, Phase 2), generated for a
 * cart that has physics bodies: they read body state from, and write commands
 * to, the shared block at the end of RAM (see protocol.ts) with peek/poke.
 *
 *   cartbox.physics()                 -> true once the host's physics is running
 *   cartbox.body(obj)                 -> x, y, z, vx, vy, vz, grounded (nil if no body)
 *   cartbox.impulse(obj, x, y, z)     push a dynamic body (instant change of momentum)
 *   cartbox.velocity(obj, x, y, z)    set a dynamic or kinematic body's velocity
 *   cartbox.teleport(obj, x, y, z)    move a body there at once
 *   cartbox.move(obj, dx, dy, dz)     walk a character this tick (slides, climbs, steps)
 *   cartbox.ray(slot, x, y, z, dx, dy, dz, max, ignore)   cast a ray (slot 0-15); read next tick
 *   cartbox.sweep(slot, shape, x, y, z, dx, dy, dz, max, ignore)   sweep a shape instead:
 *                                     shape = radius (sphere), {hx, hy, hz} (box half-extents)
 *                                     or {radius, halfheight} (upright capsule)
 *   cartbox.hit(slot)                 -> hit, obj, x, y, z, nx, ny, nz, distance
 *   cartbox.contacts()                -> this tick's contacts { {a=, b=, started=, trigger=}, ... }
 *   cartbox.entered(trigger)          -> objects that came into a trigger zone this tick
 *   cartbox.exited(trigger)           -> objects that left it this tick
 *   cartbox.inside(trigger)           -> objects in it now
 *   cartbox.motor(obj, speed, force)  drive a hinge joint (rad/s, max force; no speed = off)
 *   cartbox.unjoin(obj)               break an object's joint (it's remade if the copy respawns)
 *   cartbox.physicshash()             -> a digest of every moving body's exact state (compare
 *                                     across players to catch a desync; see deterministic mode)
 *
 * Spawning prefab copies (when the cart has prefabs) rides the same block:
 *
 *   cartbox.spawn(prefab, x, y, z, yaw, pitch, roll) -> the copy's root object, or nil
 *   cartbox.despawn(obj)              put a spawned copy back in reserve
 *   cartbox.alive(obj)                -> whether a copy is spawned
 *
 * Skeletal animation (when the scene has skinned objects) rides it too:
 *
 *   cartbox.play(obj, clip, fade, speed, loop)  play a clip (name or 0-based index; nil = rest
 *                                     pose), crossfading over `fade` seconds (default 0.2);
 *                                     speed 1, loop true by default
 *   cartbox.anim(obj)                 -> clip name (nil at rest), seconds into it, finished
 *   cartbox.clips(obj)                -> { name, ... } the object's clips
 *
 * With a state machine (set up in the editor) the cart drives it instead:
 *
 *   cartbox.set(obj, param, value)    set a number or bool parameter
 *   cartbox.trigger(obj, param)       fire a trigger (used up by the transition it starts)
 *   cartbox.state(obj)                -> the current state's name (nil while cartbox.play has control)
 *   cartbox.setstate(obj, state, fade) jump to a state (and hand control back to the machine)
 *   cartbox.events(obj)               -> { name, ... } clip events that fired on the last tick
 *
 * Inverse kinematics on top of whatever plays (world-space points; each call
 * stands until repeated with new values, or with weight 0 to let go):
 *
 *   cartbox.ik(obj, joint, x, y, z, weight, px, py, pz)  reach with the two-bone chain ending
 *                                     at `joint` (e.g. a foot), its middle joint bending toward
 *                                     the pole (px, py, pz) when given
 *   cartbox.lookat(obj, joint, x, y, z, weight, maxdeg) turn `joint` toward a point (≤ maxdeg, 60)
 *   cartbox.joint(obj, joint)         -> x, y, z of a joint in the world (nil until the tick after
 *                                     the first ask)
 *   cartbox.joints(obj)               -> { name, ... } the skeleton's joints
 *
 * Ragdolls (cosmetic, simulated on this machine only, so online play is unaffected):
 *
 *   cartbox.ragdoll(obj, ix, iy, iz, joint)  go limp and tumble, shoved by (ix, iy, iz)
 *                                     world units/second, centred on `joint` when given
 *   cartbox.unragdoll(obj)            back to its animation (e.g. on respawn)
 *
 * Shield effects (cosmetic too; see SHIELD_CALLS):
 *
 *   cartbox.shield(obj, flare, shimmer, camo)  a hit's flare, the recharge shimmer,
 *                                     Active Camo (each 0..1; all 0 clears it)
 *
 * Timelines (cutscenes and camera moves, when the scene has any):
 *
 *   cartbox.playtimeline(name, from, speed)  play a timeline (from seconds; speed 1)
 *   cartbox.stoptimeline()            stop it: the camera and objects go back to the cart
 *   cartbox.timeline()                -> name (nil when none), seconds in, still playing
 *   cartbox.timelineevents()          -> { name, ... } its events passed on the last tick
 *
 * `obj` is an object index or its name (as cartbox.find). The SDK's defaults
 * (sdk.ts) make every call a safe no-op for carts without bodies or prefabs.
 */

/**
 * Whether a scene needs the runtime block at all: bodies (when a physics engine
 * will run them), prefabs to spawn, or skinned objects to animate.
 */
declare function sceneNeedsRuntime(scene: MeshScene | null | undefined, { physics }?: {
    physics?: boolean;
}): boolean;
/**
 * The Lua for a cart's runtime calls — physics (when it has bodies) and spawning
 * (when it has prefabs) — or "" when it needs neither.
 */
declare function runtimeSdkLua(scene: MeshScene | null | undefined, layout: RamLayout, { physics: engine }?: {
    physics?: boolean;
}): string;
/** @deprecated Kept for callers of the physics-only name: the same as runtimeSdkLua. */
declare const physicsSdkLua: typeof runtimeSdkLua;

/**
 * Deterministic physics (ENGINE_ROADMAP.md, Phase 2): the same scene and the same
 * inputs play out bit for bit the same in every browser.
 *
 * Two halves. The physics engine itself must be deterministic across platforms —
 * the web app loads Rapier's deterministic build for that. And every number the
 * host computes in JavaScript before handing it to the engine must be too: world
 * matrices come from Math.sin / Math.cos (spawn turns, authored rotations) and
 * Math.hypot, which browsers are free to round differently in the last bit. So
 * {@link deterministicBackend} rounds every such input onto a fixed grid (1/65536
 * for positions and sizes, 1/2^20 for rotations and directions): two browsers'
 * values a little apart land on the same grid point. The engine's own 32-bit
 * floats already absorb most single-bit differences; the grid is far coarser, so
 * it also absorbs the larger errors that build up through chains of matrix math
 * (a child under a turned parent under another). Only a value that happens to sit
 * within that error of a grid line could still split.
 *
 * What the cart sends is already exact (fixed-point commands from Lua, which runs
 * in WebAssembly and so rounds the same everywhere), and what it reads back is
 * rounded to 1/1024. {@link physicsStateHash} digests the exact state, so peers
 * can compare it to catch a desync.
 */

/** Wrap a backend so every value the host computes reaches it on a fixed grid. */
declare function deterministicBackend(inner: PhysicsBackend): PhysicsBackend;
/**
 * A 32-bit FNV-1a digest of bodies' exact state (positions, rotations and
 * velocities as the engine's 32-bit floats), in order: equal on two machines
 * exactly when their worlds match.
 */
declare function physicsStateHash(states: Iterable<{
    position: Vec3$2;
    rotation: Quat;
    velocity: Vec3$2;
}>): number;

/**
 * Plays skeletal animation on a cart's skinned scene objects (ENGINE_ROADMAP.md,
 * Phase 3).
 *
 * Every object whose mesh has a skeleton gets a playback state. With an
 * animation state machine (its sidecar `animator`, see animatorSpec.ts) the
 * machine decides what plays: the cart sets its parameters (cartbox.set /
 * cartbox.trigger), transitions whose conditions hold move it between states
 * with a crossfade, and blend states mix clips by a parameter. Without one, the
 * object loops its first clip. Either way cartbox.play takes direct control of
 * the clip (pausing the machine until cartbox.setstate hands it back).
 *
 * Clip events (named moments in a clip, from the state machine) fire as the
 * playhead passes them and are reported to the cart for one tick.
 *
 * Time advances by a fixed 1/60 s per tick (never the wall clock), so playback
 * is as deterministic as the rest of the cart. The skinning matrices for the
 * current moment are computed on demand, once per tick, for the renderer.
 */

interface CompiledState {
    readonly name: string;
    readonly clip: number;
    readonly speed: number;
    readonly loop: boolean;
    readonly blend: {
        readonly param: number;
        readonly points: readonly {
            readonly clip: number;
            readonly at: number;
        }[];
    } | null;
}
interface CompiledMachine {
    readonly params: readonly {
        readonly name: string;
        readonly kind: string;
        readonly initial: number;
    }[];
    readonly states: readonly CompiledState[];
    readonly transitions: readonly {
        readonly from: number;
        readonly to: number;
        readonly when: readonly {
            readonly param: number;
            readonly op: AnimatorOp;
            readonly value: number;
        }[];
        readonly fade: number;
        readonly exitTime?: number;
    }[];
    /** Events per clip index: seconds into the clip and the event's index in the spec. */
    readonly events: ReadonlyMap<number, readonly {
        readonly time: number;
        readonly index: number;
    }[]>;
    readonly eventNames: readonly string[];
}
/** The scene objects with a skeleton, in index order. */
declare function animatedObjects(scene: MeshScene | null | undefined): number[];
/** Whether a scene has anything to animate. */
declare function sceneHasAnimation(scene: MeshScene | null | undefined): boolean;
/** Resolve a state machine's names against a mesh's clips (missing clips play the rest pose). */
declare function compileAnimator(spec: AnimatorSpec, mesh: MeshAsset): CompiledMachine;
declare class AnimationSession {
    private readonly scene;
    private readonly playback;
    private tick;
    private cache;
    /** Each object's final pose (after any adjustment, e.g. IK) as last skinned. */
    private readonly lastPose;
    constructor(scene: MeshScene);
    private fresh;
    /** Crossfade `p` into `next` over `fade` seconds. */
    private switchTo;
    /** Play `clip` directly on `object` (-1 = rest), pausing its state machine. */
    play(object: number, clip: number, fade: number, speed: number, loop: boolean, start?: number): void;
    /** Set a state-machine parameter (bools as 0/1; a trigger is set by any non-zero value). */
    setParam(object: number, param: number, value: number): void;
    /** Jump to (crossfade into) a state, handing control back to the machine. */
    goto(object: number, state: number, fade?: number): void;
    /** Put an object back to its starting playback (a prefab copy spawned afresh). */
    reset(object: number): void;
    /** Take any transition that's ready, then advance every playback one tick (firing clip events). */
    step(dt: number): void;
    /** How far through its cycle a track is (0..1 per pass of its clip; loops keep counting). */
    private progress;
    private transition;
    /** The blend state's weights now, or null for a single clip. */
    private blendOf;
    private advance;
    /** Where the playhead is for events: which clip, and seconds into it (unwrapped). */
    private cursor;
    private fireEvents;
    /** Each animated object's clip, time and state, as the cart reads them. */
    state(): AnimationPlayback[];
    /** Events that fired on the last step: object and the event's index in its state machine. */
    events(): {
        object: number;
        event: number;
    }[];
    /** The clip a track shows (a blend reports its stronger clip) and seconds into it. */
    private shownClip;
    /**
     * The skinning matrices for every animated object now (object → matrices),
     * computed once per tick. `visible` skips objects not being drawn (a reserve
     * prefab copy), which then keep their last pose; `adjust` may rewrite a pose
     * before it's skinned (inverse kinematics).
     */
    matrices(visible?: (object: number) => boolean, adjust?: (object: number, mesh: MeshAsset, pose: Float32Array) => void): Map<number, Float32Array>;
    /** Recompute the matrices on the next request (something that shapes the pose changed). */
    invalidate(): void;
    /** An object's final pose as last skinned (null before its first). */
    finalPose(object: number): Float32Array | null;
    private pose;
}

/**
 * Navigation agents (ENGINE_ROADMAP.md, Phase 6): characters the host walks
 * over a scene's baked surface (see navmesh.ts in @cartbox/editor) — each finds
 * its own path to wherever the cart sends it, and keeps clear of the others.
 *
 * Every tick an agent heads for the next corner of its path at its speed; then
 * agents that overlap push apart (half each; all of it for an agent against an
 * obstacle — something the cart moves itself, like the player), and every move
 * is kept on the surface: a step onto a floor within `climb` follows it up or
 * down (stairs, ramps), a step off a ledge along a drop link falls under gravity,
 * and a step anywhere else is refused (it slides along the edge instead). Paths
 * are found again when the goal moves or the agent is knocked off its route.
 *
 * Deterministic: a fixed step, no randomness, agents in key order.
 */

type Vec3 = [number, number, number];
declare class AgentCrowd {
    readonly graph: NavGraph;
    private readonly agents;
    constructor(mesh: NavMesh);
    /** Place an agent (creating it): a walker, or an obstacle the cart moves. */
    place(key: number, pos: Vec3, speed: number, radius: number, obstacle: boolean): void;
    /** Send an agent toward a point (speed > 0 changes its speed). */
    goto(key: number, goal: Vec3, speed?: number): void;
    stop(key: number): void;
    remove(key: number): void;
    /** Stand a point on the floor beneath it (or the nearest floor), unchanged when there's none. */
    private settle;
    /** Advance every agent by `dt` seconds. */
    step(dt: number): void;
    /** Move one agent by (dx, dz), sliding along edges, stepping and falling as the floor allows. */
    private move;
    /** Every agent as the cart reads it, in key order. */
    state(): AgentState[];
    /** One agent's current path corners (for inspection and tests). */
    path(key: number): readonly Vec3[];
}

/**
 * Plays a scene's timelines (ENGINE_ROADMAP.md, Phase 3): cutscenes and
 * scripted camera moves authored in the Mesh tab (see timeline.ts).
 *
 * One timeline plays at a time. Each tick its playhead advances a fixed 1/60 s
 * (times its speed); the animation cues and events it passes are handed back to
 * be applied (cues) and reported to the cart (events). While it plays — and after
 * it ends, if it holds — its camera keys drive the camera and its object keys
 * place their objects. A timeline marked autoplay starts with the cart.
 */

interface TimelinePlayback {
    /** The timeline's index, or -1 when none plays or holds. */
    readonly index: number;
    readonly time: number;
    /** False once a held timeline has ended (and for none). */
    readonly playing: boolean;
}
declare class TimelineSession {
    private readonly scene;
    private readonly timelines;
    private readonly objectIndex;
    private current;
    private fired;
    constructor(scene: MeshScene);
    /** Play timeline `index` from `from` seconds (an invalid index stops). */
    play(index: number, from?: number, speed?: number): void;
    stop(): void;
    /**
     * Advance one tick. Returns the animation cues passed (object index + cue) for
     * the caller to apply; the events passed are kept for {@link events}.
     */
    step(dt: number): {
        object: number;
        cue: AnimationCue;
    }[];
    /** What plays (or holds) now. */
    state(): TimelinePlayback;
    /** Indices (into the playing timeline's event names) of the events passed on the last step. */
    events(): number[];
    /** The timeline camera now (world eye, target, fov in degrees), or null. */
    camera(): {
        eye: readonly [number, number, number];
        target: readonly [number, number, number];
        fov: number;
    } | null;
    /**
     * World matrices of the objects the timeline places (object index → matrix):
     * each key is relative to the object's parent, which may itself be placed by
     * the timeline.
     */
    placements(): Map<number, Mat4>;
}

/**
 * The per-tick exchange between the host and a cart's Lua through the shared
 * block at the end of RAM (physics/protocol.ts): physics state out, and the
 * cart's commands in — physics ones for the {@link PhysicsSession}, scene ones
 * (spawning and despawning prefab copies) handled here, and animation ones for
 * the {@link AnimationSession}.
 *
 * A cart gets a channel when its scene has physics bodies, spawnable prefabs or
 * skinned (animated) objects.
 */

/** One `cartbox.burst`: the effect's index, where, which way (or a trail's segment), and its scale. */
interface ParticleBurst {
    readonly effect: number;
    readonly at: readonly [number, number, number];
    readonly dir: readonly [number, number, number];
    readonly scale: number;
}
/** One `cartbox.decal`: the decal's index, where, the surface's normal, and its scale. */
interface DecalLaid {
    readonly decal: number;
    readonly at: readonly [number, number, number];
    readonly normal: readonly [number, number, number];
    readonly scale: number;
}
/** An object's standing `cartbox.shield`: a hit's flare, the recharge shimmer and Active Camo (each 0..1). */
interface ShieldState {
    readonly flare: number;
    readonly shimmer: number;
    readonly camo: number;
}
/** One `cartbox.debris`: the definition's index, where, its velocity, and its scale. */
interface DebrisThrown {
    readonly debris: number;
    readonly at: readonly [number, number, number];
    readonly velocity: readonly [number, number, number];
    readonly scale: number;
}
declare class RuntimeChannel {
    private readonly scene;
    private readonly physics;
    /** Spawned copies: root object index → the root's world matrix. */
    private readonly active;
    /** Each reserve root's objects (itself first, then its descendants). */
    private readonly copyObjects;
    /** The skeletal animation player, when the scene has skinned objects. */
    readonly animation: AnimationSession | null;
    /** The timeline player, when the scene has timelines. */
    readonly timeline: TimelineSession | null;
    /** Navigation agents, when the scene has a baked walkable surface. */
    readonly crowd: AgentCrowd | null;
    /** Standing IK / look-at requests: object → joint → request (IK before look-at). */
    private readonly requests;
    /** A pole for the next IK request on (object, joint). */
    private readonly poles;
    /** Levels: the current one, the one loading (-1), its progress, and a switch the cart asked for. */
    private level;
    private levelRequest;
    /** Where the cart asked spatial loading to centre (null = the camera). */
    private focus;
    /** Particle bursts the cart fired since the renderer last took them. */
    private bursts;
    /** Decals the cart laid since the renderer last took them. */
    private decals;
    /** Debris the cart threw since the renderer last took it. */
    private debris;
    /** Standing shield effects (cartbox.shield): object → flare, shimmer, camo. */
    private readonly shieldStates;
    /**
     * Ragdolls (H9): object → the limp body, built from its pose the next time it
     * is skinned after cartbox.ragdoll (until then null, with the shove to give it).
     * Local and cosmetic: nothing here reaches the cart or the physics world.
     */
    private readonly ragdolls;
    /** What ragdolls land on (the scene's static bodies and authored boxes), built on first use. */
    private ragdollBoxes;
    /** Collision radii per skinned mesh. */
    private readonly radii;
    /** Joints whose world position the cart asked for, and where they were when last skinned. */
    private readonly watched;
    constructor(scene: MeshScene, physics: PhysicsSession | null);
    /** Write what the cart reads this tick (and the handshake word). */
    beforeTick(block: DataView): void;
    /** Take the cart's commands: scene ops here, the rest to physics (which then steps). */
    afterTick(block: DataView): void;
    /** Go limp (v0 = 1) with a shove, or take the animation back (v0 = 0). */
    private ragdollCommand;
    /** Set (or, with all three 0, clear) an object's shield effect. */
    private shieldCommand;
    /** The standing shield effects (object → state); the renderer draws them on the object and everything under it. */
    shields(): ReadonlyMap<number, ShieldState>;
    /** Whether an object is a ragdoll now. */
    isRagdoll(object: number): boolean;
    /** The boxes ragdolls collide with (see sceneColliders), built on first use. */
    private colliders;
    /** A navigation agent command (see PHYS_OP_AGENT). */
    private agentCommand;
    /** A level switch the cart asked for since the last call (-1 for none); the player loads and activates it. */
    takeLevelRequest(): number;
    /** The level loading, and how far along (0..1), as the cart reads it. */
    setLevelLoading(level: number, progress: number): void;
    /** Make `level` the current one (the loading state clears). */
    setLevel(level: number): void;
    /** The decals laid since the last call (the renderer draws them). */
    takeDecals(): DecalLaid[];
    /** The debris thrown since the last call (the renderer simulates and draws it). */
    takeDebris(): DebrisThrown[];
    /** The particle bursts fired since the last call (the renderer draws them). */
    takeBursts(): ParticleBurst[];
    /** Where the cart asked spatial loading to centre, or null for the camera. */
    streamFocus(): readonly [number, number, number] | null;
    /** The current level (-1 when the scene has none). */
    currentLevel(): number;
    /**
     * Skinning matrices for the animated objects being drawn (object → matrices);
     * reserve prefab copies not spawned are skipped. IK and look-at requests are
     * applied first, their world-space targets taken into each object's space with
     * `worldOf` (its world matrix this frame; by default its physics body, spawn
     * placement or authored placement).
     */
    skinning(worldOf?: (object: number) => Mat4 | null): ReadonlyMap<number, Float32Array>;
    /** Start a timeline cue on an object: a state of its state machine by that name, else a clip. */
    private cue;
    /**
     * The camera a playing (or holding) timeline sets, as a mesh-camera override
     * (orbit about the scene centre, reproducing its eye and target), or null.
     */
    timelineCamera(hud?: boolean): MailboxMeshCamera | null;
    /** World matrices of the objects a timeline is placing (object index → matrix). */
    timelinePlacements(): ReadonlyMap<number, Mat4>;
    /** Whether IK, look-at, joint watching or a ragdoll needs the objects' current world matrices. */
    needsWorld(): boolean;
    private defaultWorld;
    private request;
    private watch;
    /** Apply an object's standing IK (first) and look-at requests to its pose, then a ragdoll over it all. */
    private solve;
    private solveRequests;
    /** Spawned copies' root world matrices (root object index → matrix). */
    spawned(): ReadonlyMap<number, Mat4>;
    private spawn;
    private despawn;
    destroy(): void;
}

/**
 * @cartbox/player — public entry point.
 *
 * Usage:
 *   import { mount } from "@cartbox/player";
 *   const handle = mount(document.getElementById("player")!, {
 *     cartUrl: "https://cdn.cartbox.dev/carts/abc123.tic",
 *     engineUrl: "https://cdn.cartbox.dev/engine/tic80.js",
 *     controls: "auto",
 *     scale: "fit",
 *   });
 *   // later: handle.pause(); handle.resume(); handle.destroy();
 */

/**
 * Mounts a cartridge player into a container element and begins loading.
 *
 * Loading is asynchronous; the returned handle is usable immediately, and
 * lifecycle callbacks (`onReady`, `onError`) report progress. When `autostart`
 * is false (the default), the loop is armed but only runs once `resume()` is
 * called from a user gesture — required for audio on mobile browsers.
 *
 * @param container Element the canvas and any touch controls are appended to.
 * @param options Cartridge/engine URLs and playback preferences.
 * @returns A handle to pause, resume, or destroy the player.
 */
declare function mount(container: HTMLElement, options: PlayerOptions): PlayerHandle;

export { AgentCrowd, type AnimClip, type AnimMode, type AnimPlacement, type AnimSpec, type AnimState, type AnimTarget, type AnimTrack, AnimatedForegroundSurface, AnimationSession, type AtmosphereParams, BLOOM_KNEE, BloomPyramid, BroadcastChannelTransport, type BuiltLightingRenderer, CAMERA_BASE, CAMERA_SCALE, CARTBOX_SDK_LUA, CELL_WORLD, CappedSceneRenderer, type CartSpriteSource, CartridgeLoadError, type CastHit, type CastShape, type ClipSample, type ClipTableEntry, type CollisionField, ConsoleButton, type ConsoleInstance, type ConsoleModel, type ControlScheme, type ControlSettings, type ControlTarget, DEFAULT_AMBIENT, DEFAULT_ATMOSPHERE, DEFAULT_CONTROL_SETTINGS, DEFAULT_KEY_BINDINGS, DEFAULT_LIGHT, DEFAULT_MODEL_ID, DEFAULT_PAD_BINDINGS, DebugCommand, type DebugStep, type DeviceHints, type DeviceProvider, EVENT_CAPACITY, type Ease, EngineLoadError, type ErrorFrame, FLARE_GHOSTS, FLARE_GHOST_GAIN, FLARE_SPIKE_POWER, type FlagsField, type FlareGhost, type FlareParams, type FrameState, GamepadInput, type GeneratedTrack, type GlContextProvider, HEIGHT_WORLD, INSTANCE_FLOATS, type InnerSurfaceFactory, type InputChange, type InspectedObject, type InstanceTransform, type Keyframe, LIGHTS_BASE, LIGHTS_CAPACITY, LIGHT_FLOATS, LIGHT_STRIDE, type LayerChannel, type Light, type LightingBackend, type LightingFrameContext, LightingLayer, type LightingOptions, type LightingRenderer, type LightingScene, LitCanvasSurface, MAILBOX_TYPE_ACHIEVEMENT, MAILBOX_TYPE_PROGRESS, MAILBOX_TYPE_SCORE, MAILBOX_WORDS, MAX_EMITTERS, MAX_PARTICLES_PER_EMITTER, MAX_PYRAMID_LEVELS, MESH_CAM_ANGLE_SCALE, MESH_CAM_BASE, MESH_CAM_DIST_SCALE, MESH_CAM_STRIDE, MESH_POSE_BASE, MESH_POSE_CAPACITY, MESH_POSE_HIDDEN, MESH_POSE_STRIDE, MIN_PYRAMID_DIMENSION, MODELS, type MailboxCamera, type MailboxEvent, type MailboxEventKind, type MailboxMeshCamera, type MailboxMeshPose, type MailboxRead, type MaterialBuffer, MemoryNetHub, type MeshInstance, MeshOverlaySurface, type MeshScene, type SceneCamera$1 as MeshSceneCamera, type ModelId, NET_MODE_CLIENT, NET_MODE_HOST, NET_MODE_OFFLINE, NET_SLOTS, NET_WORDS, NORMAL_DIRECTION_COUNT, NORMAL_VECTORS, type NetEvent, type NetInbox, type NetMessage, type NetOutbox, type NetPeer, type NetRoomStatus, NetSession, type NetState, type NetTransport, PAD_BUTTONS, PARTICLE_KINDS, PHYSICS_DT, PHYS_BLOCK_BYTES, PHYS_MAGIC, POST_FX_EFFECTS, PROFILE_SECTIONS, PROFILE_WINDOW, type PackableLight, type PadButton, type PadSnapshot, type Particle, type ParticleEmitter, type ParticleKind, ParticleOverlaySurface, type ParticleSpec, type PauseInfo, type PbrMaterial, type PhysicsBackend, type PhysicsBodyDesc, type PhysicsJointDesc, type Quat as PhysicsQuat, PhysicsSession, type PhysicsShape, type Vec3$2 as PhysicsVec3, type PlacementChannel, type PlayerHandle, type PlayerOptions, type PostFxColorDef, type PostFxEffectDef, type PostFxEffectId, type PostFxParamDef, PostFxPass, type PostFxSettings, type PostFxSource, PostFxSurface, type PostFxUniforms, type ProfileSection, type ProfileSnapshot, Profiler, QUALITY_LEVELS, QUALITY_PRESETS, type QualityChoice, type QualityLevel, type QualitySettings, RAM_LAYOUTS, REPLAY_VERSION, type RamLayout, type RegionImage, type RegisteredAchievement, type RenderCanvas, type RenderCaps, type RenderStats, type Replay, ReplayError, ReplayRecorder, ReplaySource, type ResolvedPbr, type ResolvedPlacement, type Rgb, RuntimeChannel, SOFTWARE_RASTER_CAPS, START_KEYS, type ScaleMode, SceneBackdropSurface, type SceneBounds, type SceneCamera, type SceneDraw, type SceneLayer, type SceneRenderer, type SceneSpec, type ScreenSun, type SectionStats, SoftwareSceneRenderer, type SpriteRegion, type SpriteRegionSource, SwitchableTransport, TILT_SHIFT_FEATHER, type TextureLookup, type TraceLine, type TrackMode, UNIFORM_BYTES_USED, UNIFORM_FLOATS, UNIFORM_STRIDE, VERTEX_FLOATS, type Vec3$1 as Vec3, type VerificationResult, WEBGL_INSTANCES_PER_DRAW, WEBGL_MAX_LIGHTS, WebglSceneRenderer, WebgpuLightingLayer, WebgpuSceneRenderer, type WorldBillboard, type WorldBillboardPose, type WorldCamera, type WorldCameraSpec, type WorldLight, WorldOverlaySurface, type WorldProp, type WorldScene, type WorldTileCell, acesFilmic, acesFilmicChannel, alignBytesPerRow, animClipsSdkLua, animatedObjects, anyPostFxEnabled, appendLuaCode, applyLookSettings, applyQualityToPostFx, applyRenderCaps, armDebugBlock, breakableLine, browserDeviceHints, buildBillboardInstance, buildClipTable, buildOrbitCamera, buildShadowInstance, buildTerrainInstances, buildWorldCamera, cameraAt, capTextures, capTriangles, capsConstrainScene, cellAt, clipFrameIndex, codeChunks, codeLineOffset, collisionSdkLua, compileAnimator, composeParallax, composeWorldMatrix, compositeOverBackdrop, createCartSpriteSource, createConsole, createFlatMaterial, createLightingLayer, createSceneRenderer, createTextureBudgetCache, deadZoned, debugBlockAddress, debugPostlude, debugSdkLua, decodeCamera, decodeLights, decodeMailbox, decodeMeshCamera, decodeMeshPoses, decodeWorldLights, defaultPostFxSettings, detectQuality, deterministicBackend, drift, effectiveBreakpoints, emitterPreset, errorStack, estimateSceneBytes, evaluate, extractScore, extractUnlocks, fillSky, fitShape, fitTextureToBudget, flagsSdkLua, flicker, frameDurationMs, framebufferBytes, getModel, getWebgpuDevice, hashCart, hashEventId, hexToRgb01, injectSdk, instrumentLua, interleaveVertices, interpolateNormal, jointFrames, lensFlareAt, loadEngineModule, makeShadowTexture, mount, nearestDirection, netSendInterval, normalBasis3x3, normalVector, orbitPitchAboveTerrain, packLights, paramKey, parseAnim, parseCollisionField, parseControlSettings, parseFlagsField, parseMeshScene, parseParticles, parsePauseInfo, parsePostFxSettings, parseReplay, parseScene, parseWorldScene, physicsBlockAddress, physicsSdkLua, physicsSlots, physicsStateHash, prehazeLayers, prependLuaCode, pulse, pyramidLevelCount, pyramidLevelSize, randomSeed, rasterStyleFor, readCartCode, readPad, readPause, reflectionFade, reflectionSampleY, remapErrorLines, renderSceneBackdrop, resolveButton, resolveLight, resolvePbr, resolveQuality, resolveSceneLayers, resolveSupersample, resolveUnlockedAchievements, rewriteLuaCode, runReplayEvents, runtimeSdkLua, sampleClipFrame, sampleNormalBilinear, sampleScalarBilinear, sampleTrack, sceneHasAnimation, sceneHasPhysics, sceneNeedsRuntime, sceneObjectsSdkLua, seedCartridge, sendDebugCommand, serializeReplay, shade, simulateEmitter, softKneePrefilter, splitWorldMatrix, standardizePad, streamGroups, sway, takeNetOutbox, takePhysicsCommands, tiltShiftBlur, tokenizeLua, uniformsFromSettings, unpadRows, verifyReplayScore, viewDirection, webgpuCanHonour, worldCenter, writeBreakpoints, writeInstanceTransform, writeInstanceUniform, writeNetInbox, writePhysicsState, writeWatches };
