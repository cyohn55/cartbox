/**
 * ESLint flat config.
 *
 * Before this, `npm run lint` referenced a binary the repo never depended on,
 * with no config file of any kind — so linting had never run, and nothing
 * merged had ever been linted.
 *
 * ## What this is calibrated for
 *
 * A lint setup added to a large existing codebase is only useful if it passes.
 * A maximalist rule set that reports two thousand findings on day one gets
 * `--no-verify`'d and then ignored, which is worse than no linting: it looks
 * like a gate while being noise.
 *
 * So this enables the rules that catch *mistakes* — unused variables, unsafe
 * comparisons, promises nobody awaited — and leaves style to the reviewer. It
 * does not enable type-aware linting: that needs a TS program per file, which
 * multiplies lint time across a monorepo this size, and `tsc --noEmit` already
 * covers what matters most of it would find. Adding it later is a
 * one-line change if the trade turns out to be worth it.
 *
 * Rules that are deliberately relaxed carry a comment saying why. Anything
 * without one is simply the recommended default.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

export default tseslint.config(
  {
    // Build output, dependencies, and vendored engine artefacts. The engine
    // bundles are Emscripten output — machine-generated, thousands of lines,
    // and not ours to fix.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/out/**",
      "apps/web/public/**",
      "packages/engine/dist/**",
      "packages/engine/third_party/**",
      // The vendored TIC-80 checkout (npm run engine:prepare) and the CMake
      // build trees it produces. Upstream C with JavaScript tooling alongside
      // it, plus Emscripten output — 1.8k findings, none of them ours, and the
      // whole tree is gitignored. Without this, preparing the engine makes
      // `npm run lint` fail on code the repository does not contain.
      "packages/engine/tic80/**",
      "packages/engine/build-*/**",
      // Ported game sources: BananaBread/Cube2, WebQuake, js-dos and friends.
      // Vendored upstream JavaScript, much of it Emscripten output — 15k of the
      // 16.4k findings on the first run came from here. Not ours to fix, and
      // linting it would drown every finding that is.
      "games/**",
      "infra/**",
      "landing/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx,mts,mjs,js}"],
    rules: {
      // An unused parameter is usually intent (an interface being satisfied, a
      // positional argument skipped) rather than an oversight, so only flag the
      // ones not marked with a leading underscore — the convention this
      // codebase already uses, e.g. `_request` in the API routes.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],

      // The WebGPU handles are deliberately loosely typed: WebGPU is not in this
      // project's TS DOM lib and pulling in @webgpu/types is a dependency the
      // renderers explicitly declined. Those files disable this rule locally
      // with a comment explaining exactly that, which is the right granularity —
      // so this stays on, and the exceptions stay visible.
      "@typescript-eslint/no-explicit-any": "warn",

      // Catches the mistake `if (x = 1)` while allowing the idiomatic
      // `while ((match = re.exec(s)))` the tokenisers use.
      "no-cond-assign": ["error", "except-parens"],

      // A dead store is a smell worth a human's eye, not a mechanical edit: the
      // remaining instances are redundant initialisers in branchy code, where
      // removing one risks a real "used before assigned" bug to satisfy a
      // stylistic rule. Visible as a warning, not a gate.
      "no-useless-assignment": "warn",

      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },

  {
    // The web app's React rules. These are not decoration: the codebase already
    // carries `eslint-disable react-hooks/exhaustive-deps` comments written when
    // it was linted with `next lint`, and without the plugin loaded every one of
    // them reports as an unused directive — 24 findings that are really 24
    // pieces of encoded knowledge about deliberate dependency omissions.
    //
    // The two plugins are wired directly rather than through
    // `eslint-config-next`, because that config bundles `eslint-plugin-react`,
    // which still uses ESLint's pre-flat rule context and throws outright on
    // ESLint 10. These two are the ones whose directives the codebase actually
    // references.
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,

      // Only the two classic hook rules, not the plugin's whole recommended
      // set: the installed major also ships React Compiler rules (`refs`,
      // `set-state-in-effect`, `immutability`) that report 113 findings against
      // a codebase written years before them. Opting into those is a real piece
      // of work with real behaviour changes, not a lint config decision.
      "react-hooks/rules-of-hooks": "error",

      // A warning, which is also Next's own default. Auto-satisfying a
      // dependency array can turn a stable effect into an infinite render loop,
      // so this is advice for a human, not something to fix mechanically.
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  {
    // TypeScript already resolves every identifier, and does it knowing the
    // configured libs and globals. ESLint does not, so `no-undef` on a .ts file
    // reports the DOM, Node and WebGPU surface as undefined — 7.3k findings on
    // the first run, none of them real.
    files: ["**/*.{ts,tsx,mts}"],
    rules: { "no-undef": "off" },
  },

  {
    // Tests reach for `any` when standing in for a device or a driver, and that
    // is the point of a fake — the alternative is modelling an entire API
    // surface to satisfy a linter.
    files: ["Unit Tests/**", "**/*.test.{ts,tsx,mts,mjs}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  {
    // Scripts and examples run in Node and predate the strictness above.
    files: ["scripts/**", "**/examples/**", "**/*.mjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "no-undef": "off", // Node globals; these are not type-checked either.
    },
  },
);
