export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
});

export const text = (value, status = 200, headers = {}) => new Response(value, {
  status,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }
});

export function makeId(length = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length * 0.8)));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("").slice(0, length);
}

export function toBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
  }
  return btoa(binary);
}

export function fromBase64(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function safeRepoName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("Repository must use owner/repository format.");
  }
  return value;
}

export function safeBranch(value) {
  const branch = String(value || "").trim();
  const components = branch.split("/");
  const invalidComponent = components.some((part) => !part || part.startsWith(".") || part.toLowerCase().endsWith(".lock"));
  if (!branch || branch === "@" || branch.length > 240 || branch.startsWith("-") || branch.includes("..") || branch.includes("//") || branch.includes("@{") || branch.includes("\\") || /[\x00-\x20\x7f~^:?*\[]/.test(branch) || branch.endsWith("/") || branch.endsWith("." ) || invalidComponent) {
    throw new Error("Invalid branch name.");
  }
  return branch;
}

export function parseAllowList(env) {
  return (env.ALLOWED_REPOS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function assertAllowedRepo(env, repo) {
  const normalized = safeRepoName(repo).toLowerCase();
  const allow = parseAllowList(env);
  if (!allow.length) throw new Error("Server is not configured: ALLOWED_REPOS is empty.");
  if (!allow.includes(normalized)) throw new Error(`Repository ${repo} is not in the server allowlist.`);
  return normalized;
}

export function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

export function parseCommand(textValue = "") {
  const trimmed = textValue.trim();
  const parts = trimmed.split(/\s+/);
  const command = (parts.shift() || "").split("@")[0].toLowerCase();
  return { command, args: parts };
}

export function isoNow() {
  return new Date().toISOString();
}

export async function readJson(request) {
  try { return await request.json(); }
  catch { throw new Error("Request body must be valid JSON."); }
}

export function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.SITE_ORIGIN || "").split(",").map((v) => v.trim()).filter(Boolean);
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export async function writeEvent(env, event) {
  const record = { id: makeId(12), at: isoNow(), ...event };
  await env.STATE.put(`event:${record.at}:${record.id}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 180 });
  return record;
}

export async function listByPrefix(kv, prefix, limit = 30) {
  const listed = await kv.list({ prefix, limit });
  const values = await Promise.all(listed.keys.map(async ({ name }) => {
    const raw = await kv.get(name);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }));
  return values.filter(Boolean);
}
