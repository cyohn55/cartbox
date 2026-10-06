/* global addToLibrary, Module, UTF8ToString -- Emscripten's JS library scope (--js-library) */
// The host side of the dedicated Modern core's direct API (core.c): each import
// calls straight into the object the page installs as Module.cbxHost (see
// src/index.ts), synchronously, while the cart's Lua is running.
addToLibrary({
  cbx_host_command: (op, a, v1, v2, v3, v4, v5, v6) => {
    Module.cbxHost.command(op, a, v1, v2, v3, v4, v5, v6);
  },
  cbx_host_query: (op, a, v1, v2, v3, v4, v5, v6) => Module.cbxHost.query(op, a, v1, v2, v3, v4, v5, v6) | 0,
  cbx_host_trace__deps: ["$UTF8ToString"],
  cbx_host_trace: (ptr, len) => {
    Module.cbxHost.trace(UTF8ToString(ptr, len));
  },
});
