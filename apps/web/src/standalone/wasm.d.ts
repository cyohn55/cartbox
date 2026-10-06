/** WebAssembly the standalone build inlines (esbuild's binary loader): the bytes. */
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}
