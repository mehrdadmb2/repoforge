import { json } from "./utils.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toB64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromB64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// Web Crypto accepts HMAC keys of any non-zero byte length. RepoForge does not
// impose an arbitrary character-count minimum; entropy remains the operator's choice.
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(payload, secret) {
  const body = toB64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${toB64Url(new Uint8Array(signature))}`;
}

export async function verifySessionToken(token, env) {
  const secret = typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET : "";
  if (!token || secret.length === 0) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64Url(parts[1]), encoder.encode(parts[0]));
    if (!valid) return false;
    const payload = JSON.parse(decoder.decode(fromB64Url(parts[0])));
    if (payload?.role !== "admin" || Number(payload.exp) <= Math.floor(Date.now() / 1000) || !payload.nonce) return false;
    return Boolean(await env.STATE.get(`session:${payload.nonce}`));
  } catch { return false; }
}

async function hash(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function rateLimitKey(request) {
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await hash(address);
  return `login-attempt:${toB64Url(digest).slice(0, 32)}`;
}

export async function login(request, env) {
  const configuredPassword = typeof env.DASHBOARD_PASSWORD === "string" ? env.DASHBOARD_PASSWORD : "";
  const sessionSecret = typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET : "";
  if (configuredPassword.length === 0 || sessionSecret.length === 0) {
    return json({ error: "Dashboard authentication is not configured. Set non-empty DASHBOARD_PASSWORD and SESSION_SECRET Worker secrets." }, 503);
  }

  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = (env.SITE_ORIGIN || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!allowedOrigins.includes(origin)) return json({ error: "Origin is not allowed." }, 403);

  const key = await rateLimitKey(request);
  const current = Number(await env.STATE.get(key) || 0);
  if (current >= 8) return json({ error: "Too many login attempts. Try again later." }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  if (typeof body?.password !== "string" || body.password.length === 0) {
    return json({ error: "Enter a non-empty dashboard password." }, 400);
  }

  const supplied = body.password;
  const [expectedHash, suppliedHash] = await Promise.all([hash(configuredPassword), hash(supplied)]);
  if (!constantTimeEqual(expectedHash, suppliedHash)) {
    await env.STATE.put(key, String(current + 1), { expirationTtl: 900 });
    return json({ error: "Incorrect password." }, 401);
  }

  await env.STATE.delete(key);
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(86400, Math.max(900, Number(env.SESSION_TTL_SECONDS || 21600)));
  const nonce = crypto.randomUUID();
  await env.STATE.put(`session:${nonce}`, "1", { expirationTtl: ttl });
  const token = await sign({ role: "admin", iat: now, exp: now + ttl, nonce }, sessionSecret);
  return json({ ok: true, token, expiresAt: new Date((now + ttl) * 1000).toISOString() });
}

export async function logout(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !await verifySessionToken(match[1], env)) return json({ ok: true });
  try {
    const body = match[1].split(".")[0];
    const payload = JSON.parse(decoder.decode(fromB64Url(body)));
    if (payload.nonce) await env.STATE.delete(`session:${payload.nonce}`);
  } catch { /* client-side session will still be cleared */ }
  return json({ ok: true });
}

export async function requireDashboard(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = (env.SITE_ORIGIN || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!allowedOrigins.includes(origin)) return false;
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? verifySessionToken(match[1], env) : false;
}
