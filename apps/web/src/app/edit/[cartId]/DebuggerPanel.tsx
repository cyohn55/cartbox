"use client";

/**
 * The playtest's Lua debugger panel (ENGINE_ROADMAP.md, Phase 5). While the
 * cart is stopped at a breakpoint: where (with the code around it), how to go
 * on (continue, step over / into / out), the call stack, the stopped
 * function's locals and upvalues, and the watch expressions' values there
 * (evaluated with those in scope, then globals).
 * While it runs: the breakpoints and watches, ready for the next stop.
 */

import { useState } from "react";

import type { DebugStep, PauseInfo } from "@cartbox/player";

import styles from "./editor.module.css";
import { codeExcerpt } from "./debuggerView";

interface DebuggerPanelProps {
  pause: PauseInfo | null;
  code: string;
  breakpoints: readonly number[];
  onToggleBreakpoint: (line: number) => void;
  watches: readonly string[];
  onWatchesChange: (watches: string[]) => void;
  onStep: (step: DebugStep) => void;
}

const panelStyle: React.CSSProperties = { width: 320, maxHeight: 460, overflowY: "auto", fontSize: 12, display: "grid", gap: 8, alignContent: "start" };

export function DebuggerPanel({ pause, code, breakpoints, onToggleBreakpoint, watches, onWatchesChange, onStep }: DebuggerPanelProps) {
  const [draft, setDraft] = useState("");
  const addWatch = () => {
    if (!draft.trim()) return;
    onWatchesChange([...watches, draft.trim()]);
    setDraft("");
  };
  return (
    <aside aria-label="Debugger" style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Debugger</strong>
        <span style={{ opacity: 0.75 }}>{pause ? `stopped at line ${pause.line}` : breakpoints.length > 0 ? "running" : "no breakpoints"}</span>
      </div>

      {pause && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <button type="button" className="cbx-btn cbx-btn-accent" onClick={() => onStep("continue")} title="Run to the next breakpoint (F8)">
            Continue
          </button>
          <button type="button" className="cbx-btn" onClick={() => onStep("over")} title="Run this line, stopping at the next one (F10)">
            Step over
          </button>
          <button type="button" className="cbx-btn" onClick={() => onStep("into")} title="Stop inside the function this line calls (F11)">
            Into
          </button>
          <button type="button" className="cbx-btn" onClick={() => onStep("out")} title="Run until this function returns (Shift+F11)">
            Out
          </button>
        </div>
      )}

      {pause && (
        <pre aria-label="Code at the stop" className="data" style={{ margin: 0, padding: 4, borderRadius: 6, background: "rgba(255,255,255,0.04)" }}>
          {codeExcerpt(code, pause.line).map(({ line, text }) => (
            <div key={line} style={{ background: line === pause.line ? "rgba(255, 205, 117, 0.18)" : undefined, whiteSpace: "pre-wrap", wordBreak: "break-all", paddingLeft: 40, textIndent: -40 }}>
              <span
                role="button"
                tabIndex={0}
                aria-label={`Breakpoint on line ${line}`}
                aria-pressed={breakpoints.includes(line)}
                onClick={() => onToggleBreakpoint(line)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onToggleBreakpoint(line)}
                style={{ display: "inline-block", width: 34, textAlign: "right", paddingRight: 6, cursor: "pointer", color: breakpoints.includes(line) ? "#e5484d" : undefined, opacity: breakpoints.includes(line) ? 1 : 0.5 }}
              >
                {breakpoints.includes(line) ? "●" : ""}
                {line}
              </span>
              {text}
            </div>
          ))}
        </pre>
      )}

      {pause && pause.stack.length > 0 && (
        <Group title="Call stack">
          {pause.stack.map((frame, i) => (
            <div key={i} className="data" style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{frame.name}</span>
              <span style={{ opacity: 0.7 }}>line {frame.line}</span>
            </div>
          ))}
        </Group>
      )}

      {pause && (pause.locals.length > 0 || pause.upvalues.length > 0) && (
        <Group title="Variables">
          {pause.locals.map((v) => (
            <Variable key={`l:${v.name}`} name={v.name} value={v.value} />
          ))}
          {pause.upvalues.map((v) => (
            <Variable key={`u:${v.name}`} name={v.name} value={v.value} hint="An upvalue: a local of an enclosing scope" dim />
          ))}
        </Group>
      )}

      <Group title="Watch">
        {watches.map((expr, i) => {
          const result = pause?.watches[i];
          return (
            <div key={`${i}:${expr}`} className="data" style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
              <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{expr}</span>
              <span style={{ flex: 1, minWidth: 0, textAlign: "right", color: result?.error ? "#ff8a8a" : undefined, wordBreak: "break-word" }}>{result ? result.value : "—"}</span>
              <button type="button" className={styles.rendererToggle} aria-label={`Remove watch ${expr}`} onClick={() => onWatchesChange(watches.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 4 }}>
          <input
            aria-label="New watch expression"
            placeholder="player.x, #enemies …"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addWatch()}
            style={{ flex: 1, minWidth: 0, padding: "4px 6px", borderRadius: 6 }}
          />
          <button type="button" className="cbx-btn" onClick={addWatch}>
            Add
          </button>
        </div>
      </Group>

      <Group title={`Breakpoints · ${breakpoints.length}`}>
        {breakpoints.length === 0 && <span style={{ opacity: 0.7 }}>Click a line number in the Code tab (or in the code shown here at a stop).</span>}
        {breakpoints.map((line) => (
          <div key={line} className="data" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span>
              <span style={{ color: "#e5484d" }}>●</span> line {line}
            </span>
            <button type="button" className={styles.rendererToggle} aria-label={`Remove breakpoint on line ${line}`} onClick={() => onToggleBreakpoint(line)}>
              ✕
            </button>
          </div>
        ))}
      </Group>
    </aside>
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

function Variable({ name, value, hint, dim }: { name: string; value: string; hint?: string; dim?: boolean }) {
  return (
    <div className="data" title={hint} style={{ display: "flex", gap: 8, opacity: dim ? 0.75 : 1 }}>
      <span style={{ flex: "0 0 auto" }}>{name}</span>
      <span style={{ flex: 1, minWidth: 0, textAlign: "right", wordBreak: "break-word" }}>{value}</span>
    </div>
  );
}
