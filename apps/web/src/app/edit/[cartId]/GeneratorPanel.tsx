"use client";

/**
 * The Generate panel, shared by the Map and Voxel tabs.
 *
 * It renders itself entirely from a generator's declarative {@link ParamSpec}
 * list, so it knows nothing about terrain, caves, dungeons or mazes — adding a
 * generator to the registry gives it working controls here with no change to
 * this file. The only thing a caller supplies beyond the generator list is what
 * "Generate" should do with the chosen values.
 *
 * Values are held by the caller so a run and a re-run use the same settings, and
 * so the seed survives switching tabs.
 */

import { useState } from "react";
import type { GeneratorValues, ParamSpec } from "@cartbox/editor";
import { defaultValues } from "@cartbox/editor";

import styles from "./editor.module.css";

/** The subset of a generator this panel needs — either dimension satisfies it. */
export interface PanelGenerator {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly params: readonly ParamSpec[];
}

interface GeneratorPanelProps {
  /** The generators to choose between; the panel shows one at a time. */
  generators: readonly PanelGenerator[];
  selectedId: string;
  onSelect: (id: string) => void;
  values: GeneratorValues;
  onValuesChange: (values: GeneratorValues) => void;
  /** Run the selected generator with the current values. */
  onGenerate: () => void;
  /** Result of the last run, shown under the button; null before the first. */
  note: string | null;
  /** Disables Generate with this reason when the target cannot accept a run. */
  disabledReason?: string | null;
  /** Optional extra controls (a class mapping, a preview) rendered above the button. */
  children?: React.ReactNode;
}

/** Highest seed the randomize button will pick, matching the seed param's range. */
const MAX_RANDOM_SEED = 9999;

/** Format a value for display according to its spec. */
function formatValue(spec: ParamSpec, value: number): string {
  switch (spec.format) {
    case "percent":
      return `${Math.round(value * 100)}%`;
    case "decimal":
      return value.toFixed(2);
    default:
      return String(Math.round(value));
  }
}

export function GeneratorPanel({
  generators,
  selectedId,
  onSelect,
  values,
  onValuesChange,
  onGenerate,
  note,
  disabledReason = null,
  children,
}: GeneratorPanelProps) {
  const generator = generators.find((entry) => entry.id === selectedId) ?? generators[0]!;
  const [showAdvanced, setShowAdvanced] = useState(false);

  // The seed always shows; the rest fold away so the panel stays compact until
  // the user actually wants to tune a run.
  const seedSpec = generator.params.find((param) => param.key === "seed");
  const tunables = generator.params.filter((param) => param.key !== "seed");

  const setValue = (key: string, value: number) => onValuesChange({ ...values, [key]: value });

  const selectGenerator = (id: string) => {
    const next = generators.find((entry) => entry.id === id);
    if (!next) return;
    onSelect(id);
    // Each generator has its own parameters; carry the seed across so switching
    // generators explores the same "world" rather than resetting it.
    const seed = typeof values.seed === "number" ? values.seed : undefined;
    onValuesChange({ ...defaultValues(next.params), ...(seed === undefined ? {} : { seed }) });
  };

  const readValue = (spec: ParamSpec): number => {
    const raw = values[spec.key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : spec.value;
  };

  return (
    <div className={styles.generatorPanel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>Generate</span>
        <span className={styles.panelMeta}>{generators.length} generators</span>
      </div>

      <select
        className={styles.fxSelect}
        value={generator.id}
        onChange={(event) => selectGenerator(event.target.value)}
        aria-label="Generator"
      >
        {generators.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
      <p className={styles.generatorHint}>{generator.description}</p>

      {seedSpec && (
        <div className={styles.generatorSeed}>
          <label className={styles.groupLabel} htmlFor="generator-seed">
            Seed
          </label>
          <input
            id="generator-seed"
            className={styles.generatorSeedInput}
            type="number"
            min={seedSpec.min}
            max={seedSpec.max}
            step={seedSpec.step}
            value={Math.round(readValue(seedSpec))}
            onChange={(event) => setValue("seed", Number(event.target.value))}
            title={seedSpec.hint}
          />
          <button
            type="button"
            className={styles.rendererToggle}
            onClick={() => setValue("seed", 1 + Math.floor(Math.random() * MAX_RANDOM_SEED))}
            title="Pick a new random seed"
          >
            🎲
          </button>
        </div>
      )}

      {tunables.length > 0 && (
        <button
          type="button"
          className={styles.rendererToggle}
          onClick={() => setShowAdvanced((open) => !open)}
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? "Hide settings" : `Settings · ${tunables.length}`}
        </button>
      )}

      {showAdvanced &&
        tunables.map((spec) => (
          <div key={spec.key} className={styles.fxParam} title={spec.hint}>
            <span className={styles.fxParamLabel}>{spec.label}</span>
            <input
              type="range"
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={readValue(spec)}
              onChange={(event) => setValue(spec.key, Number(event.target.value))}
              aria-label={spec.label}
            />
            <span className={styles.fxParamValue}>{formatValue(spec, readValue(spec))}</span>
          </div>
        ))}

      {children}

      <button
        type="button"
        className={styles.generateBtn}
        onClick={onGenerate}
        disabled={disabledReason !== null}
        title={disabledReason ?? `Generate with ${generator.label}`}
      >
        Generate
      </button>
      {(disabledReason || note) && <p className={styles.generatorHint}>{disabledReason ?? note}</p>}
    </div>
  );
}
