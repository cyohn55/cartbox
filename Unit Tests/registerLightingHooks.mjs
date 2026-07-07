/**
 * Registers the lighting resolve hook. Use with:
 *   node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" <test>
 */
import { register } from "node:module";

register("./lightingResolveHooks.mjs", import.meta.url);
