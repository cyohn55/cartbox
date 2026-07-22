/**
 * Cartbox console bridge for the BananaBread (Cube 2) boot page. Not upstream.
 *
 * Gives the handheld host (Cube2Player) the same lifecycle contract the other
 * iframe runtimes use: a postMessage when the engine is live, and one turning a
 * fatal engine error into a host-visible state instead of a browser alert + a
 * dead canvas. BananaBread exposes Module hooks (postLoadWorld) and a
 * `BananaBread.execute` console, which cartbox-boot.html uses to signal readiness
 * and apply the control binds; this bridge only covers errors and is loaded
 * before the engine so its overrides win.
 */
(function () {
  function post(message) {
    try {
      parent.postMessage(Object.assign({ source: "cartbox-cube2" }, message), "*");
    } catch (err) {
      /* cross-origin parent — nothing to do */
    }
  }

  // BananaBread pops a browser alert on a lost WebGL context and on fatal errors.
  // Route those to the host instead.
  window.alert = function (text) {
    post({ type: "error", message: String(text) });
  };
  window.addEventListener("error", function (event) {
    post({ type: "error", message: String((event && event.message) || "Cube 2 error") });
  });

  // cartbox-boot.html calls this from Module.postLoadWorld once the world (and the
  // control binds) are up.
  window.cartboxCube2Ready = function () {
    post({ type: "runtime-initialized" });
  };
})();
