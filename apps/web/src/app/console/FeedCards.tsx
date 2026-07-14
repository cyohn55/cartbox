"use client";

/**
 * The home feed's card varieties. Every card fills one snap "page" of the
 * feed. The cart card mounts the actual WASM player inline — the game runs
 * right in the feed, driven by the shell buttons — and clips replay a recorded
 * run the same way. The authored kinds (news / LFP / tips / trivia / dev
 * posts) are content cards; trivia is tappable.
 */

import { useEffect, useRef, useState } from "react";
import { mount, parseReplay, type ModelId, type PlayerHandle } from "@cartbox/player";

import type { FeedCartInfo, FeedClipInfo, FeedItem } from "@/lib/feedMix";
import { PostArt } from "./PostArt";
import { useConsoleInput, useConsoleInputBus } from "./ConsoleInputContext";
import { cursorHasFocus } from "./useConsoleCursor";
import type { PlayingCart } from "./consoleOs";

const KIND_BADGES: Record<FeedItem["kind"], string> = {
  cart: "CARTRIDGE",
  clip: "REPLAY",
  achievement: "ACHIEVEMENT",
  news: "NEWS",
  lfp: "LOOKING FOR PLAYERS",
  dev_tip: "DEV TIP",
  trivia: "TRIVIA",
  dev_post: "DEVLOG",
};

interface CardProps {
  item: FeedItem;
  /** True while this card is the one snapped into view. */
  active: boolean;
  onPlayCart: (cart: PlayingCart) => void;
}

function Badge({ kind }: { kind: FeedItem["kind"] }) {
  return (
    <span className="os-card-kind" data-kind={kind}>
      {KIND_BADGES[kind]}
    </span>
  );
}

function Author({ item }: { item: FeedItem }) {
  if (!item.authorName && !item.authorHandle) {
    return null;
  }
  return (
    <span className="os-card-author">
      {item.authorName ?? item.authorHandle}
      {item.authorHandle ? ` · @${item.authorHandle}` : ""}
    </span>
  );
}

/**
 * Loops a recorded replay of the cart as its gameplay preview: play the clip,
 * then restart. Purely decorative — no input attaches.
 */
function LoopingPreview({ cart, clip }: { cart: FeedCartInfo; clip: FeedClipInfo }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !cart.cartUrl) {
      return;
    }
    let handle: PlayerHandle | undefined;
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(clip.replayUrl, { signal: controller.signal });
        const replay = parseReplay(await response.text());
        handle = mount(stage, {
          cartUrl: cart.cartUrl!,
          engineUrl: cart.engineUrl ?? undefined,
          modelId: cart.modelId as ModelId,
          replay,
          autostart: true,
          scale: "fit",
        });
      } catch {
        /* previews are best-effort; the scrim + copy still describe the cart */
      }
    })();
    // Restart shortly after the clip runs out so the loop shows gameplay,
    // not the idle state the run ended in.
    const seconds = Math.min(20, Math.max(5, clip.frameCount / 60 + 2));
    const timer = setTimeout(() => setCycle((count) => count + 1), seconds * 1000);
    return () => {
      clearTimeout(timer);
      controller.abort();
      handle?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycle, cart.cartUrl, cart.engineUrl, cart.modelId, clip.replayUrl, clip.frameCount]);

  return <div className="os-card-stage" ref={stageRef} data-testid="cart-preview-loop" />;
}

/**
 * Fallback preview when no replay or thumbnail exists: run the cart itself,
 * silently, with no input attached — its title screen/demo animates.
 */
function AttractPreview({ cart }: { cart: FeedCartInfo }) {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !cart.cartUrl || !cart.engineUrl) {
      return;
    }
    let handle: PlayerHandle | null = null;
    handle = mount(stage, {
      cartUrl: cart.cartUrl,
      engineUrl: cart.engineUrl,
      modelId: cart.modelId as ModelId,
      controls: "keyboard", // owner is "ui": shell buttons don't forward here
      scale: "fit",
      onReady: () => void handle?.resume(),
    });
    return () => handle?.destroy();
  }, [cart.cartUrl, cart.engineUrl, cart.modelId]);

  return <div className="os-card-stage" ref={stageRef} data-testid="cart-preview-attract" />;
}

