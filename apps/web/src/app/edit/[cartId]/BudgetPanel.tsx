"use client";

/**
 * Per-device budgets in the Mesh tab (EDITOR_PRO_ROADMAP.md P8): pick an
 * iPhone, an iPad or a desktop, and see what the scene costs against what it
 * may — triangles and draw calls at full detail, mesh and texture memory, and
 * its download — with each line over budget in red, and the smallest device
 * it fits. The viewport's readout checks what each frame actually draws
 * against the same budget. See deviceBudgets.ts in @cartbox/editor and
 * sceneBudget.ts.
 */

import { useMemo } from "react";

import { BUDGET_DEVICES, DEVICE_BUDGETS, checkBudget, smallestFit, type BudgetDevice } from "@cartbox/editor";

import { type MeshSidecar } from "@/lib/meshSidecar";
import { sceneLoadOf } from "@/lib/sceneBudget";
import { RailGroup, RailHint, SegmentedControl } from "./railControls";

const KEY = "cartbox.budgetDevice";

/** The device the budgets are checked against, remembered in this browser. */
export function storedBudgetDevice(): BudgetDevice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "iphone" || v === "ipad" || v === "desktop" ? v : "iphone";
  } catch {
    return "iphone";
  }
}

export function storeBudgetDevice(device: BudgetDevice): void {
  try {
    window.localStorage.setItem(KEY, device);
  } catch {
    // Private mode: it lasts this visit.
  }
}

export function BudgetPanel({ sidecar, device, onDevice }: { sidecar: MeshSidecar; device: BudgetDevice; onDevice: (d: BudgetDevice) => void }) {
  const load = useMemo(() => sceneLoadOf(sidecar), [sidecar]);
  const lines = checkBudget(load, device);
  const fits = smallestFit(load);
  return (
    <RailGroup label="Budgets" advanced>
      <SegmentedControl
        label="Device"
        ariaLabel="Budget device"
        selected={device}
        onSelect={(id) => {
          storeBudgetDevice(id);
          onDevice(id);
        }}
        options={BUDGET_DEVICES.map((d) => ({ id: d, label: DEVICE_BUDGETS[d].label }))}
      />
      {lines.map((line) => (
        <div key={line.key} style={{ margin: "4px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: line.over ? "#ff6b6b" : undefined }}>
            <span>{line.label}</span>
            <span>{line.text}</span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.1)" }} aria-hidden>
            <div style={{ width: `${Math.min(100, line.share * 100)}%`, height: "100%", borderRadius: 2, background: line.over ? "#ff6b6b" : line.share > 0.8 ? "#ffc857" : "#5fd38d" }} />
          </div>
        </div>
      ))}
      <RailHint>
        {fits ? `Fits ${DEVICE_BUDGETS[fits].label === "Desktop" ? "a desktop" : `an ${DEVICE_BUDGETS[fits].label}`} and up.` : "Over even a desktop's budget."} Counted at full detail; the viewport&apos;s readout checks what each
        frame draws (with levels of detail, culling and foliage) and its frame time.
      </RailHint>
    </RailGroup>
  );
}
