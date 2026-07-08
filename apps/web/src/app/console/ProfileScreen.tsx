"use client";

/**
 * Profile tab: the player's avatar, their three featured clips (their own
 * picks, or the most recent replays until they pick — tap one to watch it
 * right here), and every achievement they've unlocked. EDIT opens a picker
 * over their recent replays. Guests get a sign-in prompt.
 */

import { useEffect, useRef, useState } from "react";
import { mount, parseReplay, type ModelId, type PlayerHandle } from "@cartbox/player";

import { authHeaders } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";
import { FEATURED_CLIP_LIMIT, resolveFeaturedClips } from "@/lib/consoleProfile";
import { AvatarPreview } from "@/app/profile/[handle]/AvatarPreview";

interface FeaturedClip {
  replayId: string;
  replayUrl: string;
  frameCount: number;
  cartTitle: string;
  cartUrl: string;
  engineUrl: string;
  modelId: string;
}

interface Unlock {
  title: string;
  description: string;
  points: number;
  unlockedAt: string;
}

interface MePayload {
  profile: { handle: string | null; displayName: string | null; avatar: unknown };
  clips: FeaturedClip[];
  recentClips: FeaturedClip[];
  featuredClipIds: string[];
  unlocks: Unlock[];
}

/** Inline replay viewer for the selected featured clip. */
function ClipStage({ clip }: { clip: FeaturedClip }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    let handle: PlayerHandle | undefined;
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(clip.replayUrl, { signal: controller.signal });
        const replay = parseReplay(await response.text());
        handle = mount(stage, {
          cartUrl: clip.cartUrl,
          engineUrl: clip.engineUrl,
          modelId: clip.modelId as ModelId,
          replay,
          autostart: true,
          scale: "fit",
          onError: () => setFailed(true),
        });
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      controller.abort();
      handle?.destroy();
    };
  }, [clip]);

  return (
    <div>
      <div ref={stageRef} style={{ aspectRatio: "240 / 136", background: "#050308", borderRadius: 8 }} />
      {failed && (
        <p className="os-error" role="alert">
          This clip could not be played.
        </p>
      )}
    </div>
  );
}

/**
 * Featured-clip picker: tap recent clips to build an ordered pick (1/2/3);
 * SAVE persists it, CLEAR returns the profile to its most-recent fallback.
 */
