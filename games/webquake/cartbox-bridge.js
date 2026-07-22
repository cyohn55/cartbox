/**
 * Cartbox console bridge for the WebQuake boot page (not upstream WebQuake).
 *
 * The handheld host (QuakePlayer) mounts the WebQuake page in a same-origin
 * iframe and needs the same lifecycle contract the ScummVM / SuperTux / DOS boot
 * pages provide: a postMessage saying when the engine is live, and one turning a
 * fatal engine error into a host-visible state instead of a browser dialog and a
 * black canvas. WebQuake has no Emscripten Module object to hook, so this bridge
 * observes the engine's own DOM signals instead.
 *
 * Loaded from <head> ahead of the engine scripts so its alert/error overrides are
 * installed before any WebQuake code can run.
 */
(function () {
  function post(message) {
    try {
      parent.postMessage(Object.assign({ source: "cartbox-quake" }, message), "*");
    } catch (err) {
      /* cross-origin parent — nothing to do */
    }
  }

  // WebQuake reports fatal problems through window.alert (Sys.Error) and then
  // throws. Route both to the host so it can show its EJECT affordance rather
  // than leaving a dead canvas behind a dismissed dialog.
  window.alert = function (text) {
    post({ type: "error", message: String(text) });
  };
  window.addEventListener("error", function (event) {
    post({ type: "error", message: String((event && event.message) || "Quake error") });
  });

  // Readiness: WebQuake's VID.Init sets the "Starting Quake…" progress element to
  // display:none the moment the renderer is up and the first frame is about to
  // draw. Watch that transition rather than sampling the canvas.
  function watchReady() {
    var progress = document.getElementById("progress");
    if (progress == null) {
      requestAnimationFrame(watchReady);
      return;
    }
    var announced = false;
    function check() {
      if (announced) return;
      if (window.getComputedStyle(progress).display === "none") {
        announced = true;
        post({ type: "runtime-initialized" });
      }
    }
    new MutationObserver(check).observe(progress, { attributes: true, attributeFilter: ["style"] });
    // The style may be set before the observer binds, so poll for a short while
    // as a backstop. Stops as soon as readiness is announced.
    var tries = 0;
    (function poll() {
      check();
      if (!announced && tries++ < 600) setTimeout(poll, 100);
    })();
  }

  window.addEventListener("load", function () {
    // Keep keyboard focus on the canvas when tapped; WebQuake listens on window,
    // but focusing prevents the surrounding page from swallowing keys.
    var canvas = document.getElementById("mainwindow");
    if (canvas != null) {
      canvas.addEventListener("click", function () {
        try {
          canvas.focus();
        } catch (err) {
          /* focus is best-effort */
        }
      });
    }
    watchReady();
  });
})();
