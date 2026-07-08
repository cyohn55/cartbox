// Visual verification of the cartridge-shell cards in Browse and Library.
//
// Drives Windows Chrome over CDP (see verify-console.mjs for the WSL setup):
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-cartridge-cards.mjs
//
// Env overrides: CBX_BASE_URL (default http://localhost:3000),
//                CBX_CDP_URL  (default http://127.0.0.1:9222),
//                CBX_SHOT_DIR (default C:\Temp\cbx-verify).

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(OUT, { recursive: true });
const shot = (name) => `${OUT}/${name}.png`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

/** Presses a shell button the way a thumb does: pointerdown, then pointerup. */
async function pressShellButton(page, label) {
  const button = page.getByRole("button", { name: label, exact: true });
  await button.dispatchEvent("pointerdown", { pointerId: 1 });
  await button.dispatchEvent("pointerup", { pointerId: 1 });
}

/** Asserts every card in the current grid shows the shell with the label on it. */
async function auditGrid(page, screenName) {
  const cards = page.locator(".os-cart-card");
  const cardCount = await cards.count();
  check(`${screenName}: cartridge cards present`, cardCount > 0, `${cardCount} cards`);
  if (cardCount === 0) {
    return;
  }

  const shellCount = await page.locator(".os-cart-card .os-cart-shell-img").count();
  check(`${screenName}: every card has the cartridge shell`, shellCount === cardCount);

  const labelCount = await page.locator(".os-cart-card .os-cart-label").count();
  check(`${screenName}: every card has a label (cover or placeholder)`, labelCount === cardCount);

  // The cover must sit inside the shell, horizontally centered on it.
  const layout = await page
    .locator(".os-cart-card .os-cart-shell")
    .first()
    .evaluate((shell) => {
      const shellRect = shell.getBoundingClientRect();
      const labelRect = shell.querySelector(".os-cart-label").getBoundingClientRect();
      return {
        inside:
          labelRect.left >= shellRect.left &&
          labelRect.right <= shellRect.right &&
          labelRect.top >= shellRect.top &&
          labelRect.bottom <= shellRect.bottom,
        centerDrift: Math.abs(
          (labelRect.left + labelRect.right) / 2 - (shellRect.left + shellRect.right) / 2,
        ),
      };
    });
  check(`${screenName}: cover sits inside the shell`, layout.inside);
  check(`${screenName}: cover is centered on the shell`, layout.centerDrift < 2, `drift ${layout.centerDrift.toFixed(1)}px`);

  // The cover is drawn 15% wider than the recess-fitted 76% → 87.4%. Measure
  // against the front face — the plane the cover sits on — because the face
  // itself projects slightly larger than the shell (it is translateZ'd
  // toward the viewer under perspective).
  const widthRatio = await page
    .locator(".os-cart-card .os-cart-face-front")
    .first()
    .evaluate((face) => {
      const labelRect = face.querySelector(".os-cart-label").getBoundingClientRect();
      return labelRect.width / face.getBoundingClientRect().width;
    });
  check(
    `${screenName}: cover is 15% enlarged (≈87.4% of shell width)`,
    Math.abs(widthRatio - 0.874) < 0.01,
    `${(widthRatio * 100).toFixed(1)}%`,
  );

  // The cover must out-stack the CRT film so the art stays crisp.
  const stacking = await page.evaluate(() => {
    const stage = document.querySelector(".os-stage.os-shell");
    const shell = document.querySelector(".os-cart-shell");
    return {
      film: Number(getComputedStyle(stage, "::after").zIndex),
      shell: Number(getComputedStyle(shell).zIndex),
    };
  });
  check(
    `${screenName}: cartridge stacks above the CRT film`,
    stacking.shell > stacking.film,
    `shell z ${stacking.shell} vs film z ${stacking.film}`,
  );

  // A real 3D box: four faces per cartridge on a preserve-3d body, and the
  // back/side textures actually resolve.
  const box = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".os-cart-card")];
    const boxed = cards.filter((card) => card.querySelectorAll(".os-cart-face").length === 4).length;
    const body = document.querySelector(".os-cart-3d");
    const facesLoaded = [...document.querySelectorAll(".os-cart-face-img")]
      .slice(0, 3)
      .every((img) => img.complete && img.naturalWidth > 0);
    return { cards: cards.length, boxed, style: getComputedStyle(body).transformStyle, facesLoaded };
  });
  check(`${screenName}: every cartridge is a four-faced 3D box`, box.boxed === box.cards, `${box.boxed}/${box.cards}`);
  check(`${screenName}: cartridge body preserves 3D`, box.style === "preserve-3d", box.style);
  check(`${screenName}: back/side face textures load`, box.facesLoaded);

  const shellLoaded = await page
    .locator(".os-cart-card .os-cart-shell-img")
    .first()
    .evaluate((img) => img.complete && img.naturalWidth > 0);
  check(`${screenName}: cartridge PNG actually loads`, shellLoaded);
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await phone.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
  await page.getByTestId("title-screen").waitFor({ timeout: 15000 });
  await pressShellButton(page, "Start");
  await page.getByTestId("auth-screen").waitFor({ timeout: 5000 });
  // Sign in with the local seed account so the Library shelf has carts on it.
  await page.getByPlaceholder("you@email.com").fill("demo@cartbox.dev");
  await page.getByPlaceholder("password").fill("demo1234");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("home-feed").waitFor({ timeout: 10000 });

  await page.getByRole("button", { name: "BROWSE" }).click();
  await page.getByTestId("browse-screen").waitFor({ timeout: 8000 });
  await page.locator(".os-grid-card, .os-empty").first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await auditGrid(page, "Browse");
  await page.screenshot({ path: shot("cart-browse") });

  // The TIC-80 ARCADE tab lists carts with real cover art — verify a cover
  // image (not just the placeholder) composites onto the label.
  await page.getByRole("tab", { name: "TIC-80 ARCADE" }).click();
  await page.locator("img.os-cart-label").first().waitFor({ timeout: 15000 });
  // Covers lazy-load from tic80.com — poll until at least one has pixels.
  const coverLoaded = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll("img.os-cart-label")].some(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      undefined,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check("Arcade: real cover art loads on the label", coverLoaded);
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot("cart-arcade") });
  await page.getByRole("tab", { name: "CARTBOX", exact: true }).click();
  await page.locator(".os-grid-card, .os-empty").first().waitFor({ timeout: 10000 });

  await page.getByRole("button", { name: "LIBRARY" }).click();
  await page.getByTestId("library-screen").waitFor({ timeout: 5000 });
  await page.locator(".os-grid-card, .os-empty").first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await auditGrid(page, "Library");
  await page.screenshot({ path: shot("cart-library") });

  // The D-pad must walk the grid and never wander onto the tab bar.
  await pressShellButton(page, "Down");
  let cursorTouchedTabs = false;
  for (let press = 0; press < 8; press += 1) {
    await pressShellButton(page, "Down");
    await page.waitForTimeout(120);
    const onTab = await page.evaluate(
      () => document.activeElement?.classList.contains("os-tab") ?? false,
    );
    cursorTouchedTabs = cursorTouchedTabs || onTab;
  }
  check("D-pad down never lands on the tab bar", !cursorTouchedTabs);

  // Tabs are cycled with the shoulders instead.
  await pressShellButton(page, "R1");
  const r1Cycled = await page
    .getByTestId("profile-screen")
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check("R1 cycles Library → Profile", r1Cycled);
  await pressShellButton(page, "L1");
  await page.getByTestId("library-screen").waitFor({ timeout: 3000 });
  check("L1 cycles back to Library", true);
  await page.locator("button.os-cart-card").first().waitFor({ timeout: 10000 });

  // Hovering (or D-pad focusing) a cart rocks it — once, not forever.
  const hoverCard = page.locator("button.os-cart-card").first();
  await hoverCard.hover();
  const wobble = await hoverCard.locator(".os-cart-3d").evaluate((shell) => {
    const style = getComputedStyle(shell);
    return { name: style.animationName, iterations: style.animationIterationCount };
  });
  check("hovered cart runs the selection wobble", wobble.name === "os-cart-wobble", wobble.name);
  check("wobble plays a single cycle", wobble.iterations === "1", `iterations: ${wobble.iterations}`);

  // Selecting a cart spins it three times, flies it to the screen center
  // while it grows, THEN boots it.
  const shellBefore = await hoverCard.locator(".os-cart-3d").boundingBox();
  const selectedAt = Date.now();
  await hoverCard.click();
  const launching = await page
    .locator('[data-launching="true"] .os-cart-3d')
    .waitFor({ timeout: 1000 })
    .then(() => true)
    .catch(() => false);
  check("selection enters the launch state", launching);
  if (launching) {
    const launchName = await page
      .locator('[data-launching="true"] .os-cart-3d')
      .evaluate((shell) => getComputedStyle(shell).animationName);
    check("launch runs the triple-spin animation", launchName === "os-cart-launch", launchName);

    // Sample the live matrix during the spin phase: a real rotation must
    // pass through back-facing angles (matrix3d m11 < 0 ⇔ the cartridge is
    // showing its back). A collapsed interpolation never leaves ~1.
    let sawBackFacing = false;
    for (let sample = 0; sample < 11 && !sawBackFacing; sample += 1) {
      await page.waitForTimeout(60);
      sawBackFacing = await page
        .locator('[data-launching="true"] .os-cart-3d')
        .evaluate((el) => {
          const transform = getComputedStyle(el).transform;
          return transform.startsWith("matrix3d") && Number(transform.slice(9).split(",")[0]) < -0.2;
        })
        .catch(() => false);
    }
    check("spin rotates through back-facing angles", sawBackFacing);

    // Mid-flight toward the screen center (spin 0–0.72s, flight 0.72–1.44s).
    await page.waitForTimeout(Math.max(0, selectedAt + 1270 - Date.now()));
    const shellMid = await page
      .locator('[data-launching="true"] .os-cart-3d')
      .boundingBox()
      .catch(() => null);
    check(
      "cartridge grows as it flies to the screen",
      shellBefore !== null && shellMid !== null && shellMid.width > shellBefore.width * 1.2,
      shellBefore && shellMid
        ? `${shellBefore.width.toFixed(0)}px → ${shellMid.width.toFixed(0)}px wide`
        : "shell box unavailable",
    );
    await page.screenshot({ path: shot("cart-launch-zoom") });
  }
  await page.getByTestId("game-screen").waitFor({ timeout: 20000 });
  const bootDelay = Date.now() - selectedAt;
  check("boot waits for the spin + flight (≥1.35s)", bootDelay >= 1350, `${bootDelay}ms`);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await phone.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
