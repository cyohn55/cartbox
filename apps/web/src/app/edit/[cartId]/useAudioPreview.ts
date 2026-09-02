"use client";

/**
 * Web Audio playback for the SFX and Music editors.
 *
 * Everything musical lives in `@cartbox/editor`'s pure synthesiser; this hook is
 * only the browser half: one lazily-created AudioContext, one source at a time,
 * and a `playing` flag for the button label. Kept small deliberately — audio
 * code that also does arithmetic is audio code that cannot be tested.
 *
 * The context is created on the first play, never on mount: browsers refuse to
 * start one without a user gesture, and an editor that logs an autoplay warning
 * on every open is an editor that looks broken.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface AudioPreview {
  /** Play a rendered mono buffer, replacing anything already sounding. */
  play: (samples: Float32Array) => void;
  stop: () => void;
  playing: boolean;
  /** False when this browser has no Web Audio at all. */
  supported: boolean;
}

export function useAudioPreview(): AudioPreview {
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const [playing, setPlaying] = useState(false);
  const [supported] = useState(() => typeof window !== "undefined" && typeof window.AudioContext === "function");

  const stop = useCallback(() => {
    const source = sourceRef.current;
    sourceRef.current = null;
    if (source) {
      // A source that already ended throws on stop(); nothing to report.
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* already finished */
      }
    }
    setPlaying(false);
  }, []);

  const play = useCallback(
    (samples: Float32Array) => {
      if (!supported || samples.length === 0) return;
      stop();

      let context = contextRef.current;
      if (!context) {
        context = new AudioContext();
        contextRef.current = context;
      }
      // A context created before a gesture, or suspended by a background tab,
      // stays silent until resumed.
      void context.resume();

      const buffer = context.createBuffer(1, samples.length, context.sampleRate);
      // The lib's signature narrows to Float32Array<ArrayBuffer>; a rendered
      // buffer is exactly that, but the generic parameter is not inferred.
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (sourceRef.current === source) {
          sourceRef.current = null;
          setPlaying(false);
        }
      };
      source.start();
      sourceRef.current = source;
      setPlaying(true);
    },
    [stop, supported],
  );

  // Leaving the tab must not leave a sound ringing, and the context is a real
  // audio-hardware handle — browsers cap how many a page may hold.
  useEffect(() => {
    return () => {
      const source = sourceRef.current;
      if (source) {
        try {
          source.onended = null;
          source.stop();
        } catch {
          /* already finished */
        }
      }
      void contextRef.current?.close();
      contextRef.current = null;
    };
  }, []);

  return { play, stop, playing, supported };
}

/** The sample rate a preview renders at, matching the context it will play in. */
export function previewSampleRate(): number {
  return 44_100;
}
