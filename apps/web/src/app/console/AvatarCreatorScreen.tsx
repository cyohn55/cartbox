"use client";

/**
 * Voxel character creator: step through hairstyles, headgear, outfits, and
 * accessories (all suitably gamer — armor, robes, headsets, swords, capes),
 * pick palette colors, randomize, and save. Fully cursor-navigable. Signed-in
 * players persist to their profile; guests and the static demo keep the
 * avatar in this browser.
 */

import { useState } from "react";

import { authHeaders } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";
import {
  ACCESSORIES,
  COLOR_CHOICES,
  DEFAULT_VOXEL_AVATAR,
  HAIR_STYLES,
  HEADGEAR,
  OUTFITS,
  SKIN_TONES,
  normalizeVoxelAvatar,
  randomVoxelAvatar,
  type VoxelAvatarSpec,
} from "@/lib/voxelAvatar";
import { VoxelAvatarView } from "./VoxelAvatarView";

export const LOCAL_AVATAR_KEY = "cartbox.console.voxelAvatar";

/** The browser-stored avatar (guests / static demo), or the default. */
export function loadLocalVoxelAvatar(): VoxelAvatarSpec {
  try {
    const stored = window.localStorage.getItem(LOCAL_AVATAR_KEY);
    return stored ? normalizeVoxelAvatar(JSON.parse(stored)) : DEFAULT_VOXEL_AVATAR;
  } catch {
    return DEFAULT_VOXEL_AVATAR;
  }
}

interface AvatarCreatorScreenProps {
  initial: VoxelAvatarSpec;
  /** Signed-in players persist server-side; otherwise localStorage. */
  signedIn: boolean;
  onSaved: (spec: VoxelAvatarSpec) => void;
  onCancel: () => void;
}

interface PartRowProps {
  label: string;
  options: readonly string[];
  value: number;
  onChange: (next: number) => void;
}

function PartRow({ label, options, value, onChange }: PartRowProps) {
  const step = (delta: number) => onChange((value + delta + options.length) % options.length);
  return (
    <div className="os-part-row">
      <span className="os-part-label">{label}</span>
      <button type="button" className="os-part-step" aria-label={`Previous ${label}`} onClick={() => step(-1)}>
        ◀
      </button>
      <span className="os-part-value">{options[value]}</span>
      <button type="button" className="os-part-step" aria-label={`Next ${label}`} onClick={() => step(1)}>
        ▶
      </button>
    </div>
  );
}

interface SwatchRowProps {
  label: string;
  colors: readonly string[];
  value: number;
  onChange: (next: number) => void;
}

function SwatchRow({ label, colors, value, onChange }: SwatchRowProps) {
  return (
    <div className="os-part-row">
      <span className="os-part-label">{label}</span>
      <span className="os-swatch-row">
        {colors.map((color, index) => (
          <button
            key={color}
            type="button"
            className="os-swatch"
            style={{ background: color }}
            data-active={index === value}
            aria-label={`${label} color ${index + 1}`}
            onClick={() => onChange(index)}
          />
        ))}
      </span>
    </div>
  );
}

export function AvatarCreatorScreen({ initial, signedIn, onSaved, onCancel }: AvatarCreatorScreenProps) {
  const [spec, setSpec] = useState<VoxelAvatarSpec>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (partial: Partial<VoxelAvatarSpec>) => setSpec((current) => ({ ...current, ...partial }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      window.localStorage.setItem(LOCAL_AVATAR_KEY, JSON.stringify(spec));
      if (signedIn && !isStaticExport) {
        const response = await fetch("/api/console/me/avatar", {
          method: "PUT",
          headers: await authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ avatar: spec }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Could not save your avatar.");
        }
      }
      onSaved(spec);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save your avatar.");
      setSaving(false);
    }
  };

  return (
    <div className="os-page" data-console-nav data-testid="avatar-creator">
      <h2>CHARACTER CREATOR</h2>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <VoxelAvatarView spec={spec} size={150} />
      </div>

      <PartRow label="HAIR" options={HAIR_STYLES} value={spec.hair} onChange={(hair) => patch({ hair })} />
      <PartRow
        label="HEADGEAR"
        options={HEADGEAR}
        value={spec.headgear}
        onChange={(headgear) => patch({ headgear })}
      />
      <PartRow label="OUTFIT" options={OUTFITS} value={spec.outfit} onChange={(outfit) => patch({ outfit })} />
      <PartRow
        label="GEAR"
        options={ACCESSORIES}
        value={spec.accessory}
        onChange={(accessory) => patch({ accessory })}
      />

      <SwatchRow label="SKIN" colors={SKIN_TONES} value={spec.skin} onChange={(skin) => patch({ skin })} />
      <SwatchRow
        label="HAIR"
        colors={COLOR_CHOICES}
        value={spec.hairColor}
        onChange={(hairColor) => patch({ hairColor })}
      />
      <SwatchRow
        label="OUTFIT"
        colors={COLOR_CHOICES}
        value={spec.outfitColor}
        onChange={(outfitColor) => patch({ outfitColor })}
      />
      <SwatchRow
        label="ACCENT"
        colors={COLOR_CHOICES}
        value={spec.accentColor}
        onChange={(accentColor) => patch({ accentColor })}
      />

      {error && (
        <p className="os-error" role="alert">
          {error}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button type="button" className="os-btn" onClick={save} disabled={saving}>
          {saving ? "…" : "SAVE"}
        </button>
        <button type="button" className="os-btn os-btn-ghost" onClick={() => setSpec(randomVoxelAvatar())}>
          🎲 RANDOM
        </button>
        <button type="button" className="os-btn os-btn-ghost" data-console-back onClick={onCancel}>
          CANCEL
        </button>
      </div>
    </div>
  );
}
