"use client";

/**
 * Relight Lab — an interactive view of the runtime material-smoothing toggle.
 * It relights a subject through the real player {@link createLightingLayer}
 * (WebGPU when available, WebGL otherwise) and lets you flip the supersample
 * factor that decides whether the 4-bit normal/material fields get de-banded.
 *
 * The stone wall's material is produced here by the editor's own
 * {@link deriveMaterials} pipeline — the same code the Assets tab runs — so this
 * is the genuine author→runtime path, not a mock. Preview-only, like the other
 * labs; nothing here is persisted.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  createLightingLayer,
  type BuiltLightingRenderer,
  type Light,
} from "@cartbox/player";
import {
  deriveMaterials,
  defaultMaterialDeriveParams,
  quantizeLevel,
  nearestDirection,
} from "@cartbox/editor";

/** A relightable subject: its size, RGBA albedo, and packed material G-buffer. */
interface Subject {
  readonly w: number;
  readonly h: number;
  /** RGBA; the alpha channel carries emissive (0 here — nothing self-lights). */
  readonly albedo: Uint8Array;
  /** RGBA: R = normal index, G/B/A = height/specular/roughness levels ×17. */
  readonly material: Uint8Array;
}

/** 4-bit ramp level (0..15) packed into a full byte, matching the runtime. */
const rampByte = (level: number): number => quantizeLevel(level) * 17;

/** Deterministic value noise, so the wall looks the same on every render. */
function hashNoise(seed: number): number {
  const value = Math.sin(seed) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * A stone-brick wall run through the real material-derivation pipeline: paint a
 * plausibly-lit brick albedo, then let {@link deriveMaterials} read normal/
 * height/specular/roughness back out of it, exactly as the editor does.
 */
function buildWallSubject(): Subject {
  const w = 220;
  const h = 140;
  const brickWidth = 44;
  const brickHeight = 20;
  const mortar = 3;
  const data = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y += 1) {
    const row = Math.floor(y / brickHeight);
    const rowOffset = (row % 2) * (brickWidth / 2);
    for (let x = 0; x < w; x += 1) {
      const brickColumn = Math.floor((x + rowOffset) / brickWidth);
      const inMortarX = (x + rowOffset) % brickWidth < mortar;
      const inMortarY = y % brickHeight < mortar;
      const i = (y * w + x) * 4;
      let red: number;
      let green: number;
      let blue: number;
      if (inMortarX || inMortarY) {
        const grey = 34 + hashNoise(x * 0.7 + y * 1.3) * 10;
        red = grey;
        green = grey * 1.02;
        blue = grey * 1.1;
      } else {
        const tint = hashNoise(brickColumn * 12.9 + row * 78.2);
        const base = 96 + tint * 70;
        const speckle = (hashNoise(x * 3.1 + y * 1.7) - 0.5) * 34;
        const edge =
          (x + rowOffset) % brickWidth > brickWidth - 5 || y % brickHeight > brickHeight - 5 ? -18 : 0;
        red = base + speckle * 1.1 + edge + 24;
        green = base * 0.72 + speckle * 0.8 + edge;
        blue = base * 0.55 + speckle * 0.6 + edge;
      }
      data[i] = red;
      data[i + 1] = green;
      data[i + 2] = blue;
      data[i + 3] = 255;
    }
  }

  const derived = deriveMaterials(
    { width: w, height: h, data },
    { ...defaultMaterialDeriveParams(), normalStrength: 3.5, heightContrast: 1.4 },
  );

  const albedo = new Uint8Array(w * h * 4);
  const material = new Uint8Array(w * h * 4);
  for (let pixel = 0; pixel < w * h; pixel += 1) {
    const rgba = pixel * 4;
    albedo[rgba] = data[rgba]!;
    albedo[rgba + 1] = data[rgba + 1]!;
    albedo[rgba + 2] = data[rgba + 2]!;
    albedo[rgba + 3] = 0; // no emissive
    const normal = pixel * 3;
    material[rgba] = nearestDirection([
      derived.normal[normal] ?? 0,
      derived.normal[normal + 1] ?? 0,
      derived.normal[normal + 2] ?? 1,
    ]);
    material[rgba + 1] = rampByte(derived.heightField[pixel] ?? 0);
    material[rgba + 2] = rampByte(derived.specular[pixel] ?? 0);
    material[rgba + 3] = rampByte(derived.roughness[pixel] ?? 0);
  }
  return { w, h, albedo, material };
}

