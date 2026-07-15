// Verify the signup DB trigger creates a profile with the chosen username, and
// that a handle collision falls back to a suffixed handle (account never fails).
// Run with WSL node from repo root: node scripts/verify-signup-trigger.mjs

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE = process.env.SUPABASE_SERVICE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const admin = createClient(SUPABASE_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const created = [];
let ok = true;
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  ok = ok && pass;
};

async function makeUser(handle) {
  const email = `trigger-${handle}-${Date.now()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
    user_metadata: { handle },
  });
  if (error) throw error;
  created.push(data.user.id);
  return data.user.id;
}

async function profileHandle(userId) {
  const { data } = await admin.from("profiles").select("handle, handheld").eq("id", userId).maybeSingle();
  return data;
}

try {
  const wanted = `trigmaker_${Date.now().toString(36)}`;

  // 1. A new user gets a profile with exactly the chosen username, no handheld.
  const first = await makeUser(wanted);
  const firstProfile = await profileHandle(first);
  check("trigger created a profile with the chosen username", firstProfile?.handle === wanted, JSON.stringify(firstProfile));
  check("new profile has no handheld yet (gate will fire)", firstProfile?.handheld == null, JSON.stringify(firstProfile?.handheld));

  // 2. A second user wanting the same handle still succeeds, with a suffix.
  const second = await makeUser(wanted);
  const secondProfile = await profileHandle(second);
  check("handle collision falls back to a suffixed handle", secondProfile?.handle?.startsWith(wanted + "_"), secondProfile?.handle);
  check("collision handle is still unique", secondProfile?.handle !== wanted, secondProfile?.handle);
} catch (error) {
  check("no exceptions", false, error?.message ?? String(error));
} finally {
  for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
}

console.log(ok ? "\nALL GREEN" : "\nFAILURES ABOVE");
process.exitCode = ok ? 0 : 1;
