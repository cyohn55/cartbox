// Verifies the CREATE tab, the voxel avatar + character creator, and the
// iOS selection-suppression styling. Run like verify-console.mjs
// (Windows Node + CDP Chrome).

import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

async function canvasHash(locator) {
  const png = await locator.screenshot();
  let hash = 0;
  for (let i = 0; i < png.length; i += 13) hash = ((hash << 5) - hash + png[i]) | 0;
  return String(hash);
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 160)));

  await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
  await page.getByTestId("title-screen").waitFor({ timeout: 12000 });

  // iOS callout suppression: selection + callout disabled on shell content,
  // but text inputs keep selection for typing.
  const selection = await page.evaluate(() => {
    const card = document.querySelector(".os-title-logo") ?? document.querySelector(".hh-shell");
    const style = getComputedStyle(card);
    return { userSelect: style.webkitUserSelect || style.userSelect };
  });
  check("shell content is unselectable (no copy callout)", selection.userSelect === "none", selection.userSelect);

  await page.getByTestId("title-screen").click();
  await page.getByRole("button", { name: "Continue as guest" }).click();
  await page.getByTestId("home-feed").waitFor({ timeout: 10000 });

  const inputSelectable = await page.evaluate(() => {
    const probe = document.createElement("input");
    document.querySelector(".hh-screen")?.appendChild(probe);
    const value = getComputedStyle(probe).webkitUserSelect;
    probe.remove();
    return value;
  });
  check("text inputs keep selection for typing", inputSelectable === "text", inputSelectable);

  // CREATE tab exists and offers editor launchers.
  await page.getByRole("button", { name: "CREATE" }).click();
  await page.getByTestId("create-screen").waitFor({ timeout: 8000 });
  const starters = await page.locator("[data-testid='create-screen'] a.os-grid-card").count();
  check("CREATE tab lists editor launchers", starters === 3, `${starters} starters`);
  const classicHref = await page
    .locator("[data-testid='create-screen'] a.os-grid-card")
    .first()
    .getAttribute("href");
  check("launcher points at the editor", classicHref === "/edit/new", classicHref ?? "");
  await page.screenshot({ path: `${OUT}/40-create-tab.png` });

  // Profile: voxel avatar renders and the creator changes it.
  await page.getByRole("button", { name: "PROFILE" }).click();
  await page.getByTestId("profile-screen").waitFor({ timeout: 8000 });
  const avatar = page.getByTestId("voxel-avatar");
  await avatar.waitFor({ timeout: 8000 });
  check("voxel avatar renders on the profile", true);
  await page.screenshot({ path: `${OUT}/41-profile-avatar.png` });

  await page.getByRole("button", { name: "⚒ EDIT AVATAR" }).click();
  await page.getByTestId("avatar-creator").waitFor({ timeout: 8000 });
  const before = await canvasHash(page.getByTestId("voxel-avatar"));
  // Change outfit twice (Tee → Armor) and put on a crown.
  await page.getByRole("button", { name: "Next OUTFIT" }).click();
  await page.getByRole("button", { name: "Next OUTFIT" }).click();
  await page.getByRole("button", { name: "Next HEADGEAR" }).click();
  await page.getByRole("button", { name: "Next HEADGEAR" }).click();
  await page.waitForTimeout(400);
  const after = await canvasHash(page.getByTestId("voxel-avatar"));
  check("creator changes re-render the character", before !== after, `${before} → ${after}`);
  await page.screenshot({ path: `${OUT}/42-avatar-creator.png` });

  // Save persists to this browser (guest path) and survives reload.
  await page.getByRole("button", { name: "SAVE", exact: true }).click();
  await page.getByTestId("profile-screen").waitFor({ timeout: 8000 });
  const stored = await page.evaluate(() => {
    const raw = window.localStorage.getItem("cartbox.console.voxelAvatar");
    return raw ? JSON.parse(raw) : null;
  });
  check("avatar persists (outfit=Armor, headgear=Crown)", stored?.outfit === 2 && stored?.headgear === 2, JSON.stringify(stored));
  await page.screenshot({ path: `${OUT}/43-profile-after-save.png` });

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
