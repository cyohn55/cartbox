"use client";

/**
 * Asset-supply panel for Tier C titles.
 *
 * The player picks files from their own copy of the game; this component hashes
 * them in the browser, identifies which supported release they belong to, and
 * stores the recognised ones in the Origin Private File System.
 *
 * Nothing here uploads. There is no network call in this component or anything
 * it imports — the bytes stay on the player's machine, which is what keeps the
 * platform a viewer of their game rather than a distributor of it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { manifestSizeBytes, type SupplyReport } from "@/lib/assetManifest";
import { ingestSuppliedFiles, isPlayable, reviewStoredAssets, type CandidateFile } from "@/lib/assetSupply";
import { OpfsAssetVault, VaultQuotaError } from "@/lib/assetVault";
import { manifestsForTitle } from "@/lib/titleManifests";

type Phase = "loading" | "idle" | "working" | "error";

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "unknown size";
  }
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function AssetSupply({ titleId, titleName }: { titleId: string; titleName: string }) {
  const manifests = useMemo(() => manifestsForTitle(titleId), [titleId]);
  const vault = useMemo(() => new OpfsAssetVault(), []);

  const [phase, setPhase] = useState<Phase>("loading");
  const [report, setReport] = useState<SupplyReport | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const current = await reviewStoredAssets(titleId, manifests, vault);
    setReport(current);
    setPhase("idle");
  }, [manifests, titleId, vault]);

  useEffect(() => {
    // OPFS is unavailable in some browsers and in private modes; say so rather
    // than leaving the panel stuck on "loading".
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      setMessage("This browser cannot store game data locally.");
      setPhase("error");
      return;
    }
    refresh().catch(() => {
      setMessage("Could not read local game data.");
      setPhase("error");
    });
  }, [refresh]);

  const onFilesPicked = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) {
        return;
      }
      setPhase("working");
      setMessage(null);
      try {
        const candidates: CandidateFile[] = await Promise.all(
          [...fileList].map(async (file) => ({
            name: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
          })),
        );
        const result = await ingestSuppliedFiles(titleId, candidates, manifests, vault);
        // Selecting a whole game folder is normal, so unrecognised files are only
        // worth reporting when *nothing* in the selection was recognised.
        if (result && result.stored.length === 0 && result.ignored.length > 0) {
          setMessage("None of those files belong to a supported release.");
        }
        await refresh();
      } catch (error) {
        if (error instanceof VaultQuotaError) {
          setMessage(
            `Not enough browser storage for this game (${formatBytes(error.requiredBytes)} needed). Free some space and try again.`,
          );
        } else {
          setMessage("Could not store those files.");
        }
        setPhase("error");
      }
    },
    [manifests, refresh, titleId, vault],
  );

  const onClear = useCallback(async () => {
    setPhase("working");
    await vault.clear(titleId);
    await refresh();
  }, [refresh, titleId, vault]);

  if (manifests.length === 0) {
    return <p>Supported releases for {titleName} have not been published yet.</p>;
  }

  if (phase === "loading") {
    return <p>Checking local game data…</p>;
  }

  const unverified = report?.status === "unverified-manifest";

  return (
    <section>
      <h2>Your game data</h2>

      {unverified ? (
        // An unverified manifest cannot confirm a match, so it must not accept
        // files either — saying so beats silently rejecting correct ones.
        <p>
          The supported-release list for {titleName} has not been verified yet, so files cannot be
          checked. This title is not playable until it is.
        </p>
      ) : (
        <>
          <p>
            {titleName} ships the engine only. Select the game files from your own copy
            {report ? ` of ${report.manifest.releaseLabel}` : ""} to play. They stay on this device
            and are never uploaded.
          </p>

          {report && (
            <>
              <p>
                {report.matched.length} of {report.manifest.files.length} files supplied
                {report.missing.length > 0 && ` · ${formatBytes(manifestSizeBytes(report.manifest))} total`}
              </p>

              {report.missing.length > 0 && (
                <ul>
                  {report.missing.map((file) => (
                    <li key={file.path}>Still needed: {file.path}</li>
                  ))}
                </ul>
              )}

              {isPlayable(report) && <p>All files present — ready to play.</p>}
            </>
          )}

          <input
            type="file"
            multiple
            disabled={phase === "working"}
            onChange={(event) => void onFilesPicked(event.target.files)}
            aria-label={`Select ${titleName} game files`}
          />
        </>
      )}

      {phase === "working" && <p>Checking files…</p>}
      {message && <p role="alert">{message}</p>}

      {report && report.matched.length > 0 && (
        <button type="button" onClick={() => void onClear()} disabled={phase === "working"}>
          Remove stored game data
        </button>
      )}
    </section>
  );
}