/**
 * A sphere assembled from the sixteen normal directions: eight compass facets
 * around a flat cap. Its continuous curvature is where the direction
 * quantisation bands most visibly, so it makes the toggle's effect starkest.
 */
function buildSphereSubject(): Subject {
  const w = 168;
  const h = 168;
  const centerX = (w - 1) / 2;
  const centerY = (h - 1) / 2;
  const radius = w * 0.46;
  const albedo = new Uint8Array(w * h * 4);
  const material = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const dx = (x - centerX) / radius;
      const dy = (y - centerY) / radius;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > 1) {
        albedo[i] = 16;
        albedo[i + 1] = 18;
        albedo[i + 2] = 26;
        continue;
      }
      albedo[i] = 150;
      albedo[i + 1] = 120;
      albedo[i + 2] = 96;
      const angle = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);
      const direction = distanceSquared < 0.04 ? 0 : 1 + (Math.floor(angle * 8) % 8);
      material[i] = direction;
      material[i + 1] = rampByte((1 - distanceSquared) * 15);
      material[i + 2] = rampByte(11);
      material[i + 3] = rampByte(5);
    }
  }
  return { w, h, albedo, material };
}

type SubjectKey = "wall" | "sphere";

/** The two lights: a pointer-driven warm key and a fixed cool fill. */
function sceneFor(subject: Subject, light: { x: number; y: number }) {
  const lights: Light[] = [
    { x: light.x * subject.w, y: light.y * subject.h, z: 26, radius: subject.w * 1.5, color: [1.0, 0.84, 0.62] },
    { x: subject.w * 0.88, y: subject.h * 0.86, z: 20, radius: subject.w * 1.0, color: [0.34, 0.44, 0.72] },
  ];
  return {
    lights,
    ambient: 0.19,
    ambientColor: [0.42, 0.48, 0.62] as [number, number, number],
    bloom: false,
    shadows: false,
    smoothNormals: true,
    unlit: false,
  };
}

const SUPERSAMPLE_OPTIONS = [
  { value: 1, label: "Off", factor: "1×" },
  { value: 2, label: "On", factor: "2×" },
] as const;

const SUBJECT_OPTIONS: ReadonlyArray<{ value: SubjectKey; label: string }> = [
  { value: "wall", label: "Stone wall" },
  { value: "sphere", label: "Sphere" },
];

