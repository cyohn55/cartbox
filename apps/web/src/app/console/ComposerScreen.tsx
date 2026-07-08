"use client";

/**
 * Community composer: write a looking-for-players invite or a devlog from the
 * console. Opens as an overlay above the home feed. Invites can link any
 * published cartridge; devlogs link one of the author's own. Guests are asked
 * to sign in — posts carry your name.
 */

import { useEffect, useState, type FormEvent } from "react";

import { authHeaders } from "@/lib/supabase-browser";
import {
  POST_BODY_MAX,
  POST_TITLE_MAX,
  validateFeedPostInput,
  type ComposablePostKind,
} from "@/lib/consoleProfile";

interface LinkableCart {
  id: string;
  title: string;
}

interface ComposerScreenProps {
  guest: boolean;
  onPosted: () => void;
  onClose: () => void;
}

export function ComposerScreen({ guest, onPosted, onClose }: ComposerScreenProps) {
  const [kind, setKind] = useState<ComposablePostKind>("lfp");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [cartId, setCartId] = useState("");
  const [carts, setCarts] = useState<LinkableCart[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Linkable carts: any published cart for invites, your own for devlogs.
  useEffect(() => {
    if (guest) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (kind === "lfp") {
          const response = await fetch("/api/carts?limit=50");
          const data = (await response.json()) as { carts?: Array<{ id: string; title: string }> };
          if (!cancelled) {
            setCarts((data.carts ?? []).map((cart) => ({ id: cart.id, title: cart.title })));
          }
        } else {
          const response = await fetch("/api/console/me", { headers: await authHeaders() });
          const data = (await response.json()) as { library?: Array<{ id: string; title: string }> };
          if (!cancelled) {
            setCarts((data.library ?? []).map((cart) => ({ id: cart.id, title: cart.title })));
          }
        }
      } catch {
        if (!cancelled) {
          setCarts([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, guest]);

  // Switching post type may invalidate the linked cart (devlogs: own carts only).
  useEffect(() => {
    setCartId("");
  }, [kind]);

  if (guest) {
    return (
      <div className="os-stage os-auth" data-console-nav data-testid="composer-screen">
        <h2>POST TO THE COMMUNITY</h2>
        <p className="os-card-body">
          Posts carry your player name — sign in to invite players or share a devlog.
        </p>
        <button type="button" className="os-btn os-btn-ghost" data-console-back onClick={onClose}>
          BACK TO FEED
        </button>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const validation = validateFeedPostInput({ kind, title, body, cartId: cartId || null });
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/feed", {
        method: "POST",
        headers: await authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(validation.value),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Could not publish your post.");
      }
      onPosted();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not publish your post.");
      setBusy(false);
    }
  };

  return (
    <div className="os-stage os-auth" data-console-nav data-testid="composer-screen">
      <h2>POST TO THE COMMUNITY</h2>

      <div className="os-kind-toggle" role="tablist" aria-label="Post type">
        <button
          type="button"
          role="tab"
          aria-selected={kind === "lfp"}
          className="os-kind-option"
          data-active={kind === "lfp"}
          onClick={() => setKind("lfp")}
        >
          LOOKING FOR PLAYERS
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={kind === "dev_post"}
          className="os-kind-option"
          data-active={kind === "dev_post"}
          onClick={() => setKind("dev_post")}
        >
          DEVLOG
        </button>
      </div>

      <form onSubmit={submit}>
        <input
          className="os-input"
          type="text"
          placeholder={kind === "lfp" ? "Who are you looking for?" : "What did you build?"}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={POST_TITLE_MAX}
          required
        />
        <textarea
          className="os-input"
          placeholder={
            kind === "lfp"
              ? "When you play, what you're chasing, who's welcome…"
              : "What you learned, what changed, what's next…"
          }
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={POST_BODY_MAX}
          rows={5}
          required
        />
        <div className="os-char-count">
          {body.length}/{POST_BODY_MAX}
        </div>
        <select className="os-input" value={cartId} onChange={(event) => setCartId(event.target.value)}>
          <option value="">
            {kind === "lfp" ? "Link a cartridge (optional)" : "Link one of your cartridges (optional)"}
          </option>
          {carts.map((cart) => (
            <option key={cart.id} value={cart.id}>
              {cart.title}
            </option>
          ))}
        </select>
        <button type="submit" className="os-btn" disabled={busy}>
          {busy ? "…" : "PUBLISH"}
        </button>
        <button type="button" className="os-btn os-btn-ghost" data-console-back onClick={onClose}>
          CANCEL
        </button>
      </form>

      {error && (
        <p className="os-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
