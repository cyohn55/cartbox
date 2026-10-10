/** The Basis Universal encoder's Emscripten module factory (see README.md). */
declare function BASIS(options: { wasmBinary: ArrayBuffer | Uint8Array }): Promise<unknown>;
export default BASIS;
