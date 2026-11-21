import { login, logout, requireDashboard } from "./auth.js";
import {
  createBackup, createJobFromZip, deployJob, getRepository, listBackups,
  listBranches, listCommits, listRepositories, loadJob,
  refreshJob, restoreBackup, saveJob
} from "./github.js";
import { corsHeaders, json, readJson, safeBranch, safeRepoName, listByPrefix, writeEvent } from "./utils.js";
import { handleTelegramWebhook } from "./telegram.js";

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function parseStatus(error) {
  const message = String(error?.message || error);
  if (/not in the server allowlist|not allowed|Origin is not allowed/i.test(message)) return 403;
  if (/not found|does not exist|expired/i.test(message)) return 404;
  if (/changed after this preview|branch.*changed/i.test(message)) return 409;
  if (/not configured|must contain/i.test(message)) return 503;
  if (/too large|maximum|invalid|valid JSON|must use|unsupported|not present|no selected changes|out of range|not supported/i.test(message)) return 400;
  return 500;
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/health" && method === "GET") {
    return json({ ok: true, name: "RepoForge", version: "1.0.0", time: new Date().toISOString() });
  }
  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") return logout(request, env);

  const authenticated = await requireDashboard(request, env);
  if (!authenticated) return json({ error: "Authentication required or session expired." }, 401);

  if (path === "/api/session" && method === "GET") {
    return json({ ok: true, role: "admin", expiresIn: Number(env.SESSION_TTL_SECONDS || 21600) });
  }

  if (path === "/api/status" && method === "GET") {
    const repos = await listRepositories(env);
    const backups = await listBackups(env);
    const jobs = await listByPrefix(env.STATE, "job:", 100);
    return json({
      ok: true,
      worker: "online",
      github: "connected",
      allowedRepositories: repos.length,
      pendingJobs: jobs.filter((job) => job.status === "pending" || job.status === "stale").length,
      backups: backups.length,
      limits: {
        archiveBytes: Number(env.MAX_ARCHIVE_BYTES || 18 * 1024 * 1024),
        expandedBytes: Number(env.MAX_EXPANDED_BYTES || 32 * 1024 * 1024),
        files: Number(env.MAX_FILES || 400),
        changedFiles: Number(env.MAX_CHANGED_FILES || 25)
      }
    });
  }

  if (path === "/api/repos" && method === "GET") return json({ repositories: await listRepositories(env) });

  if (path === "/api/branches" && method === "GET") {
    const repo = safeRepoName(url.searchParams.get("repo") || "");
    const branches = await listBranches(env, repo);
    return json({ branches });
  }

  if (path === "/api/jobs" && method === "GET") {
    const jobs = await listByPrefix(env.STATE, "job:", 100);
    return json({ jobs: jobs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 50) });
  }

  if (path === "/api/uploads" && method === "POST") {
    const maxBytes = Number(env.MAX_ARCHIVE_BYTES || 18 * 1024 * 1024);
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength && contentLength > maxBytes + 1024 * 1024) return json({ error: `Upload exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.` }, 413);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "A ZIP file field named 'file' is required." }, 400);
    if (!file.name.toLowerCase().endsWith(".zip")) return json({ error: "Only .zip archives are supported." }, 400);
    if (file.size > maxBytes) return json({ error: `Upload exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.` }, 413);
    const repo = safeRepoName(String(form.get("repo") || ""));
    const branch = safeBranch(String(form.get("branch") || ""));
    const stripRoot = String(form.get("stripRoot") || "true") === "true";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const job = await createJobFromZip(env, { repo, branch, zipBytes: bytes, fileName: file.name, stripRoot, source: "dashboard", actor: "dashboard-admin" });
    return json({ ok: true, job: { ...job, archiveKey: undefined } }, 201);
  }

  const jobMatch = path.match(/^\/api\/jobs\/([a-z0-9]+)(?:\/(actions|refresh|deploy|cancel))?$/i);
  if (jobMatch) {
    const id = jobMatch[1];
    const action = jobMatch[2] || "detail";
    if (action === "detail" && method === "GET") {
      const job = await loadJob(env, id);
      return json({ job: { ...job, archiveKey: undefined } });
    }
    if (action === "actions" && method === "PATCH") {
      const job = await loadJob(env, id);
      if (job.status !== "pending" && job.status !== "stale") return json({ error: "Only pending jobs can be edited." }, 409);
      const body = await readJson(request);
      if (!body.actions || typeof body.actions !== "object" || Array.isArray(body.actions)) return json({ error: "actions must be an object." }, 400);
      const allowed = new Map(job.targets.map((target) => [target.path, target]));
      for (const [filePath, newAction] of Object.entries(body.actions)) {
        const target = allowed.get(filePath);
        if (!target) return json({ error: `Unknown path: ${filePath}` }, 400);
        if (!["update", "keep", "delete"].includes(newAction)) return json({ error: `Invalid action for ${filePath}` }, 400);
        if (newAction === "update" && target.source !== "archive") return json({ error: `Cannot update repository-only path ${filePath}; it is not in the ZIP.` }, 400);
        job.actions[filePath] = newAction;
      }
      await saveJob(env, job);
      return json({ ok: true, job: { ...job, archiveKey: undefined } });
    }
    if (action === "refresh" && method === "POST") {
      const job = await loadJob(env, id);
      if (job.status !== "pending" && job.status !== "stale") return json({ error: "Only pending jobs can be refreshed." }, 409);
      const refreshed = await refreshJob(env, job);
      return json({ ok: true, job: { ...refreshed, archiveKey: undefined } });
    }
    if (action === "deploy" && method === "POST") {
      const result = await deployJob(env, id, "dashboard-admin");
      return json({ ok: true, result });
    }
    if (action === "cancel" && method === "POST") {
      const job = await loadJob(env, id);
      if (job.status !== "pending" && job.status !== "stale") return json({ error: "Only pending or stale jobs can be cancelled." }, 409);
      job.status = "cancelled";
      job.cancelledAt = new Date().toISOString();
      await saveJob(env, job);
      await writeEvent(env, { type: "cancel", repo: job.repo, branch: job.branch, jobId: job.id, actor: "dashboard-admin" });
      return json({ ok: true, job: { ...job, archiveKey: undefined } });
    }
  }

  if (path === "/api/backups" && method === "GET") {
    const repo = url.searchParams.get("repo") || "";
    return json({ backups: await listBackups(env, repo) });
  }

  if (path === "/api/backups" && method === "POST") {
    const body = await readJson(request);
    const repo = safeRepoName(body.repo || "");
    const branch = safeBranch(body.branch || "");
    const backup = await createBackup(env, repo, branch, "manual-dashboard");
    return json({ ok: true, backup }, 201);
  }

  const restoreMatch = path.match(/^\/api\/backups\/([a-z0-9]+)\/restore$/i);
  if (restoreMatch && method === "POST") {
    const result = await restoreBackup(env, restoreMatch[1], "dashboard-admin");
    return json({ ok: true, result });
  }

  if (path === "/api/history" && method === "GET") {
    const repo = safeRepoName(url.searchParams.get("repo") || "");
    const branch = safeBranch(url.searchParams.get("branch") || "");
    const commits = await listCommits(env, repo, branch, Number(url.searchParams.get("limit") || 20));
    return json({ commits });
  }

  if (path === "/api/audit" && method === "GET") {
    const events = await listByPrefix(env.STATE, "event:", 100);
    return json({ events: events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100) });
  }

  return json({ error: "Endpoint not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request, env);
      if (!headers["Access-Control-Allow-Origin"]) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers });
    }
    try {
      if (url.pathname === "/telegram" && request.method === "POST") return await handleTelegramWebhook(request, env);
      if (url.pathname.startsWith("/api/")) return withCors(await api(request, env), request, env);
      if (url.pathname === "/") return new Response("RepoForge Worker is running.", { headers: { "content-type": "text/plain; charset=utf-8" } });
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      const status = parseStatus(error);
      const response = json({ error: error.message || "Unexpected server error." }, status);
      return url.pathname.startsWith("/api/") ? withCors(response, request, env) : response;
    }
  }
};
