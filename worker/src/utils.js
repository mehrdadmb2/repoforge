export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
});

export const text = (value, status = 200, headers = {}) => new Response(value, {
  status,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }
});

export function makeId(length = 10) {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
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
  if (!branch || branch === "@" || branch.length > 240 || branch.startsWith("-") || branch.includes("..") || branch.includes("//") || branch.includes("@{") || branch.includes("\\") || /[\x00-\x20\x7f~^:?*\[]/.test(branch) || branch.endsWith("/") || branch.endsWith(".") || invalidComponent) {
    throw new Error("Invalid branch name.");
  }
  return branch;
}

export function safePath(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || value.startsWith("/") || value.includes("\\") || value.includes("\0") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Unsafe repository path: ${String(value)}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.length > 255 || part.toLowerCase() === ".git" || /[\x00-\x1f\x7f]/.test(part))) {
    throw new Error(`Unsafe repository path: ${value}`);
  }
  return parts.join("/");
}

export function parseAllowList(env) {
  return String(env.ALLOWED_REPOS || "")
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
  const trimmed = String(textValue).trim();
  const parts = trimmed.split(/\s+/);
  const command = (parts.shift() || "").split("@")[0].toLowerCase();
  return { command, args: parts };
}

export const isoNow = () => new Date().toISOString();

export async function readJson(request, maxBytes = 1024 * 1024) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length && length > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes.`);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes.`);
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw new Error("Request body must be valid JSON."); }
}

export function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.SITE_ORIGIN || "").split(",").map((v) => v.trim()).filter(Boolean);
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export async function writeEvent(env, event) {
  const record = { id: makeId(12), at: isoNow(), ...event };
  await env.STATE.put(`event:${record.at}:${record.id}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 180 });
  let events = [];
  const rawIndex = await env.STATE.get("event:index");
  if (rawIndex) {
    try {
      const parsed = JSON.parse(rawIndex);
      events = Array.isArray(parsed) ? parsed.filter((item) => item && item.id) : [];
    } catch { events = []; }
  } else {
    // One-time migration path for events written by the earlier RepoForge version.
    const listed = await env.STATE.list({ prefix: "event:", limit: 100 });
    const previous = await Promise.all(listed.keys.filter(({ name }) => name !== "event:index").map(async ({ name }) => {
      const raw = await env.STATE.get(name);
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    }));
    events = previous.filter((item) => item && item.id && item.id !== record.id);
  }
  events.push(record);
  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  await env.STATE.put("event:index", JSON.stringify(events.slice(0, 100)), { expirationTtl: 60 * 60 * 24 * 180 });
  return record;
}

export async function listRecentEvents(kv, limit = 100) {
  const raw = await kv.get("event:index");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.slice(0, limit);
    } catch { /* fall back to legacy event keys */ }
  }
  const listed = await kv.list({ prefix: "event:", limit: Math.min(1000, limit) });
  const events = await Promise.all(listed.keys.filter(({ name }) => name !== "event:index").map(async ({ name }) => {
    const value = await kv.get(name);
    try { return value ? JSON.parse(value) : null; } catch { return null; }
  }));
  return events.filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

export async function listByPrefix(kv, prefix, limit = 100) {
  const listed = await kv.list({ prefix, limit: Math.min(1000, limit) });
  const values = await Promise.all(listed.keys.map(async ({ name }) => {
    const raw = await kv.get(name);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }));
  return values.filter(Boolean);
}
