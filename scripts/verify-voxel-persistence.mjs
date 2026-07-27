// End-to-end verification that a voxel sculpt survives a reload: the save leg
// (editor → PUT /api/carts/[cartId]/voxel → carts.voxel) and the load leg
// (cart row → /edit/[cartId] → the Voxel tab) against a real database.
//
// Drives the real user path in a real browser: create an account, open a new
// cart, sculpt a couple of cubes and skin one with a sprite, Save, reload, and
// confirm the sculpt and its sprite material came back. Then checks the route's
// refusals — an unauthenticated save, a malformed payload, and someone else's
// cart — against the live endpoint.
//
// Needs local Supabase running with the migrations applied (`supabase start`),
// and a dev server pointed at it. Designed for the WSL setup, where Linux
// browsers can't run but Windows Chrome can:
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-voxel-persistence.mjs
//
// Env overrides: CBX_BASE_URL   (default http://localhost:3000)
//                CBX_CDP_URL    (default http://127.0.0.1:9222)
//                CBX_SUPABASE_URL (default http://127.0.0.1:55321)
//                CBX_SERVICE_KEY  (local demo service-role key by default)
//                CBX_SHOT_DIR   (default C:\Temp\cbx-verify).

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const SUPABASE = process.env.CBX_SUPABASE_URL ?? "http://127.0.0.1:55321";
const SERVICE_KEY =
  process.env.CBX_SERVICE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(OUT, { recursive: true });
const shot = (name) => `${OUT}/${name}.png`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const serviceHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

/** Create a confirmed account straight through the auth admin API. */
async function createAccount(label) {
  const email = `voxel-${label}-${process.pid}@example.com`;
  const password = "voxel-verify-pw";
  const response = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!response.ok) throw new Error(`could not create ${label}: ${response.status} ${await response.text()}`);
  const user = await response.json();
  return { id: user.id, email, password };
}

/** A bearer token for an account, as the app's own client would hold. */
async function signIn({ email, password }) {
  const response = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  return (await response.json()).access_token;
}

/** Read a cart row back from the database, bypassing the app entirely. */
async function readCartRow(cartId) {
  const response = await fetch(`${SUPABASE}/rest/v1/carts?id=eq.${cartId}&select=id,owner_id,voxel`, {
    headers: serviceHeaders,
  });
  const [row] = await response.json();
  return row ?? null;
}

