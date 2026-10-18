/**
 * MikkTSpace tangents in the browser (AAA_FIDELITY_ROADMAP.md F1c): the
 * WebAssembly build vendored in src/vendor/mikktspace (see its README),
 * instantiated here without its wasm-bindgen glue, whose two imports and the
 * call's five exports are all it needs. Fetched only when an import has a
 * normal-mapped primitive without tangents (~42 KB); players never load it.
 */

import type { MikkTSpace } from "@cartbox/editor";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The module from its bytes: a MikkTSpace generator over unwelded triangles. */
export async function createMikkTSpace(bytes: BufferSource): Promise<MikkTSpace> {
  // wasm-bindgen's object heap, for the one thing the module hands back: an error to throw.
  const heap: unknown[] = [];
  let exports: any = null;
  const text = (ptr: number, len: number) => new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len));
  const { instance } = await WebAssembly.instantiate(bytes, {
    "./mikktspace_module_bg.js": {
      __wbindgen_string_new: (ptr: number, len: number) => heap.push(text(ptr, len)) - 1,
      __wbindgen_rethrow: (index: number) => {
        throw heap[index];
      },
    },
  });
  exports = instance.exports;
  const pass = (array: Float32Array): [number, number] => {
    const ptr = exports.__wbindgen_malloc(array.length * 4);
    new Float32Array(exports.memory.buffer, ptr, array.length).set(array);
    return [ptr, array.length];
  };
  return (positions, normals, uvs) => {
    const ret = exports.__wbindgen_add_to_stack_pointer(-16);
    try {
      exports.generateTangents(ret, ...pass(positions), ...pass(normals), ...pass(uvs));
      const [ptr, len] = new Int32Array(exports.memory.buffer, ret, 2);
      const out = new Float32Array(exports.memory.buffer, ptr!, len!).slice();
      exports.__wbindgen_free(ptr, len! * 4);
      return out;
    } finally {
      exports.__wbindgen_add_to_stack_pointer(16);
      heap.length = 0;
    }
  };
}

let loading: Promise<MikkTSpace> | null = null;

/** The MikkTSpace generator, loading it on first use (and retrying after a failed load). */
export function loadMikkTSpace(): Promise<MikkTSpace> {
  loading ??= fetch(new URL("../vendor/mikktspace/mikktspace.wasm", import.meta.url))
    .then((r) => {
      if (!r.ok) throw new Error(`MikkTSpace failed to load (${r.status})`);
      return r.arrayBuffer();
    })
    .then(createMikkTSpace);
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
