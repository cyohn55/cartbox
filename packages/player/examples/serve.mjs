// Minimal static server for the player smoke test. Serves the monorepo root so
// the demo page can reach the player build, the engine WASM, and the cart with
// the correct MIME types (WebAssembly and ES modules are MIME-sensitive).
//
// Usage:  node packages/player/examples/serve.mjs [port]
// Then open:  http://localhost:<port>/packages/player/examples/smoke-test.html

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root is three levels up from packages/player/examples/.
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PORT = Number(process.argv[2] ?? 8099);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".tic": "application/octet-stream",
  ".css": "text/css",
  ".json": "application/json",
};

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const filePath = path.join(ROOT, urlPath);

  // Prevent path traversal outside the served root.
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    return res.end("forbidden");
  }

  try {
    const data = await readFile(filePath);
    res.setHeader("Content-Type", MIME[path.extname(filePath)] ?? "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Serving ${ROOT}`);
  console.log(`Open: http://localhost:${PORT}/packages/player/examples/smoke-test.html`);
});
