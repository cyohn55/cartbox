/**
 * The web app's physics engine: Rapier (WebAssembly), behind the player's
 * PhysicsBackend interface (ENGINE_ROADMAP.md, Phase 2).
 *
 * Imported dynamically by `rapierPhysics()`, so the ~2 MB engine is only fetched
 * for carts whose scene objects have physics bodies. Gravity is -9.81 on Y; each
 * body keeps the scene object index it was built for, which raycasts report.
 */

import type { PhysicsBackend, PhysicsBodyDesc, PhysicsQuat, PhysicsVec3 } from "@cartbox/player";

type Rapier = typeof import("@dimforge/rapier3d-compat");

let loading: Promise<Rapier> | null = null;

/** Load (once) and initialise Rapier. */
function loadRapier(): Promise<Rapier> {
  loading ??= import("@dimforge/rapier3d-compat").then(async (mod) => {
    const rapier = ((mod as unknown as { default?: Rapier }).default ?? mod) as Rapier;
    await rapier.init();
    return rapier;
  });
  return loading;
}

/** A PhysicsBackend factory for the player's `physics` option. */
export function rapierPhysics(): () => Promise<PhysicsBackend> {
  return async () => createRapierBackend(await loadRapier());
}

const v3 = (v: PhysicsVec3) => ({ x: v[0], y: v[1], z: v[2] });

