/**
 * MusicTracker — the editor-facing view of the cart's music patterns. It turns
 * the raw packed row fields into musical cells (empty / note-off / a pitched
 * note with octave and SFX) and back. Pure, like the other models; the engine
 * owns the byte packing, this owns the note encoding (see MUSIC_NOTE_START).
 */

import {
  CartEngine,
  MUSIC_CHANNELS,
  MUSIC_FRAMES,
  MUSIC_NOTES,
  MUSIC_NOTE_START,
  MUSIC_NOTE_STOP,
  MUSIC_OCTAVES,
  MUSIC_PATTERNS,
  MUSIC_PATTERN_ROWS,
  MUSIC_TRACKS,
} from "../engine/CartEngine";

export type MusicCellKind = "empty" | "stop" | "note";

export interface MusicCell {
  kind: MusicCellKind;
  /** Pitch within the octave, 0..11 (only for kind === "note"). */
  note?: number;
  octave?: number;
  sfx?: number;
}

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** The 8 per-row effect commands (index = command value), tracker letter + name. */
export const MUSIC_COMMANDS: ReadonlyArray<{ code: string; name: string }> = [
  { code: "·", name: "none" },
  { code: "M", name: "volume" },
  { code: "C", name: "chord" },
  { code: "J", name: "jump" },
  { code: "S", name: "slide" },
  { code: "P", name: "pitch" },
  { code: "V", name: "vibrato" },
  { code: "D", name: "delay" },
];

export interface MusicEffect {
  command: number;
  param: number;
  code: string;
}

export class MusicTracker {
  readonly patternCount = MUSIC_PATTERNS;
  readonly rows = MUSIC_PATTERN_ROWS;
  readonly notes = MUSIC_NOTES;
  readonly octaves = MUSIC_OCTAVES;
  readonly trackCount = MUSIC_TRACKS;
  readonly frameCount = MUSIC_FRAMES;
  readonly channelCount = MUSIC_CHANNELS;

  constructor(private readonly engine: CartEngine) {}

  /** The pattern id a track's channel plays on a frame (song arrangement). */
  getFramePattern(track: number, frame: number, channel: number): number {
    return this.engine.getMusicFramePattern(track, frame, channel);
  }

  setFramePattern(track: number, frame: number, channel: number, id: number): void {
    this.engine.setMusicFramePattern(track, frame, channel, id);
  }

  getCell(pattern: number, row: number): MusicCell {
    const field = this.engine.getMusicNoteField(pattern, row);
    if (field === MUSIC_NOTE_STOP) {
      return { kind: "stop" };
    }
    if (field >= MUSIC_NOTE_START) {
      return {
        kind: "note",
        note: field - MUSIC_NOTE_START,
        octave: this.engine.getMusicOctave(pattern, row),
        sfx: this.engine.getMusicSfx(pattern, row),
      };
    }
    return { kind: "empty" };
  }

  setNote(pattern: number, row: number, note: number, octave: number, sfx: number): void {
    this.engine.setMusicNoteField(pattern, row, (((note % MUSIC_NOTES) + MUSIC_NOTES) % MUSIC_NOTES) + MUSIC_NOTE_START);
    this.engine.setMusicOctave(pattern, row, octave);
    this.engine.setMusicSfx(pattern, row, sfx);
  }

  setStop(pattern: number, row: number): void {
    this.engine.setMusicNoteField(pattern, row, MUSIC_NOTE_STOP);
  }

  /** The row's effect (command + XY parameter). */
  getEffect(pattern: number, row: number): MusicEffect {
    const command = this.engine.getMusicCommand(pattern, row);
    return {
      command,
      param: this.engine.getMusicParam(pattern, row),
      code: MUSIC_COMMANDS[command]?.code ?? "·",
    };
  }

  setCommand(pattern: number, row: number, command: number): void {
    this.engine.setMusicCommand(pattern, row, command);
  }

  setParam(pattern: number, row: number, param: number): void {
    this.engine.setMusicParam(pattern, row, param);
  }

  /** A fixed-width effect label, e.g. "V37", or "···" for no command. */
  effectLabel(effect: MusicEffect): string {
    if (effect.command === 0) return "···";
    return `${effect.code}${effect.param.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  clear(pattern: number, row: number): void {
    this.engine.setMusicNoteField(pattern, row, 0);
  }

  /** True when every row of the pattern is empty. */
  isEmpty(pattern: number): boolean {
    for (let row = 0; row < this.rows; row += 1) {
      if (this.engine.getMusicNoteField(pattern, row) !== 0) return false;
    }
    return true;
  }

  /** A fixed-width label for a cell, e.g. "C-4", "F#3", "===", "---". */
  label(cell: MusicCell): string {
    if (cell.kind === "empty") return "---";
    if (cell.kind === "stop") return "===";
    const name = NOTE_NAMES[cell.note ?? 0] ?? "?";
    const padded = name.length === 1 ? `${name}-` : name;
    return `${padded}${cell.octave ?? 0}`;
  }
}
