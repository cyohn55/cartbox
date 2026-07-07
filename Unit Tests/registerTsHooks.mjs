/**
 * Registers the .ts resolve hook. Use with:
 *   node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" <test>
 */
import { register } from "node:module";

register("./tsResolveHooks.mjs", import.meta.url);
