/**
 * The scene's lights as the frame and the probes' bounce see them
 * (HALO_INFINITE_STYLE_ROADMAP.md I17): the lighting rig with the cart's sun
 * this frame (`cartbox.sun3d`) in place of its key light, and the lights a
 * probe relight uses, in the bake's units (see dynamicBounce.ts in
 * @cartbox/editor). Pure.
 */

import type { BounceLights, SceneLight, SceneLighting } from "@cartbox/editor";

/** The cart's sun this frame: the direction toward it, and its colour with its intensity folded in. */
export interface CartSun {
  readonly direction: readonly [number, number, number];
  readonly color: readonly [number, number, number];
}

/**
 * `lighting` with `sun` as its key (the first directional light; added first
 * if it has none), and its sky's sun moved to it — the glow, the shafts and
 * the flare — coloured by how `sun` compares, channel by channel, with the
 * key it replaces (a dimmer, redder evening sun paints a dimmer, redder glow).
 */
export function withCartSun(lighting: SceneLighting, sun: CartSun): SceneLighting {
  const l = Math.hypot(...sun.direction) || 1;
  const direction: [number, number, number] = [sun.direction[0] / l, sun.direction[1] / l, sun.direction[2] / l];
  const key: SceneLight = { kind: "directional", direction, color: [...sun.color], intensity: 1 };
  const at = lighting.lights.findIndex((x) => x.kind === "directional");
  const authored = at < 0 ? null : lighting.lights[at]!;
  const sky = lighting.sky;
  return {
    ...lighting,
    lights: at < 0 ? [key, ...lighting.lights] : lighting.lights.map((x, i) => (i === at ? { ...x, ...key } : x)),
    ...(sky
      ? {
          sky: {
            ...sky,
            sunDirection: direction,
            sunColor: [0, 1, 2].map((k) => {
              const reference = authored ? authored.color[k]! * authored.intensity : 1;
              return reference > 1e-6 ? (sky.sunColor[k]! * sun.color[k]!) / reference : 0;
            }) as [number, number, number],
          },
        }
      : {}),
  };
}

/**
 * The lights a probe relight uses, in the bake's units — the baked sun was
 * white at the rig's key brightness:
 * - the sun (the `frame` rig's key) is coloured by how it compares, channel by
 *   channel, with the `authored` rig's key;
 * - every point and spot light (the rig's and the cart's) is scaled by its
 *   brightness against that key's.
 */
export function bounceLightsFor(authored: SceneLighting, frame: SceneLighting, cart: readonly SceneLight[]): BounceLights {
  const authoredKey = authored.lights.find((x) => x.kind === "directional");
  const reference = authoredKey ? authoredKey.color.map((c) => c * authoredKey.intensity) : [1, 1, 1];
  const brightness = 0.2126 * reference[0]! + 0.7152 * reference[1]! + 0.0722 * reference[2]! || 1;
  const key = frame.lights.find((x) => x.kind === "directional");
  const sun =
    key?.direction
      ? { direction: key.direction, color: [0, 1, 2].map((k) => (reference[k]! > 1e-6 ? (key.color[k]! * key.intensity) / reference[k]! : 0)) as [number, number, number] }
      : null;
  const points = [...frame.lights, ...cart]
    .filter((x) => (x.kind === "point" || x.kind === "spot") && x.position)
    .map((x) => ({ position: x.position!, color: x.color.map((c) => (c * x.intensity) / brightness) as [number, number, number], range: x.range && x.range > 0 ? x.range : 8 }));
  return { sun, points };
}

/** A relight's lights, rounded to what's worth relighting for (a sun turned about half a degree, a light moved 5 cm). */
export function bounceSignature(lights: BounceLights): string {
  const r = (v: number, s: number) => Math.round(v * s);
  const sun = lights.sun ? `${lights.sun.direction.map((v) => r(v, 100)).join(",")}:${lights.sun.color.map((v) => r(v, 50)).join(",")}` : "-";
  return `${sun}|${lights.points.map((p) => `${p.position.map((v) => r(v, 20)).join(",")}:${p.color.map((v) => r(v, 50)).join(",")}:${r(p.range, 10)}`).join(";")}`;
}