export function RelightLab() {
  const subjects = useMemo(
    () => ({ wall: buildWallSubject(), sphere: buildSphereSubject() }),
    [],
  );

  const [supersample, setSupersample] = useState(2);
  const [subjectKey, setSubjectKey] = useState<SubjectKey>("wall");
  const [readout, setReadout] = useState("Starting the renderer…");

  const stageRef = useRef<HTMLDivElement>(null);
  const builtRef = useRef<BuiltLightingRenderer | null>(null);
  const lightRef = useRef({ x: 0.32, y: 0.28 });

  const subject = subjects[subjectKey];

  // Draw the current subject with the current pointer-driven light. Cast is the
  // structural LightingScene the renderer expects (kept local to avoid importing
  // the type name).
  const draw = (built: BuiltLightingRenderer | null, current: Subject) => {
    built?.renderer.render(current.albedo, current.material, sceneFor(current, lightRef.current) as never);
  };

  // (Re)build the renderer whenever the factor or subject changes: the scene
  // target is sized at construction, so a new factor needs a fresh layer.
  useEffect(() => {
    let alive = true;
    const stage = stageRef.current;
    (async () => {
      builtRef.current?.renderer.dispose();
      builtRef.current = null;
      const built = await createLightingLayer(document, subject.w, subject.h, undefined, supersample);
      if (!alive) {
        built?.renderer.dispose();
        return;
      }
      builtRef.current = built;
      if (!built) {
        setReadout("Lighting isn’t available in this browser.");
        return;
      }
      built.canvas.className = "rl-render";
      if (stage) {
        stage.replaceChildren(built.canvas);
      }
      draw(built, subject);
      setReadout(`${built.renderer.backend.toUpperCase()} · ${subject.w}×${subject.h} · supersample ${supersample}×`);
    })();
    return () => {
      alive = false;
      builtRef.current?.renderer.dispose();
      builtRef.current = null;
    };
    // draw/subject are derived from these two; rebuilding on them is intended.
  }, [supersample, subjectKey, subject]);

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    lightRef.current = {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
    draw(builtRef.current, subject);
  };

  const onPointerLeave = () => {
    lightRef.current = { x: 0.32, y: 0.28 };
    draw(builtRef.current, subject);
  };

  return (
    <div className="rl-root">
      <style>{RELIGHT_CSS}</style>

      <div
        ref={stageRef}
        className="rl-stage"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      />
      <p className="rl-caption">Move your pointer across the frame to move the warm key light.</p>

      <div className="rl-controls">
        <div className="rl-field">
          <span className="rl-label">Supersample</span>
          <div className="rl-seg" role="group" aria-label="Supersample factor">
            {SUPERSAMPLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={supersample === option.value}
                onClick={() => setSupersample(option.value)}
              >
                {option.label}
                <span className="rl-mono">{option.factor}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="rl-field">
          <span className="rl-label">Subject</span>
          <div className="rl-seg" role="group" aria-label="Subject">
            {SUBJECT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={subjectKey === option.value}
                onClick={() => setSubjectKey(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="rl-readout">{readout}</p>

      <p className="rl-note">
        The stone wall’s normal, height, specular and roughness maps come straight from the editor’s
        <code> materialDerive</code> pipeline; the relight is the shipped runtime. With supersampling
        <b> Off (1×)</b> the light pass renders 1:1 with the material and the 16-direction normals read
        as faceted, stepped shading. <b>On (2×)</b> — the default — renders the light pass at double
        resolution so the smoothing engages, then resolves back down. The sphere shows it starkest.
      </p>
    </div>
  );
}

const RELIGHT_CSS = `
.rl-root{--rl-line:#272b34;--rl-ink:#cdd2dc;--rl-muted:#7c8492;--rl-accent:#f0a25c;--rl-accent-ink:#180f04;--rl-panel:#15171d;max-width:760px;}
.rl-stage{background:radial-gradient(120% 120% at 30% 20%,#191c24 0%,#0c0d11 70%);border:1px solid var(--rl-line);border-radius:14px;padding:22px;display:flex;justify-content:center;cursor:crosshair;box-shadow:0 18px 40px -24px rgba(0,0,0,.8);min-height:180px;}
.rl-render{width:min(100%,620px);height:auto;image-rendering:pixelated;border-radius:4px;display:block;}
.rl-caption{color:var(--rl-muted);font-size:13px;text-align:center;margin:12px 0 24px;}
.rl-controls{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-end;}
.rl-field{display:flex;flex-direction:column;gap:8px;}
.rl-label{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--rl-muted);}
.rl-seg{display:inline-flex;background:var(--rl-panel);border:1px solid var(--rl-line);border-radius:10px;padding:3px;gap:2px;}
.rl-seg button{appearance:none;border:0;background:transparent;color:var(--rl-muted);font:600 13px/1 system-ui,sans-serif;padding:9px 15px;border-radius:7px;cursor:pointer;transition:background .15s,color .15s;white-space:nowrap;}
.rl-seg button:hover{color:var(--rl-ink);}
.rl-seg button[aria-pressed=true]{background:var(--rl-accent);color:var(--rl-accent-ink);}
.rl-seg .rl-mono{font-family:ui-monospace,Menlo,monospace;opacity:.7;margin-left:6px;font-weight:500;}
.rl-seg button[aria-pressed=true] .rl-mono{opacity:.85;}
.rl-seg button:focus-visible{outline:2px solid var(--rl-accent);outline-offset:2px;}
.rl-readout{margin:24px 0 0;font:12px/1.4 ui-monospace,Menlo,monospace;color:var(--rl-muted);}
.rl-note{margin:20px 0 0;padding-top:20px;border-top:1px solid var(--rl-line);color:var(--rl-muted);font-size:13.5px;line-height:1.6;max-width:66ch;}
.rl-note b{color:var(--rl-ink);font-weight:600;}
.rl-note code{color:var(--rl-accent);}
`;
