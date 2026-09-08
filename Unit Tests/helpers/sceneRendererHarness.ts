/**
 * Re-exports for the WebGPU renderer tests.
 *
 * The test needs symbols from two packages plus the renderer class itself;
 * gathering them here keeps the test file's imports about the subject rather
 * than about module resolution.
 */

export { projectionMatrix, viewMatrix } from "@cartbox/editor";
export {
  UNIFORM_BYTES_USED,
  UNIFORM_STRIDE,
  WebgpuSceneRenderer,
  alignBytesPerRow,
} from "@cartbox/player";