export function createRapierBackend(R: Rapier): PhysicsBackend {
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  type Body = InstanceType<Rapier["RigidBody"]>;
  type Collider = InstanceType<Rapier["Collider"]>;
  const bodies: Body[] = [];
  const colliders: Collider[] = [];
  const objectOf = new Map<number, number>(); // collider handle → scene object
  const characters = new Set<number>(); // body handles of characters
  const events = new R.EventQueue(true);
  const sensors: Collider[] = [];
  const controller = world.createCharacterController(0.02);
  controller.enableSnapToGround(0.3);
  controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
  controller.setMinSlopeSlideAngle((35 * Math.PI) / 180);
  controller.enableAutostep(0.35, 0.2, true);
  controller.setApplyImpulsesToDynamicBodies(true);

  return {
    addBody(desc: PhysicsBodyDesc): number {
      const bodyDesc =
        desc.kind === "dynamic"
          ? R.RigidBodyDesc.dynamic()
          : desc.kind === "static"
            ? R.RigidBodyDesc.fixed()
            : R.RigidBodyDesc.kinematicPositionBased();
      const q = desc.rotation;
      bodyDesc.setTranslation(desc.position[0], desc.position[1], desc.position[2]);
      // A character stays upright: rotation is the cart's to show, not physics'.
      if (desc.kind !== "character") bodyDesc.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
      if (desc.kind === "kinematic") bodyDesc.setCanSleep(false);
      if (desc.kind === "dynamic") {
        if (desc.gravity !== undefined) bodyDesc.setGravityScale(desc.gravity);
        if (desc.damping !== undefined) bodyDesc.setLinearDamping(desc.damping);
      }
      const body = world.createRigidBody(bodyDesc);
      const s = desc.shape;
      const colliderDesc =
        s.kind === "box"
          ? R.ColliderDesc.cuboid(s.halfExtents[0], s.halfExtents[1], s.halfExtents[2]).setTranslation(s.offset[0], s.offset[1], s.offset[2])
          : s.kind === "sphere"
            ? R.ColliderDesc.ball(s.radius).setTranslation(s.offset[0], s.offset[1], s.offset[2])
            : s.kind === "capsule"
              ? R.ColliderDesc.capsule(s.halfHeight, s.radius).setTranslation(s.offset[0], s.offset[1], s.offset[2])
              : R.ColliderDesc.trimesh(s.vertices, s.indices);
      colliderDesc.setFriction(desc.friction).setRestitution(desc.bounce);
      if (desc.kind === "dynamic") colliderDesc.setMass(desc.mass);
      colliderDesc.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
      if (desc.trigger) {
        // A trigger overlaps everything (static, kinematic and character bodies
        // included), blocks nothing, and reports who's inside.
        colliderDesc.setSensor(true).setActiveCollisionTypes(R.ActiveCollisionTypes.ALL);
      }
      const collider = world.createCollider(colliderDesc, body);
      if (desc.trigger) sensors.push(collider);
      objectOf.set(collider.handle, desc.object);
      bodies.push(body);
      colliders.push(collider);
      if (desc.kind === "character") characters.add(bodies.length - 1);
      return bodies.length - 1;
    },

    step(dt: number): void {
      world.timestep = dt;
      world.step(events);
    },

    drainContacts() {
      const out: { a: number; b: number; started: boolean; trigger: boolean }[] = [];
      events.drainCollisionEvents((h1, h2, started) => {
        const c1 = world.getCollider(h1);
        const c2 = world.getCollider(h2);
        out.push({
          a: objectOf.get(h1) ?? -1,
          b: objectOf.get(h2) ?? -1,
          started,
          trigger: Boolean(c1?.isSensor() || c2?.isSensor()),
        });
      });
      return out;
    },

    overlaps() {
      const out: [number, number][] = [];
      for (const sensor of sensors) {
        if (!sensor.isEnabled() || !sensor.parent()?.isEnabled()) continue;
        const trigger = objectOf.get(sensor.handle) ?? -1;
        world.intersectionPairsWith(sensor, (other) => {
          out.push([trigger, objectOf.get(other.handle) ?? -1]);
        });
      }
      return out;
    },

    bodyState(handle: number) {
      const body = bodies[handle]!;
      const t = body.translation();
      const r = body.rotation();
      const v = body.linvel();
      return {
        position: [t.x, t.y, t.z] as PhysicsVec3,
        rotation: [r.x, r.y, r.z, r.w] as PhysicsQuat,
        velocity: [v.x, v.y, v.z] as PhysicsVec3,
        sleeping: body.isSleeping(),
      };
    },

    applyImpulse(handle: number, impulse: PhysicsVec3): void {
      bodies[handle]?.applyImpulse(v3(impulse), true);
    },

    setVelocity(handle: number, velocity: PhysicsVec3): void {
      const body = bodies[handle];
      if (!body) return;
      if (body.isKinematic()) {
        // Kinematic bodies move by their next target position.
        const t = body.translation();
        body.setNextKinematicTranslation({ x: t.x + velocity[0] / 60, y: t.y + velocity[1] / 60, z: t.z + velocity[2] / 60 });
      } else body.setLinvel(v3(velocity), true);
    },

    teleport(handle: number, position: PhysicsVec3): void {
      const body = bodies[handle];
      if (!body) return;
      body.setTranslation(v3(position), true);
      if (body.isKinematic()) body.setNextKinematicTranslation(v3(position));
      else body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    },

    moveCharacter(handle: number, delta: PhysicsVec3): { grounded: boolean } {
      const body = bodies[handle];
      const collider = colliders[handle];
      if (!body || !collider) return { grounded: false };
      // Trigger zones don't block a character (it walks into them).
      controller.computeColliderMovement(collider, v3(delta), R.QueryFilterFlags.EXCLUDE_SENSORS);
      const m = controller.computedMovement();
      const t = body.translation();
      const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
      // Apply now so the cart reads where it went this tick, and again as the
      // kinematic target so the step pushes what it walked into.
      body.setTranslation(next, true);
      body.setNextKinematicTranslation(next);
      return { grounded: controller.computedGrounded() };
    },

    raycast(origin: PhysicsVec3, direction: PhysicsVec3, maxDistance: number) {
      const ray = new R.Ray(v3(origin), v3(direction));
      // Rays pass through trigger zones.
      const hit = world.castRayAndGetNormal(ray, maxDistance, true, R.QueryFilterFlags.EXCLUDE_SENSORS);
      if (!hit) return null;
      const toi = (hit as unknown as { timeOfImpact?: number; toi?: number }).timeOfImpact ?? (hit as unknown as { toi: number }).toi;
      const point = ray.pointAt(toi);
      return {
        object: objectOf.get(hit.collider.handle) ?? -1,
        point: [point.x, point.y, point.z] as PhysicsVec3,
        normal: [hit.normal.x, hit.normal.y, hit.normal.z] as PhysicsVec3,
        distance: toi,
      };
    },

    setEnabled(handle: number, enabled: boolean): void {
      bodies[handle]?.setEnabled(enabled);
    },

    setPose(handle: number, position: PhysicsVec3, rotation: PhysicsQuat): void {
      const body = bodies[handle];
      if (!body) return;
      body.setTranslation(v3(position), true);
      // Characters stay upright (see addBody).
      if (!characters.has(handle)) body.setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] }, true);
      if (body.isKinematic()) body.setNextKinematicTranslation(v3(position));
      else if (body.isDynamic()) {
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    },

    destroy(): void {
      events.free();
      world.removeCharacterController(controller);
      world.free();
    },
  };
}
