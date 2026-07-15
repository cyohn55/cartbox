// End-to-end onboarding flow in the real app over CDP (Windows Chrome), with
// local email confirmation OFF: sign up (username+email+password) -> land on the
// handheld screen -> the profile route gates back to onboarding until a handheld
// is chosen -> choosing one grants profile access. Cleans up the test user.
//
//   node scripts/verify-signup-flow.mjs
// Env: CBX_BASE_URL (default http://localhost:3000), CBX_CDP_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE = process.env.SUPABASE_SERVICE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const admin = createClient(SUPABASE_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const stamp = Date.now().toString(36);
const username = `flowuser_${stamp}`;
const email = `flow-${stamp}@example.com`;
const password = "test-password-123";

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => {
    if (r.url().includes("/api/console/me/handheld")) console.log(`  [net] ${r.request().method()} handheld -> ${r.status()}`);
  });

  // 1. Sign up with a username.
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  const toggle = page.getByRole("button", { name: "Create one" });
  await toggle.waitFor({ timeout: 20000 });
  // Retry the toggle until the username field appears (guards React hydration).
  const username$ = page.getByPlaceholder("username");
  for (let attempt = 0; attempt < 5 && !(await username$.isVisible().catch(() => false)); attempt += 1) {
    await toggle.click().catch(() => {});
    await page.waitForTimeout(500);
  }
  await username$.waitFor({ timeout: 10000 }).catch(async () => {
    await page.screenshot({ path: "C:\\Temp\\cbx-verify\\signup-debug.png" });
  });
  await username$.fill(username);
  await page.getByPlaceholder("you@email.com").fill(email);
  await page.getByPlaceholder("password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();

  // 2. New account lands on the handheld selection step.
  await page.waitForURL("**/onboarding/handheld**", { timeout: 20000 });
  check("signup routes new account to the handheld step", page.url().includes("/onboarding/handheld"), page.url());
  await page.locator("canvas").waitFor({ timeout: 20000 });

  // 3. The profile route gates back to onboarding until a handheld is chosen.
  await page.goto(BASE + "/profile/edit", { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/onboarding/handheld**", { timeout: 15000 }).catch(() => {});
  check("profile route gates back to onboarding without a handheld", page.url().includes("/onboarding/handheld"), page.url());

  // 4. Choose a handheld and save — grants profile access.
  await page.locator("canvas").waitFor({ timeout: 20000 });
  await page.waitForFunction(() => {
    const c = document.querySelector("canvas");
    if (!c || c.width < 100) return false;
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  }, { timeout: 20000 });
  await page.getByRole("button", { name: /Bubblegum/i }).click();
  await page.getByRole("button", { name: /Use this handheld/i }).click();
  await page.waitForTimeout(1500);
  const onScreenError = await page.locator("[class*='error']").first().textContent().catch(() => null);
  if (onScreenError) console.log(`  [ui error] ${onScreenError}`);

  // 5. Now the profile page renders instead of redirecting.
  await page.waitForURL("**/profile/edit", { timeout: 20000 });
  const onProfile = page.url().endsWith("/profile/edit");
  const heading = await page.getByRole("heading", { name: /Your avatar/i }).isVisible().catch(() => false);
  check("choosing a handheld grants profile access", onProfile && heading, `${page.url()} heading=${heading}`);

  // 6. The chosen handheld persisted to the profile.
  const { data: user } = await admin.auth.admin.listUsers();
  const created = user.users.find((u) => u.email === email);
  const { data: profile } = await admin.from("profiles").select("handle, handheld").eq("id", created?.id).maybeSingle();
  check("username persisted as the profile handle", profile?.handle === username, profile?.handle);
  check("handheld persisted for the account", profile?.handheld?.presetId === "bubblegum", JSON.stringify(profile?.handheld?.presetId));

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  // Cleanup.
  if (created?.id) await admin.auth.admin.deleteUser(created.id).catch(() => {});

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exitCode = passed === results.length ? 0 : 1;
} finally {
  await browser.close();
}
