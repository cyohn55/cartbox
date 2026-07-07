/**
 * Seeds a fresh cart with starter content — palette, a few tiles, a small map
 * scene, and the classic template code. It is written against the CartEngine
 * interface, so the same seed populates the in-memory stub and a freshly created
 * WASM cartridge identically. Tile 0 is left blank because empty map cells
 * reference it.
 */

import type { CartEngine } from "../engine/CartEngine";
import {
  MAP_SCREEN_WIDTH,
  MUSIC_NOTE_START,
  SFX_MAX_VALUE,
  SFX_TICKS,
  WAVEFORM_MAX,
  WAVEFORM_STEPS,
} from "../engine/CartEngine";
import { paletteForModel, hexToRgb } from "./palette";
import { nearestDirection } from "./normals";

const DEMO_TILES: Record<number, string[]> = {
  1: [
    "..2222..",
    ".244442.",
    "24c44c42",
    "24444442",
    "24c44c42",
    "2444cc42",
    ".244442.",
    "..2222..",
  ],
  2: [
    "56565656",
    "65656565",
    "56565656",
    "65656565",
    "56565656",
    "65656565",
    "56565656",
    "65656565",
  ],
  3: [
    "33333333",
    "3ee3ee33",
    "3ee3ee33",
    "33333333",
    "ee33ee3e",
    "ee33ee3e",
    "33333333",
    "33333333",
  ],
  4: [
    "aaabaaab",
    "abaaabaa",
    "aaabaaab",
    "baaabaaa",
    "aaabaaab",
    "abaaabaa",
    "aaabaaab",
    "baaabaaa",
  ],
};

export const DEMO_CODE = `-- title:  ring runner
-- author: you
-- desc:   hold right to score
-- script: lua

t=0
x=96
y=24

function TIC()
 if btn(0) then y=y-1 end
 if btn(1) then y=y+1 end
 if btn(2) then x=x-1 end
 if btn(3) then x=x+1 end

 cls(1)
 for i=0,40 do
  circ(120,68,(40-i+t)%44,i%15)
 end
 spr(1,x,y,0,2)
 print("HELLO WORLD!",84,84)
 t=t+1
end
`;

function paintTile(engine: CartEngine, tile: number, rows: string[]): void {
  rows.forEach((row, y) => {
    [...row].forEach((glyph, x) => {
      engine.setPixel(0, tile, x, y, glyph === "." ? 0 : parseInt(glyph, 16));
    });
  });
}

export function seedDemoCart(engine: CartEngine): void {
  // Seed the model's default palette (16 for Classic, 64 for Pro). Its first 16
  // entries are Sweetie-16, so the demo tiles below (which reference indices
  // 0..15) look the same on either console.
  paletteForModel(engine.model()).forEach((hex, index) => {
    const [red, green, blue] = hexToRgb(hex);
    engine.setPaletteColor(index, red, green, blue);
  });

  for (const [tile, rows] of Object.entries(DEMO_TILES)) {
    paintTile(engine, Number(tile), rows);
  }

  for (let x = 0; x < MAP_SCREEN_WIDTH; x += 1) {
    engine.setMapCell(x, 12, 2);
    engine.setMapCell(x, 13, 2);
  }
  for (let x = 6; x < 14; x += 1) {
    engine.setMapCell(x, 9, 3);
  }
  for (let x = 18; x < MAP_SCREEN_WIDTH; x += 1) {
    engine.setMapCell(x, 14, 4);
    engine.setMapCell(x, 15, 4);
  }

  // Waveform 0: a sine, so sample 0 (which plays it) is audible.
  for (let step = 0; step < WAVEFORM_STEPS; step += 1) {
    const sine = (WAVEFORM_MAX / 2) * (1 + Math.sin((2 * Math.PI * step) / WAVEFORM_STEPS));
    engine.setWaveformSample(0, step, Math.round(sine));
  }

  // A plucked blip on sample 0: full volume, decaying to silence, on waveform 0.
  for (let tick = 0; tick < SFX_TICKS; tick += 1) {
    engine.setSfxVolume(0, tick, Math.max(0, SFX_MAX_VALUE - Math.floor(tick / 2)));
    engine.setSfxWave(0, tick, 0);
  }

  // A C-major arpeggio on pattern 0, played with sample 0.
  const melody = [
    { row: 0, pitch: 0, octave: 4 },
    { row: 4, pitch: 4, octave: 4 },
    { row: 8, pitch: 7, octave: 4 },
    { row: 12, pitch: 0, octave: 5 },
  ];
  for (const { row, pitch, octave } of melody) {
    engine.setMusicNoteField(0, row, pitch + MUSIC_NOTE_START);
    engine.setMusicOctave(0, row, octave);
    engine.setMusicSfx(0, row, 0);
  }

  // Spherical normals on the mascot (tile 1) so the lit preview shows depth.
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const dx = (x - 3.5) / 3.5;
      const dy = (y - 3.5) / 3.5;
      const r2 = dx * dx + dy * dy;
      const direction = r2 < 1 ? nearestDirection([dx, dy, Math.sqrt(1 - r2)]) : 0;
      engine.setNormal(0, 1, x, y, direction);
    }
  }

  engine.setLanguage("lua");
  engine.setCode(DEMO_CODE);
}
