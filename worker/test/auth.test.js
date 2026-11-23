import test from "node:test";
import assert from "node:assert/strict";
import { login, logout, requireDashboard, verifySessionToken } from "../src/auth.js";

function createEnv() {
  const values = new Map();
  return {
    DASHBOARD_PASSWORD: "a-long-dashboard-password-2026",
    SESSION_SECRET: "s".repeat(64),
    SESSION_TTL_SECONDS: "3600",
    SITE_ORIGIN: "https://mehrdadmb2.github.io",
    STATE: {
      async get(key) { return values.get(key) ?? null; },
      async put(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); }
    }
  };
}

function loginRequest(password, origin = "https://mehrdadmb2.github.io", ip = "192.0.2.10") {
  return new Request("https://repoforge-worker.test/api/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ password })
  });
}

test("dashboard login creates a signed, revocable session", async () => {
  const env = createEnv();
  const response = await login(loginRequest(env.DASHBOARD_PASSWORD), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(await verifySessionToken(body.token, env), true);

  const dashboardRequest = new Request("https://repoforge-worker.test/api/session", {
    headers: { Origin: env.SITE_ORIGIN, Authorization: `Bearer ${body.token}` }
  });
  assert.equal(await requireDashboard(dashboardRequest, env), true);

  const logoutRequest = new Request("https://repoforge-worker.test/api/logout", {
    method: "POST", headers: { Authorization: `Bearer ${body.token}` }
  });
  await logout(logoutRequest, env);
  assert.equal(await verifySessionToken(body.token, env), false);
});

test("dashboard login rejects an unapproved Origin", async () => {
  const env = createEnv();
  const response = await login(loginRequest(env.DASHBOARD_PASSWORD, "https://evil.example"), env);
  assert.equal(response.status, 403);
});

test("dashboard login rate-limits repeated failed passwords", async () => {
  const env = createEnv();
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await login(loginRequest("wrong-password", env.SITE_ORIGIN, "192.0.2.20"), env);
    assert.equal(response.status, 401);
  }
  const limited = await login(loginRequest("wrong-password", env.SITE_ORIGIN, "192.0.2.20"), env);
  assert.equal(limited.status, 429);
});


test("dashboard accepts a one-character password and one-character session secret", async () => {
  const env = createEnv();
  env.DASHBOARD_PASSWORD = "x";
  env.SESSION_SECRET = "s";
  const response = await login(loginRequest("x"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(await verifySessionToken(body.token, env), true);
});

test("dashboard rejects empty configured secrets without requiring a minimum length", async () => {
  const env = createEnv();
  env.DASHBOARD_PASSWORD = "";
  const missingPassword = await login(loginRequest("x"), env);
  assert.equal(missingPassword.status, 503);

  env.DASHBOARD_PASSWORD = "x";
  env.SESSION_SECRET = "";
  const missingSessionSecret = await login(loginRequest("x"), env);
  assert.equal(missingSessionSecret.status, 503);
});

test("dashboard rejects an empty submitted password", async () => {
  const env = createEnv();
  const response = await login(loginRequest(""), env);
  assert.equal(response.status, 400);
});
