"use client";

/**
 * The playtest profiler (ENGINE_ROADMAP.md, Phase 5): where the last second of
 * frames spent their time against the frame budget, what the 3D scene drew,
 * memory, and multiplayer traffic. Reads the player's snapshot (see
 * debug/profiler.ts in @cartbox/player) a couple of times a second.
 */

import type { ProfileSection, ProfileSnapshot } from "@cartbox/player";

import { formatBytes } from "./assetUploads";
import { PARTS, budgetBar } from "./profilerView";

const RENDER_PASSES: { section: ProfileSection; label: string }[] = [
  { section: "shadow", label: "shadow map" },
  { section: "sky", label: "sky" },
  { section: "scene", label: "3D scene" },
];

const ms = (v: number) => (v < 0.05 ? "0" : v < 10 ? v.toFixed(2) : v.toFixed(1));
const count = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : String(Math.round(v)));

export function ProfilerPanel({ profile, budgetMs }: { profile: ProfileSnapshot | null; budgetMs: number }) {
  if (!profile || profile.frames === 0) {
    return (
      <aside aria-label="Profiler" style={panelStyle}>
        <strong>Profiler</strong>
        <span style={{ opacity: 0.7 }}>Measuring… (frames are only counted while the cart runs)</span>
      </aside>
    );
  }
  const over = profile.total.avg > budgetMs;
  const render = profile.render;
  return (
    <aside aria-label="Profiler" style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>Profiler</strong>
        <span className="data" style={{ color: over ? "#ff8a8a" : undefined }} title="Average main-thread work per frame against the time one frame has">
          {ms(profile.total.avg)} / {ms(budgetMs)} ms
        </span>
      </div>
      <div aria-label="Frame budget" style={{ display: "flex", height: 10, borderRadius: 4, overflow: "hidden", background: "rgba(255,255,255,0.08)" }}>
        {budgetBar(profile, budgetMs).map(({ section, fraction }) => (
          <span key={section} style={{ width: `${fraction * 100}%`, background: PARTS.find((p) => p.section === section)!.color }} />
        ))}
      </div>

      <table className="data" style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ opacity: 0.6, textAlign: "right" }}>
            <th style={{ textAlign: "left", fontWeight: 400 }}>CPU per frame</th>
            <th style={{ fontWeight: 400 }}>avg ms</th>
            <th style={{ fontWeight: 400 }}>max</th>
          </tr>
        </thead>
        <tbody>
          {PARTS.map((part) => (
            <Row key={part.section} label={part.label} hint={part.hint} color={part.color} stats={profile.sections[part.section]} />
          ))}
          {render &&
            RENDER_PASSES.map((pass) => <Row key={pass.section} label={`  ${pass.label}`} stats={profile.sections[pass.section]} indent />)}
          <Row label="Total" stats={profile.total} bold />
        </tbody>
      </table>

      {render && (
        <Group title={`GPU · ${render.backend}`}>
          <Stat label="Draw calls" value={count(render.drawCalls)} />
          <Stat label="Objects" value={count(render.instances)} />
          <Stat label="Triangles" value={count(render.triangles)} />
          <Stat
            label="Scene pass"
            value={render.gpuMs !== null ? `${ms(render.gpuMs)} ms` : render.backend === "software" ? "on the CPU" : "not timed here"}
            hint={render.gpuMs === null && render.backend !== "software" ? "This browser doesn't let pages time the GPU" : undefined}
          />
        </Group>
      )}

      <Group title="Memory">
        <Stat label="Engine" value={formatBytes(profile.memory.wasm)} hint="The console's WebAssembly memory" />
        {profile.memory.scene !== null && <Stat label="3D scene" value={`~${formatBytes(profile.memory.scene)}`} hint="Geometry, textures and render targets (estimated)" />}
        {profile.memory.jsHeap !== null && <Stat label="Page heap" value={formatBytes(profile.memory.jsHeap)} hint="The whole page's JavaScript heap, editor included" />}
      </Group>

      <Group title="Network">
        {profile.net ? (
          <>
            <Stat label="Sent" value={`${formatBytes(profile.net.sentPerSecond)}/s`} hint={`${formatBytes(profile.net.sent)} in all`} />
            <Stat label="Received" value={`${formatBytes(profile.net.receivedPerSecond)}/s`} hint={`${formatBytes(profile.net.received)} in all`} />
          </>
        ) : (
          <span style={{ opacity: 0.7 }}>Offline in the playtest</span>
        )}
      </Group>
    </aside>
  );
}

const panelStyle: React.CSSProperties = { width: 300, maxHeight: 460, overflowY: "auto", fontSize: 12, display: "grid", gap: 8, alignContent: "start" };

function Row({ label, hint, color, stats, indent, bold }: { label: string; hint?: string; color?: string; stats: { avg: number; max: number }; indent?: boolean; bold?: boolean }) {
  return (
    <tr title={hint} style={{ textAlign: "right", opacity: indent ? 0.75 : 1, fontWeight: bold ? 650 : 400 }}>
      <td style={{ textAlign: "left", whiteSpace: "pre", paddingLeft: indent ? 14 : 0 }}>
        {color && <span aria-hidden style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: color, marginRight: 6 }} />}
        {label.trim()}
      </td>
      <td>{ms(stats.avg)}</td>
      <td>{ms(stats.max)}</td>
    </tr>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <span style={{ opacity: 0.6 }}>{title}</span>
      {children}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint} style={{ display: "flex", justifyContent: "space-between" }}>
      <span>{label}</span>
      <span className="data">{value}</span>
    </div>
  );
}
