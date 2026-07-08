"use client";

/**
 * The console homescreen: a full-screen, vertically snapping feed (TikTok
 * style) mixing playable carts, replay clips, developer posts, news, friend
 * achievements, LFP invites, dev tips, and trivia.
 *
 * Navigation: swipe/scroll, or D-pad up/down — unless an in-feed game has the
 * buttons. Only the snapped-in card is "active", which is what gates the
 * heavyweight WASM mounts in the cards.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { isStaticExport } from "@/lib/staticSite";
import { buildDemoFeed } from "@/lib/demoFeed";
import type { FeedItem } from "@/lib/feedMix";
import { useConsoleInput, useConsoleInputBus } from "./ConsoleInputContext";
import type { PlayingCart } from "./consoleOs";
import { FeedCard } from "./FeedCards";
import { ComposerScreen } from "./ComposerScreen";

type LoadState = "loading" | "ready" | "error";

interface HomeFeedProps {
  guest: boolean;
  onPlayCart: (cart: PlayingCart) => void;
}

export function HomeFeed({ guest, onPlayCart }: HomeFeedProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bus = useConsoleInputBus();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [activeIndex, setActiveIndex] = useState(0);
  const [composing, setComposing] = useState(false);

  const loadFeed = useCallback(() => {
    if (isStaticExport) {
      setItems(buildDemoFeed());
      setLoadState("ready");
      return () => {};
    }
    let cancelled = false;
    setLoadState("loading");
    fetch("/api/feed")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`feed request failed: ${response.status}`);
        }
        const body = (await response.json()) as { items: FeedItem[] };
        if (!cancelled) {
          setItems(body.items);
          setLoadState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => loadFeed(), [loadFeed]);

  // D-pad up/down page between cards while the UI owns the buttons.
  useConsoleInput((event) => {
    const scroller = scrollerRef.current;
    if (!scroller || event.phase !== "press" || bus.owner !== "ui") {
      return;
    }
    if (event.control === "down") {
      scroller.scrollBy({ top: scroller.clientHeight, behavior: "smooth" });
    } else if (event.control === "up") {
      scroller.scrollBy({ top: -scroller.clientHeight, behavior: "smooth" });
    }
  });

  const handleScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller || scroller.clientHeight === 0) {
      return;
    }
    setActiveIndex(Math.round(scroller.scrollTop / scroller.clientHeight));
  };

  if (composing) {
    return (
      <ComposerScreen
        guest={guest}
        onClose={() => setComposing(false)}
        onPosted={() => {
          setComposing(false);
          // Jump back to the top so the fresh post is the first thing seen.
          scrollerRef.current?.scrollTo({ top: 0 });
          setActiveIndex(0);
          loadFeed();
        }}
      />
    );
  }

  if (loadState === "loading") {
    return <div className="os-loading">TUNING THE FEED…</div>;
  }

  if (loadState === "error") {
    return (
      <div className="os-empty">
        The feed could not be reached.
        <br />
        Check the community server and try again.
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="os-empty">
        Nothing here yet — publish a cartridge
        <br />
        and it will headline the feed.
      </div>
    );
  }

  return (
    <>
      <div className="os-feed" ref={scrollerRef} onScroll={handleScroll} data-testid="home-feed">
        {items.map((item, index) => (
          <FeedCard key={item.id} item={item} active={index === activeIndex} onPlayCart={onPlayCart} />
        ))}
      </div>
      {/* Composer needs the community server; the static demo has none. */}
      {!isStaticExport && (
        <button
          type="button"
          className="os-compose-btn"
          data-testid="compose-button"
          onClick={() => setComposing(true)}
        >
          + POST
        </button>
      )}
    </>
  );
}
