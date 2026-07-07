/**
 * Export planning for the desktop editor.
 *
 * "One-click export to web / desktop / mobile" is the headline feature over
 * PICO-8. The actual artifact production (native packaging, WASM bundling) runs
 * in the Tauri Rust backend; this module owns the pure planning step — turning a
 * cartridge and a set of chosen targets into a concrete list of artifacts to
 * build — so the decision logic is testable without a build toolchain.
 */

/** Platforms a cartridge can be exported to. */
export type ExportTarget = "web" | "windows" | "mac" | "linux" | "mobile-web";

/** One artifact the backend should produce. */
export interface ExportArtifact {
  target: ExportTarget;
  /** Output filename, derived from the cartridge slug. */
  filename: string;
  /** How the backend should build it. */
  kind: "html-bundle" | "native-binary" | "pwa";
}

const ARTIFACT_SPEC: Record<ExportTarget, { kind: ExportArtifact["kind"]; extension: string }> = {
  web: { kind: "html-bundle", extension: "html" },
  "mobile-web": { kind: "pwa", extension: "zip" },
  windows: { kind: "native-binary", extension: "exe" },
  mac: { kind: "native-binary", extension: "app" },
  linux: { kind: "native-binary", extension: "AppImage" },
};

/**
 * Builds the list of artifacts to produce for a cartridge.
 *
 * @param cartSlug URL-safe cartridge slug, used as the artifact base name.
 * @param targets Chosen export targets; duplicates are ignored.
 * @returns One {@link ExportArtifact} per unique, supported target.
 * @throws {RangeError} if no targets are supplied.
 */
export function buildExportPlan(cartSlug: string, targets: ExportTarget[]): ExportArtifact[] {
  if (targets.length === 0) {
    throw new RangeError("At least one export target is required");
  }

  const uniqueTargets = [...new Set(targets)];
  return uniqueTargets.map((target) => {
    const spec = ARTIFACT_SPEC[target];
    return {
      target,
      kind: spec.kind,
      filename: `${cartSlug}.${spec.extension}`,
    };
  });
}