/** Sign into the app in the browser, the way a person does. */
async function signInThroughUi(page, account) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.locator('input[type="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/** Open the Voxel tab and report how many cubes the sculpt holds. */
async function cubeCount(page) {
  await page.getByRole("button", { name: "Voxel", exact: true }).click();
  await page.locator('canvas[aria-label^="3D voxel model"]').waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  // The HUD renders the label and its value as sibling spans ("Cubes" / "12"),
  // uppercased by CSS — so read the value beside the label rather than the text.
  const label = page.getByText(/^(Cubes|Hexels)$/).first();
  await label.waitFor({ timeout: 30_000 });
  const value = await label.locator("xpath=following-sibling::span[1]").innerText();
  return Number(value.replace(/\D+/g, ""));
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const owner = await createAccount("owner");
  const stranger = await createAccount("stranger");
  check("test accounts exist", Boolean(owner.id && stranger.id));

  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await signInThroughUi(page, owner);
  check("signed in", !page.url().includes("/login"), page.url());

  // --- Sculpt, skin, save --------------------------------------------------
  await page.goto(`${BASE}/edit/new`, { waitUntil: "networkidle" });
  await page.waitForURL(/\/edit\/(?!new)/, { timeout: 30_000 });
  const cartId = new URL(page.url()).pathname.split("/").pop();

  // Draw a sprite so it can skin a voxel, then build on the sculpt.
  const spriteCanvas = page.getByRole("img", { name: /^Sprite \d+,/ }).first();
  await spriteCanvas.waitFor({ state: "visible" });
  const drawnSprite = (await spriteCanvas.getAttribute("aria-label")).match(/^Sprite (\d+)/)[1];
  const spriteBox = await spriteCanvas.boundingBox();
  for (const [fx, fy] of [[0.3, 0.35], [0.5, 0.5], [0.68, 0.42]]) {
    await page.mouse.click(spriteBox.x + spriteBox.width * fx, spriteBox.y + spriteBox.height * fy);
    await page.waitForTimeout(80);
  }

  const seeded = await cubeCount(page);
  const preview = page.locator('canvas[aria-label^="3D voxel model"]');
  const previewBox = await preview.boundingBox();
  // Add tool is active by default: clicking a face grows a cube against it.
  for (const [fx, fy] of [[0.5, 0.45], [0.52, 0.44]]) {
    await page.mouse.click(previewBox.x + previewBox.width * fx, previewBox.y + previewBox.height * fy);
    await page.waitForTimeout(300);
  }
  const sculpted = await cubeCount(page);
  check("the sculpt grew before saving", sculpted > seeded, `${seeded} → ${sculpted} cubes`);

  // Skin a voxel with the drawn sprite, so the sidecar carries a sprite material.
  await page.getByRole("button", { name: /Tiles/ }).first().click();
  await page.getByLabel("Sprite number for the side faces").fill(drawnSprite);
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Add sprite material" }).click();
  await page.waitForTimeout(200);
  await page.mouse.click(previewBox.x + previewBox.width * 0.5, previewBox.y + previewBox.height * 0.45);
  await page.waitForTimeout(400);
  check("a sprite material is armed on the sculpt", (await page.getByRole("button", { name: /^Sprite material/ }).count()) === 1);

  const apiCalls = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/carts")) apiCalls.push(`${response.status()} ${url.pathname}`);
  });
  await page.getByRole("button", { name: /^Save/ }).click();
  // Wait for the save to settle either way, so a failure reports its own reason
  // (and the API calls behind it) instead of timing out anonymously.
  const saveButton = page.getByRole("button", { name: /^(Save|Saving|Saved|Retry)/ });
  await page
    .getByRole("button", { name: /^(Saved|Retry)/ })
    .waitFor({ timeout: 60_000 })
    .catch(() => {});
  const saveLabel = (await saveButton.innerText()).trim();
  check(
    "the editor reports the cart saved",
    saveLabel.includes("Saved"),
    `${saveLabel} · ${apiCalls.join(", ") || "no /api/carts calls"}`,
  );
  check("the sculpt was PUT to its own endpoint", apiCalls.some((call) => call.startsWith("200 ") && call.endsWith("/voxel")), apiCalls.join(", "));
  await page.screenshot({ path: shot("voxel-persist-saved") });

  // --- The database really holds it ---------------------------------------
  const row = await readCartRow(cartId);
  check("the cart row stores a sculpt", Boolean(row?.voxel), row?.voxel ? `${row.voxel.length} chars` : "empty");
  const stored = row?.voxel ? JSON.parse(row.voxel) : null;
  check(
    "the stored payload carries the sprite material with the sculpt",
    stored?.kind === "cartbox.voxel" && stored.spriteMaterials?.length === 1,
    stored ? `kind=${stored.kind}, skins=${stored.spriteMaterials?.length}` : "nothing stored",
  );
  const storedCubes = stored ? JSON.parse(stored.grid).count : 0;
  check("and the same number of cubes the editor showed", storedCubes === sculpted, `${storedCubes} vs ${sculpted}`);

  // --- Reload: the sculpt comes back --------------------------------------
  await page.goto(`${BASE}/edit/${cartId}`, { waitUntil: "networkidle" });
  const reloaded = await cubeCount(page);
  check("the sculpt survives a reload", reloaded === sculpted, `${reloaded} vs ${sculpted} cubes`);
  await page.getByRole("button", { name: /Tiles/ }).first().click();
  await page.waitForTimeout(300);
  check(
    "and so does its sprite material",
    (await page.getByRole("button", { name: /^Sprite material/ }).count()) === 1,
  );
  await page.screenshot({ path: shot("voxel-persist-reloaded") });

  // --- The route's refusals, against the live endpoint ---------------------
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);
  const put = (token, body, id = cartId) =>
    fetch(`${BASE}/api/carts/${id}/voxel`, {
      method: "PUT",
      headers: token
        ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
        : { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  check("a signed-out save is refused", (await put(null, { voxel: row.voxel })).status === 401);
  check("another author's save is refused", (await put(strangerToken, { voxel: row.voxel })).status === 403);
  check("a malformed sculpt is refused", (await put(ownerToken, { voxel: "not a sculpt" })).status === 400);
  check(
    "an oversized sculpt is refused",
    (await put(ownerToken, { voxel: `{"sizeX":4,"sizeY":4,"sizeZ":4,"pad":"${"x".repeat(4_000_001)}"}` })).status === 400,
  );
  check("a sculpt claiming an impossible volume is refused", (await put(ownerToken, {
    voxel: JSON.stringify({ version: 3, sizeX: 9999, sizeY: 4, sizeZ: 4, count: 0 }),
  })).status === 400);
  check("the owner's own save is accepted", (await put(ownerToken, { voxel: row.voxel })).status === 200);

  // Clearing the sculpt is a legitimate save, and empties the column.
  check("clearing the sculpt is accepted", (await put(ownerToken, { voxel: null })).status === 200);
  check("and the column is emptied", (await readCartRow(cartId))?.voxel === null);

  check("no page errors", errors.length === 0, errors.join(" | "));
  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots: ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);
