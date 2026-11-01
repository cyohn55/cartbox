/**
 * Weather on the AAA tier (AAA_FIDELITY_ROADMAP.md F5e): the WGSL the
 * linear-light scene shader lays over every surface, mirroring weather.ts in
 * @cartbox/editor term for term (the hashes bit for bit), and the frame's
 * terms it reads.
 */

import { PUDDLE_ROUGHNESS, SNOW_ALBEDO, SNOW_ROUGHNESS, WATER_F0, weatherActive, type Weather } from "@cartbox/editor";

/** Floats the weather takes in the frame's uniforms: wetness, puddles, snow, rain; snow line, seconds, patch size, on. */
export const WEATHER_FRAME_FLOATS = 8;

export function packWeatherFrame(weather: Weather | null | undefined, time: number, out = new Float32Array(WEATHER_FRAME_FLOATS)): Float32Array {
  out.fill(0);
  if (!weather || !weatherActive(weather)) return out;
  out.set([weather.wetness, weather.puddles, weather.snow, weather.rain], 0);
  // The rain's clock wraps every ten minutes (its rings' cycle divides it), so a float32 never sees a large time.
  out.set([weather.snowLine, time % 600, weather.scale, 1], 4);
  return out;
}

/** The WGSL: `frame.weather0` and `frame.weather1` hold {@link packWeatherFrame}'s terms. */
export const WEATHER_WGSL = /* wgsl */ `
fn wHash2(x: f32, y: f32) -> f32 {
  var h = (bitcast<u32>(i32(x)) * 0x8da6b343u) ^ (bitcast<u32>(i32(y)) * 0xd8163841u);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return f32(h ^ (h >> 16u)) / 4294967296.0;
}
fn wNoise2(x: f32, y: f32) -> f32 {
  let ix = floor(x);
  let iy = floor(y);
  let fx = x - ix;
  let fy = y - iy;
  let sx = fx * fx * (3.0 - 2.0 * fx);
  let sy = fy * fy * (3.0 - 2.0 * fy);
  let a = wHash2(ix, iy);
  let b = wHash2(ix + 1.0, iy);
  let c = wHash2(ix, iy + 1.0);
  let d = wHash2(ix + 1.0, iy + 1.0);
  return (a + (b - a) * sx) * (1.0 - sy) + (c + (d - c) * sx) * sy;
}
fn wPatch(x: f32, z: f32, scale: f32) -> f32 {
  return (wNoise2(x / scale, z / scale) * 2.0 + wNoise2(x / scale * 2.7 + 13.1, z / scale * 2.7 + 7.7)) / 3.0;
}
fn wExposure(sky: f32) -> f32 { return smoothstep(0.35, 0.85, sky); }
fn wPuddle(x: f32, z: f32, ny: f32, sky: f32) -> f32 {
  let puddles = frame.weather0.y;
  if (puddles <= 0.0) { return 0.0; }
  let flat = smoothstep(0.92, 0.985, ny);
  if (flat <= 0.0) { return 0.0; }
  let hollow = 1.0 - wPatch(x, z, frame.weather1.z);
  return flat * wExposure(sky) * smoothstep(1.0 - puddles, 1.0 - puddles + 0.12, hollow);
}
fn wSnow(x: f32, y: f32, z: f32, ny: f32, sky: f32) -> f32 {
  let snow = frame.weather0.z;
  if (snow <= 0.0 || y < frame.weather1.x) { return 0.0; }
  let facing = smoothstep(0.55 - 0.35 * snow, 0.8 - 0.3 * snow, ny);
  if (facing <= 0.0) { return 0.0; }
  let cover = wPatch(x + 101.0, z + 37.0, frame.weather1.z);
  return facing * wExposure(sky) * smoothstep(1.0 - snow * 1.15, 1.0 - snow * 1.15 + 0.15, cover);
}
// Rain's rings in a puddle: the slope they add (dh/dx, dh/dz); mirrors rainRipples.
fn wRipples(x: f32, z: f32, time: f32, rain: f32) -> vec2<f32> {
  if (rain <= 0.0) { return vec2<f32>(0.0); }
  var g = vec2<f32>(0.0);
  for (var layer = 0; layer < 2; layer = layer + 1) {
    let size = 0.4;
    let ox = f32(layer) * 0.21;
    let oz = f32(layer) * 0.13;
    let cx = floor((x + ox) / size);
    let cz = floor((z + oz) / size);
    for (var j = -1; j <= 1; j = j + 1) {
      for (var i = -1; i <= 1; i = i + 1) {
        let ix = cx + f32(i);
        let iz = cz + f32(j);
        let seed = wHash2(ix + f32(layer) * 1013.0, iz);
        let px = (ix + 0.2 + 0.6 * wHash2(ix, iz + 77.0)) * size - ox;
        let pz = (iz + 0.2 + 0.6 * wHash2(ix + 31.0, iz)) * size - oz;
        let phase = time / 0.6 + seed * 10.0;
        let age = phase - floor(phase);
        if (wHash2(ix + floor(phase) * 7.0, iz + f32(layer)) > rain) { continue; }
        let dx = x - px;
        let dz = z - pz;
        let d = sqrt(dx * dx + dz * dz);
        let ring = d - age * 0.25;
        if (abs(ring) > 0.04 || d < 1e-5) { continue; }
        let amplitude = (1.0 - age) * cos(ring / 0.04 * 3.14159265 * 0.5);
        let slope = amplitude * sin(ring / 0.04 * 3.14159265) * 0.6;
        g = g + vec2<f32>(slope * dx / d, slope * dz / d);
      }
    }
  }
  return g;
}
struct WeatherOut { albedo: vec3<f32>, rough: f32, metallic: f32, N: vec3<f32>, puddle: f32, snow: f32 };
// The weather over a surface point (mirrors weatherSurface, f0 aside: the caller mixes it toward water's and snow's).
fn weatherSurface(p: vec3<f32>, n: vec3<f32>, sky: f32, albedo0: vec3<f32>, rough0: f32, metallic0: f32) -> WeatherOut {
  let open = wExposure(sky);
  let wet = frame.weather0.x * open;
  let porosity = clamp((rough0 - 0.1) / 0.6, 0.0, 1.0) * (1.0 - metallic0);
  let k = wet * porosity;
  var albedo = pow(max(albedo0, vec3<f32>(0.0)), vec3<f32>(1.0 + k)) * (1.0 - 0.25 * k);
  var rough = rough0 + (min(rough0, 0.3) - rough0) * wet;
  var metallic = metallic0;
  var N = n;
  let puddle = wPuddle(p.x, p.z, n.y, sky);
  if (puddle > 0.0) {
    let g = wRipples(p.x, p.z, frame.weather1.y, frame.weather0.w);
    let flat = normalize(vec3<f32>(-g.x, 1.0, -g.y));
    N = normalize(N + (flat - N) * puddle);
    albedo = albedo * (1.0 - 0.35 * puddle);
    rough = rough + (${PUDDLE_ROUGHNESS} - rough) * puddle;
    metallic = metallic * (1.0 - puddle);
  }
  let snow = wSnow(p.x, p.y, p.z, n.y, sky);
  if (snow > 0.0) {
    albedo = albedo + (vec3<f32>(${SNOW_ALBEDO.join(", ")}) - albedo) * snow;
    rough = rough + (${SNOW_ROUGHNESS} - rough) * snow;
    metallic = metallic * (1.0 - snow);
    N = normalize(N * (1.0 - snow) + vec3<f32>(0.0, snow, 0.0));
  }
  return WeatherOut(albedo, rough, metallic, N, puddle, snow);
}
const WATER_F0 = ${WATER_F0};
`;