/**
 * A cartridge playable inline. Idle it previews its gameplay (looping replay
 * → thumbnail → the cart running in attract). ▶ (or the A button) hands the
 * shell buttons to the game right in the card; SELECT or scrolling away
 * ejects it.
 */
function CartCard({ item, active }: CardProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const bus = useConsoleInputBus();
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const cart = item.cart!;
  const playable = cart.cartUrl !== null && cart.engineUrl !== null;

  // Scrolling away ejects the inline game.
  useEffect(() => {
    if (!active) {
      setPlaying(false);
    }
  }, [active]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!playing || !stage || !cart.cartUrl || !cart.engineUrl) {
      return;
    }
    const handle = mount(stage, {
      cartUrl: cart.cartUrl,
      engineUrl: cart.engineUrl,
      modelId: cart.modelId as ModelId,
      controls: "keyboard",
      scale: "fit",
      lighting: { autoDetect: true },
      // Loading is async — resume() only works once the cart is in, so
      // playback starts from onReady, not right after mount().
      onReady: () => void handleRef.current?.resume(),
      onError: () => {
        setFailed(true);
        setPlaying(false);
      },
    });
    handleRef.current = handle;
    bus.setGameForwarding(true);

    return () => {
      bus.setGameForwarding(false);
      handleRef.current = null;
      handle.destroy();
    };
  }, [playing, cart.cartUrl, cart.engineUrl, cart.modelId, bus]);

  useConsoleInput((event) => {
    if (event.phase !== "press") {
      return;
    }
    if (playing) {
      if (event.control === "select") {
        setPlaying(false);
        return;
      }
      // A real button press can unblock a browser-suspended AudioContext.
      void handleRef.current?.resume();
      return;
    }
    // A inserts the cartridge when this card is the one on screen (and the
    // cursor isn't parked on some other element, e.g. the tab bar).
    if (active && event.control === "a" && bus.owner === "ui" && !cursorHasFocus() && playable) {
      setFailed(false);
      setPlaying(true);
    }
  });

  // The card's background: the live game while playing, otherwise the best
  // available preview (looping replay → thumbnail → attract run → glyph).
  let stageContent: React.ReactNode;
  if (playing) {
    stageContent = <div className="os-card-stage" ref={stageRef} data-testid="cart-live-stage" />;
  } else if (active && playable && cart.preview) {
    stageContent = <LoopingPreview cart={cart} clip={cart.preview} />;
  } else if (cart.thumbUrl) {
    stageContent = (
      <div className="os-card-stage">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={cart.thumbUrl} alt={cart.title} />
      </div>
    );
  } else if (active && playable) {
    stageContent = <AttractPreview cart={cart} />;
  } else {
    stageContent = (
      <div className="os-card-stage">
        <span style={{ fontSize: 40 }}>▦</span>
      </div>
    );
  }

  return (
    <article className="os-card" data-testid="feed-card-cart">
      {stageContent}
      {/* No scrim while the game runs — the player deserves the whole frame. */}
      {!playing && <div className="os-card-scrim" />}
      {!playing && <Badge kind="cart" />}
      {!playing && <h3>{cart.title}</h3>}
      {!playing && <p className="os-card-body">{item.body}</p>}
      {!playing && <Author item={item} />}
      {playable ? (
        <button
          type="button"
          className="os-btn"
          data-testid="play-in-feed"
          onClick={() => {
            setFailed(false);
            setPlaying(!playing);
          }}
        >
          {playing ? "■ EJECT" : "▶ PLAY IN FEED"}
        </button>
      ) : (
        <a className="os-btn" href={`/play/${cart.id}`}>
          ${(cart.priceCents / 100).toFixed(2)} · VIEW IN STORE
        </a>
      )}
      {failed && (
        <p className="os-error" role="alert">
          This cartridge failed to load.
        </p>
      )}
    </article>
  );
}

