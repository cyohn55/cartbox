/**
 * Hearing a sound in the editor (EP12): a synth rendered, a file decoded, or
 * a line spoken, through one shared AudioContext — each preview cutting off
 * the last, so clicking ▶ down a list auditions them one at a time.
 */

import { base64ToBytes, resolveSynth, synthesizeSound, type SceneSound } from "@cartbox/editor";

let context: AudioContext | null = null;
let playing: AudioBufferSourceNode | null = null;

/** Play a sound once, at its own volume. Resolves when it has started (or failed quietly). */
export async function previewSound(sound: SceneSound, busVolume = 1): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    playing?.stop();
  } catch {
    /* already over */
  }
  playing = null;
  if (sound.source.kind === "speech") {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(sound.source.text);
    u.pitch = sound.source.pitch ?? 0.6;
    u.rate = sound.source.rate ?? 0.9;
    u.volume = Math.min(1, sound.volume * busVolume);
    synth.cancel();
    synth.speak(u);
    return;
  }
  context ??= new AudioContext();
  if (context.state === "suspended") await context.resume();
  let buffer: AudioBuffer;
  if (sound.source.kind === "synth") {
    const recipe = resolveSynth(sound.source.synth);
    if (!recipe) return;
    const samples = synthesizeSound(recipe, context.sampleRate);
    buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  } else {
    try {
      const bytes = base64ToBytes(sound.source.data);
      buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    } catch {
      return;
    }
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  const gain = context.createGain();
  gain.gain.value = sound.volume * busVolume;
  source.connect(gain).connect(context.destination);
  // A loop previews for a few seconds rather than forever.
  if (sound.loop) {
    source.loop = true;
    source.start();
    source.stop(context.currentTime + 4);
  } else source.start();
  playing = source;
}

/** Read a picked file as base64 (without the data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
