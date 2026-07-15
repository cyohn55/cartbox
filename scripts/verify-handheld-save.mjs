// Verify the handheld save path end-to-end against the real API + local DB:
// create a confirmed user + profile, sign in for a token, PUT a custom scheme,
// and read it back from profiles.handheld. Run with WSL node from repo root:
//   node scripts/verify-handheld-save.mjs
// Env overrides: CBX_BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE = process.env.SUPABASE_SERVICE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const admin = createClient(SUPABASE_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const anon = createClient(SUPABASE_URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

const email = `handheld-test-${Date.now()}@example.com`;
const password = "test-password-123";
let userId = null;
let ok = true;
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  ok = ok && pass;
};

try {
  // 1. Create a confirmed user + their profile row (the API updates profiles).
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  userId = created.data.user.id;
  const handle = `handheld_test_${Date.now().toString(36)}`;
  const profile = await admin.from("profiles").insert({ id: userId, handle }).select().maybeSingle();
  if (profile.error) throw profile.error;

  // 2. Sign in for a real access token.
  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  const token = signIn.data.session.access_token;

  // 3. PUT a recoloured scheme (face -> pure red, presetId custom).
  const handheld = {
    presetId: "custom",
    scheme: {
      face: "#ff0000",
      buttonLetter: "#ffffff",
      dpadArrow: "#ffffff",
      lButton: "#111111",
      rButton: "#111111",
      buttonDiamond: "#222222",
      dpadRing: "#333333",
    },
  };
  const response = await fetch(`${BASE}/api/console/me/handheld`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ handheld }),
  });
  check("PUT /api/console/me/handheld succeeds", response.ok, `HTTP ${response.status}`);
  const returned = await response.json().catch(() => null);
  check("response echoes the normalized skin", returned?.handheld?.scheme?.face === "#ff0000", JSON.stringify(returned?.handheld?.scheme));

  // 4. Read it back straight from the DB.
  const row = await admin.from("profiles").select("handheld").eq("id", userId).maybeSingle();
  const stored = row.data?.handheld;
  check("scheme persisted to profiles.handheld", stored?.scheme?.face === "#ff0000", JSON.stringify(stored));
  check("preset id persisted", stored?.presetId === "custom", stored?.presetId);

  // 5. A malformed colour is repaired, not stored verbatim (the normalize gate).
  const bad = await fetch(`${BASE}/api/console/me/handheld`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ handheld: { presetId: "iron-man", scheme: { face: "javascript:evil" } } }),
  });
  const badBody = await bad.json().catch(() => null);
  check("malformed colour is rejected/normalized", /^#[0-9a-f]{6}$/.test(badBody?.handheld?.scheme?.face ?? ""), JSON.stringify(badBody?.handheld?.scheme?.face));
} catch (error) {
  check("no exceptions", false, error?.message ?? String(error));
} finally {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
}

console.log(ok ? "\nALL GREEN" : "\nFAILURES ABOVE");
process.exitCode = ok ? 0 : 1;
