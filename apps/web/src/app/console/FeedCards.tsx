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

import type { FeedItem } from "@/lib/feedMix";
import { useConsoleInput, useConsoleInputBus } from "./ConsoleInputContext";
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
 * A cartridge playable inline. Idle: thumbnail + description. Tapping ▶ mounts
 * the engine into the card and hands the shell buttons to the game; SELECT (or
 * scrolling away) ejects it and returns the buttons to the feed.
 */
function CartCard({ item, active }: CardProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const bus = useConsoleInputBus();
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const cart = item.cart!;

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
      onError: () => {
        setFailed(true);
        setPlaying(false);
      },
    });
    handleRef.current = handle;
    void handle.resume(); // the ▶ tap was a real gesture, so audio may start
    bus.setGameForwarding(true);

    return () => {
      bus.setGameForwarding(false);
      handleRef.current = null;
      handle.destroy();
    };
  }, [playing, cart.cartUrl, cart.engineUrl, cart.modelId, bus]);

  useConsoleInput((event) => {
    if (playing && event.phase === "press" && event.control === "select") {
      setPlaying(false);
    }
  });

  const playable = cart.cartUrl !== null;

  return (
    <article className="os-card" data-testid="feed-card-cart">
      <div className="os-card-stage" ref={stageRef}>
        {!playing &&
          (cart.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cart.thumbUrl} alt={cart.title} />
          ) : (
            <span style={{ fontSize: 40 }}>▦</span>
          ))}
      </div>
      <div className="os-card-scrim" />
      <Badge kind="cart" />
      <h3>{cart.title}</h3>
      {!playing && <p className="os-card-body">{item.body}</p>}
      <Author item={item} />
      {playable ? (
        <button
          type="button"
          className="os-btn"
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

/** Multiple-choice trivia; reveals right/wrong on tap. */
function TriviaCard({ item }: CardProps) {
  const [picked, setPicked] = useState<number | null>(null);
  const trivia = item.trivia!;

  return (
    <article className="os-card" data-testid="feed-card-trivia">
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
