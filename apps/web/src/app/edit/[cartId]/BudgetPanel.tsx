"use client";

/**
 * Per-device budgets in the Mesh tab (EDITOR_PRO_ROADMAP.md P8): pick an
 * iPhone, an iPad or a desktop, and see what the scene costs against what it
 * may — triangles and draw calls at full detail, mesh and texture memory, and
 * its download — with each line over budget in red, and the smallest device
 * it fits. The viewport's readout checks what each frame actually draws
 * against the same budget. See deviceBudgets.ts in @cartbox/editor and
 * sceneBudget.ts.
 *
 * An `aaa` cart checks the AAA tier's table instead (AAA_PRODUCTION_ROADMAP.md
 * Q2): four devices, a desktop's integrated GPU among them, with the quality
 * level and resolution each targets, marked provisional until measured.
 */

import { useMemo } from "react";

import { AAA_BUDGETS_PROVISIONAL, AAA_DEVICE_BUDGETS, budgetDevices, checkBudget, deviceBudget, fitSummary, smallestFit, tierDevice, type AaaBudgetDevice, type BudgetTier } from "@cartbox/editor";

import { type MeshSidecar } from "@/lib/meshSidecar";
import { sceneLoadOf } from "@/lib/sceneBudget";
import { RailGroup, RailHint, SegmentedControl } from "./railControls";

const KEY = "cartbox.budgetDevice";

/** The device the budgets are checked against, remembered in this browser. */
export function storedBudgetDevice(): AaaBudgetDevice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "iphone" || v === "ipad" || v === "integrated" || v === "desktop" ? v : "iphone";
  } catch {
    return "iphone";
  }
}

export function storeBudgetDevice(device: AaaBudgetDevice): void {
  try {
    window.localStorage.setItem(KEY, device);
  } catch {
    // Private mode: it lasts this visit.
  }
}

export function BudgetPanel({
  sidecar,
  device,
  tier = "fantasy",
  onDevice,
}: {
  sidecar: MeshSidecar;
  device: AaaBudgetDevice;
  tier?: BudgetTier;
  onDevice: (d: AaaBudgetDevice) => void;
}) {
  const load = useMemo(() => sceneLoadOf(sidecar), [sidecar]);
  const selected = tierDevice(device, tier);
  const lines = checkBudget(load, selected, tier);
  const fits = smallestFit(load, tier);
  const aaa = tier === "aaa" ? AAA_DEVICE_BUDGETS[selected] : null;
  return (
    <RailGroup label="Budgets" advanced>
      <SegmentedControl
        label="Device"
        ariaLabel="Budget device"
        selected={selected}
        onSelect={(id) => {
          storeBudgetDevice(id);
          onDevice(id);
        }}
        options={budgetDevices(tier).map((d) => ({ id: d, label: deviceBudget(d, tier).label }))}
      />
      {aaa && (
        <RailHint>
          AAA {aaa.level} at {aaa.resolution}, {Math.round(1000 / aaa.frameMs)} fps.
          {AAA_BUDGETS_PROVISIONAL ? " Provisional: set from the tier's targets until measured on this class of hardware." : ""}
        </RailHint>
      )}
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
        {fitSummary(fits, tier)} Counted at full detail; the viewport&apos;s readout checks what each
        frame draws (with levels of detail, culling and foliage) and its frame time.
      </RailHint>
    </RailGroup>
  );
}
