/** The vendored Basis Universal transcoder's Emscripten factory (see README.md). */
declare const createBasis: (options: { wasmBinary?: ArrayBuffer }) => Promise<unknown>;
export default createBasis;