/** A recorded run, replayed automatically while the card is in view. */
function ClipCard({ item, active }: CardProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const cart = item.cart!;
  const clip = item.clip!;

  // Mount the engine only while snapped into view — a feed of clips would
  // otherwise boot a WASM core per card.
  useEffect(() => {
    const stage = stageRef.current;
    if (!active || !stage || !cart.cartUrl) {
      return;
    }

    let handle: PlayerHandle | undefined;
    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch(clip.replayUrl, { signal: controller.signal });
        const replay = parseReplay(await response.text());
        handle = mount(stage, {
          cartUrl: cart.cartUrl!,
          engineUrl: cart.engineUrl ?? undefined,
          modelId: cart.modelId as ModelId,
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
  }, [active, cart.cartUrl, cart.engineUrl, cart.modelId, clip.replayUrl]);

  return (
    <article className="os-card" data-testid="feed-card-clip">
      <div className="os-card-stage" ref={stageRef} />
      <div className="os-card-scrim" />
      <Badge kind="clip" />
      <h3>{cart.title}</h3>
      <Author item={item} />
      {failed && (
        <p className="os-error" role="alert">
          This replay could not be played.
        </p>
      )}
    </article>
  );
}

/** Face buttons answer trivia: X/Y/A/B pick choices 1-4 (taps work too). */
const TRIVIA_BUTTON_ORDER = ["x", "y", "a", "b"] as const;

function TriviaCard({ item, active }: CardProps) {
  const [picked, setPicked] = useState<number | null>(null);
  const bus = useConsoleInputBus();
  const trivia = item.trivia!;

  useConsoleInput((event) => {
    if (!active || picked !== null || event.phase !== "press" || bus.owner !== "ui") {
      return;
    }
    const index = (TRIVIA_BUTTON_ORDER as readonly string[]).indexOf(event.control);
    if (index >= 0 && index < trivia.choices.length) {
      setPicked(index);
    }
  });

  return (
    <article className="os-card" data-testid="feed-card-trivia">
      <div className="os-card-stage">
        <PostArt kind="trivia" />
      </div>
      <div className="os-card-scrim" />
      <Badge kind="trivia" />
      <h3>{item.body}</h3>
      <div className="os-trivia-choices">
        {trivia.choices.map((choice, index) => {
          let result: string | undefined;
          if (picked !== null && index === trivia.answerIndex) {
            result = "right";
          } else if (picked === index) {
            result = "wrong";
          }
          return (
            <button
              key={choice}
              type="button"
              className="os-trivia-choice"
              data-result={result}
              onClick={() => setPicked(index)}
              disabled={picked !== null}
            >
              <span className="os-trivia-btn" aria-hidden>
                {TRIVIA_BUTTON_ORDER[index]?.toUpperCase()}
              </span>
              {choice}
            </button>
          );
        })}
      </div>
      <Author item={item} />
    </article>
  );
}

/** News / LFP / dev-tip / devlog / achievement content card. */
function ContentCard({ item }: CardProps) {
  return (
    <article className="os-card" data-testid={`feed-card-${item.kind}`}>
      <div className="os-card-stage">
        <PostArt kind={item.kind} />
      </div>
      <div className="os-card-scrim" />
      <Badge kind={item.kind} />
      <h3>
        {item.kind === "achievement" ? `${item.authorName ?? "A player"} unlocked: ${item.title}` : item.title}
      </h3>
      <p className="os-card-body">{item.body}</p>
      <Author item={item} />
      {item.kind === "lfp" && item.link && (
        <a className="os-btn" href={item.link}>
          ▶ JOIN THE GAME
        </a>
      )}
    </article>
  );
}

export function FeedCard(props: CardProps) {
  switch (props.item.kind) {
    case "cart":
      return props.item.cart ? <CartCard {...props} /> : null;
    case "clip":
      return props.item.cart && props.item.clip ? <ClipCard {...props} /> : null;
    case "trivia":
      return props.item.trivia ? <TriviaCard {...props} /> : <ContentCard {...props} />;
    default:
      return <ContentCard {...props} />;
  }
}
