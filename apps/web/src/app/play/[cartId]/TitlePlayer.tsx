"use client";

/**
 * Mounts the right player for a catalog title.
 *
 * Only `wasm-app` titles run on the Cartbox Game ABI, which `WasmGamePlayer`
 * drives. The other five runtimes host their own engine inside an iframe and
 * have had players since each was ported — but they were only ever wired into
 * the handheld console, so this page rendered `WasmGamePlayer` for everything
 * and asked for /games/<bundle>/game.js, a path that exists for no iframe
 * runtime. Fourteen of the seventeen catalog titles 404'd that way, while Browse
 * linked every one of them here.
 *
 * The players are shared with the console rather than reimplemented: they are
 * plain prop-driven components, so the only thing this adds is the dispatch and
 * the PlayingCart the console would otherwise have built.
 */

import { useRouter } from "next/navigation";

import { Cube2Player } from "@/app/console/Cube2Player";
import { DosPlayer } from "@/app/console/DosPlayer";
import { QuakePlayer } from "@/app/console/QuakePlayer";
import { ScummVmPlayer } from "@/app/console/ScummVmPlayer";
import { SuperTuxPlayer } from "@/app/console/SuperTuxPlayer";
import type { PlayingCart } from "@/app/console/consoleOs";
import { gamePlayerRuntime, type GamePlayerRuntime } from "@/lib/titleRuntime";

import { WasmGamePlayer } from "./WasmGamePlayer";

export interface TitlePlayerProps {
  titleId: string;
  name: string;
  runtimeId: string;
  bundleName: string;
  width: number;
  height: number;
  /** ScummVM game id, or "<bundle>:<exe>" for DOS. */
  target?: string | null;
}

/** The shape the console players consume, built from a catalog title. */
export function playingCartForTitle(props: TitlePlayerProps): PlayingCart {
  return {
    cartId: props.titleId,
    title: props.name,
    // The iframe engines load their own assets from their bundle; these two are
    // required by the type and unused on this path.
    cartUrl: "",
    engineUrl: "",
    modelId: "classic",
    game: {
      runtime: gamePlayerRuntime({ runtime: props.runtimeId }),
      bundleName: props.bundleName,
      width: props.width,
      height: props.height,
      target: props.target ?? undefined,
    },
  };
}

const IFRAME_PLAYERS: Record<
  Exclude<GamePlayerRuntime, "wasm-app">,
  (p: { cart: PlayingCart; onExit: () => void }) => React.JSX.Element
> = {
  cube2: Cube2Player,
  dos: DosPlayer,
  quake: QuakePlayer,
  scummvm: ScummVmPlayer,
  supertux: SuperTuxPlayer,
};

export function TitlePlayer(props: TitlePlayerProps) {
  const router = useRouter();
  const runtime = gamePlayerRuntime({ runtime: props.runtimeId });

  if (runtime === "wasm-app") {
    return (
      <WasmGamePlayer
        titleId={props.titleId}
        bundleName={props.bundleName}
        width={props.width}
        height={props.height}
      />
    );
  }

  const Player = IFRAME_PLAYERS[runtime];

  // Leaving a full-screen engine returns to the title's own page, which is where
  // the player arrived from.
  return <Player cart={playingCartForTitle(props)} onExit={() => router.push("/browse")} />;
}
