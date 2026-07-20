/**
 * Assembles the `dos` runtime into apps/web/public/dosbox for the site build.
 *
 *   node scripts/fetch-dosbox.mjs
 *
 * Unlike the Doom/ScummVM/SuperTux runtimes, the DOS runtime compiles nothing:
 * the engine is DOSBox already built to WebAssembly by the js-dos project
 * (6.22), and the launch title is C-Dogs — a freely redistributable DOS game.
 * Both are small and are vendored under games/cdogs (the js-dos build's URL is a
 * rolling "current" pointer, so vendoring is what makes the build reproducible),
 * and this script just copies them into public/, which the deploy gitignores and
 * regenerates rather than committing built artefacts.
 *
 * Each source is verified against a pinned digest before it is written: a
 * vendored engine or game that silently changed would otherwise surface as a
 * broken title on the live site rather than as a failed build.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDirectory = join(repoRoot, "games", "cdogs");
const outputDirectory = join(repoRoot, "apps", "web", "public", "dosbox");

/**
 * Each vendored source, its destination name under public/dosbox, and the
 * SHA-256 it must hash to. The game zip is renamed to cdogs.zip to match the
 * title's dosTarget ("cdogs:CDOGS.EXE").
 */
const ARTEFACTS = [
  {
    source: join(vendorDirectory, "vendor", "js-dos", "js-dos.js"),
    output: "js-dos.js",
    sha256: "774742a2f89762b51497c6e060d7bace465470e7874a2810b59a21a0ec61a8a1",
  },
  {
    source: join(vendorDirectory, "vendor", "js-dos", "wdosbox.js"),
    output: "wdosbox.js",
    sha256: "06feec57a69b93f84722c4d0c5ed483484052e6e1d144dc4a98ee10af1d82044",
  },
  {
    // js-dos 6.22 derives this name from wdosboxUrl and fetches it as an
    // arraybuffer to instantiate — it must be "wdosbox.wasm.js", not ".wasm".
    source: join(vendorDirectory, "vendor", "js-dos", "wdosbox.wasm.js"),
    output: "wdosbox.wasm.js",
    sha256: "84b873c1e5484a0f1d1adb25871f0daa92f1efc0339a9b54e84e450062182fb0",
  },
  {
    source: join(vendorDirectory, "c-dogs.zip"),
    output: "cdogs.zip",
    sha256: "de6c5e025b5c03b475e55c2ec6ab88b493517a4d4e8c649e2e7dd1919b7b50cc",
  },
];

/**
 * Per-game "overlay" files: extra files that must sit in C: next to the game but
 * cannot be added to its distribution archive (C-Dogs is redistributable only
 * "unmodified"). The boot page reads <bundle>.files.json and writes each into the
 * mounted filesystem before launch. SOUND.CFG is a Sound Blaster 16 config
 * generated once with the game's own DSETUP32 (see games/cdogs/README.md), so
 * C-Dogs finds a working sound device instead of failing initialisation.
 */
const OVERLAYS = [
  {
    bundle: "cdogs",
    files: [
      // Sound Blaster 16 config (DOSBox's emulated card), generated once with the
      // game's own DSETUP32 — so C-Dogs finds a sound device instead of failing.
      { path: "SOUND.CFG", source: join(vendorDirectory, "SOUND.CFG"), sha256: "bfa9add98da7541bbceca016edeee3154ad5c3564e590f0b788ed8433ab1354e" },
      // Player 1 controls bound to WASD + Space + Enter. C-Dogs reads raw
      // scancodes via a custom INT9 handler that mishandles the extended (0xE0)
      // codes of the arrow keys, so its defaults come through scrambled; these
      // non-extended keys are delivered cleanly. See games/cdogs/README.md.
      { path: "OPTIONS.CNF", source: join(vendorDirectory, "OPTIONS.CNF"), sha256: "5bbc7c2a6099b84da55232a292c177cafb465a077fe18bd88cefdaae9327abfe" },
    ],
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifiedRead(source, expected) {
  const bytes = readFileSync(source);
  const digest = sha256(bytes);
  if (digest !== expected) {
    throw new Error(
      `${source} digest mismatch.\n  expected ${expected}\n  got      ${digest}\n` +
        "Refusing to write: the vendored file changed. Update the pin if this is intentional.",
    );
  }
  return bytes;
}

function main() {
  mkdirSync(outputDirectory, { recursive: true });

  for (const artefact of ARTEFACTS) {
    const bytes = verifiedRead(artefact.source, artefact.sha256);
    copyFileSync(artefact.source, join(outputDirectory, artefact.output));
    console.log(`Wrote ${artefact.output} (${(bytes.length / 1024).toFixed(0)} KB, sha256 ok)`);
  }

  for (const overlay of OVERLAYS) {
    const map = {};
    for (const file of overlay.files) {
      map[file.path] = verifiedRead(file.source, file.sha256).toString("base64");
    }
    const outputName = `${overlay.bundle}.files.json`;
    writeFileSync(join(outputDirectory, outputName), JSON.stringify(map));
    console.log(`Wrote ${outputName} (${overlay.files.map((file) => file.path).join(", ")})`);
  }

  console.log("DOS runtime assembled into apps/web/public/dosbox");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