function FeaturedClipPicker({
  recentClips,
  initialIds,
  onSaved,
  onCancel,
}: {
  recentClips: FeaturedClip[];
  initialIds: string[];
  onSaved: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const [pickedIds, setPickedIds] = useState<string[]>(initialIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (replayId: string) => {
    setPickedIds((current) => {
      if (current.includes(replayId)) {
        return current.filter((id) => id !== replayId);
      }
      return current.length < FEATURED_CLIP_LIMIT ? [...current, replayId] : current;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/console/me/featured", {
        method: "PUT",
        headers: await authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ replayIds: pickedIds }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not save your picks.");
      }
      onSaved(pickedIds);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save your picks.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="featured-picker">
      <p className="os-card-body" style={{ margin: "0 0 8px" }}>
        Tap up to {FEATURED_CLIP_LIMIT} clips, in the order you want them shown.
      </p>
      <div className="os-grid">
        {recentClips.map((clip) => {
          const order = pickedIds.indexOf(clip.replayId);
          return (
            <button
              key={clip.replayId}
              type="button"
              className="os-grid-card"
              data-picked={order >= 0 || undefined}
              onClick={() => toggle(clip.replayId)}
            >
              <span className="os-grid-thumb-empty" aria-hidden>
                {order >= 0 ? <span className="os-pick-order">{order + 1}</span> : "▶"}
              </span>
              <span className="os-grid-meta">
                <span className="os-grid-title">{clip.cartTitle}</span>
                <span className="os-grid-sub">{clip.frameCount} frames</span>
              </span>
            </button>
          );
        })}
      </div>
      {error && (
        <p className="os-error" role="alert">
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="button" className="os-btn" onClick={save} disabled={saving}>
          {saving ? "…" : "SAVE"}
        </button>
        <button type="button" className="os-btn os-btn-ghost" onClick={() => setPickedIds([])}>
          CLEAR
        </button>
        <button type="button" className="os-btn os-btn-ghost" onClick={onCancel}>
          CANCEL
        </button>
      </div>
    </div>
  );
}

export function ProfileScreen({ guest }: { guest: boolean }) {
  const [me, setMe] = useState<MePayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [watchingClip, setWatchingClip] = useState<FeaturedClip | null>(null);
  const [pickingClips, setPickingClips] = useState(false);

  useEffect(() => {
    if (isStaticExport || guest) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/console/me", { headers: await authHeaders() });
        if (!response.ok) {
          throw new Error(`profile request failed: ${response.status}`);
        }
        const body = (await response.json()) as MePayload;
        if (!cancelled) {
          setMe(body);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guest]);

  if (guest || isStaticExport) {
    return (
      <div className="os-page" data-testid="profile-screen">
        <h2>PROFILE</h2>
        <div className="os-empty">
          {isStaticExport
            ? "Profiles live on the community server, which this demo build doesn't include."
            : "Sign in to build your player card: avatar, featured clips, and trophies."}
        </div>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="os-page" data-testid="profile-screen">
        <h2>PROFILE</h2>
        <div className="os-empty">Your profile could not be reached.</div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="os-page" data-testid="profile-screen">
        <h2>PROFILE</h2>
        <div className="os-loading">POLISHING TROPHIES…</div>
      </div>
    );
  }

  const totalPoints = me.unlocks.reduce((sum, unlock) => sum + unlock.points, 0);

  return (
    <div className="os-page" data-testid="profile-screen">
      <div className="os-profile-head">
        <AvatarPreview avatar={me.profile.avatar} size={56} />
        <div>
          <div className="os-profile-name">{me.profile.displayName ?? me.profile.handle ?? "Player"}</div>
          {me.profile.handle && <div className="os-profile-handle">@{me.profile.handle}</div>}
        </div>
      </div>

      <div className="os-section-title">
        FEATURED CLIPS
        {me.recentClips.length > 0 && !pickingClips && (
          <button
            type="button"
            className="os-auth-switch"
            style={{ marginLeft: 10, fontSize: 10, letterSpacing: "0.14em" }}
            onClick={() => setPickingClips(true)}
          >
            EDIT
          </button>
        )}
      </div>
      {pickingClips ? (
        <FeaturedClipPicker
          recentClips={me.recentClips}
          initialIds={me.featuredClipIds}
          onCancel={() => setPickingClips(false)}
          onSaved={(ids) => {
            setMe({
              ...me,
              featuredClipIds: ids,
              clips: resolveFeaturedClips(ids, me.recentClips),
            });
            setPickingClips(false);
            setWatchingClip(null);
          }}
        />
      ) : (
        <>
          {me.clips.length === 0 && (
            <div className="os-empty">Play something and submit a run — your best clips land here.</div>
          )}
          {watchingClip && <ClipStage clip={watchingClip} />}
          <div className="os-grid" style={{ marginTop: 8 }}>
            {me.clips.map((clip) => (
              <button
                key={clip.replayId}
                type="button"
                className="os-grid-card"
                onClick={() => setWatchingClip(watchingClip?.replayId === clip.replayId ? null : clip)}
              >
                <span className="os-grid-thumb-empty" aria-hidden>
                  ▶
                </span>
                <span className="os-grid-meta">
                  <span className="os-grid-title">{clip.cartTitle}</span>
                  <span className="os-grid-sub">{clip.frameCount} frames</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="os-section-title">
        ACHIEVEMENTS · {me.unlocks.length} · {totalPoints} PTS
      </div>
      {me.unlocks.length === 0 && <div className="os-empty">No trophies yet — go earn some.</div>}
      {me.unlocks.map((unlock, index) => (
        <div key={`${unlock.title}:${index}`} className="os-trophy">
          <span aria-hidden>🏆</span>
          <span>
            <strong>{unlock.title}</strong>
            {unlock.description && <> — {unlock.description}</>}
          </span>
          <span className="os-trophy-points">{unlock.points} pts</span>
        </div>
      ))}
    </div>
  );
}
