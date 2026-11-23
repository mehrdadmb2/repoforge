import { login, logout, requireDashboard } from "./auth.js";
import {
  completeJobUpload, createBackup, finishDeployJob, getRepository, listBackups, listBranches,
  listCommits, listJobs, listRepositories, loadJob, prepareJobFromManifest,
  refreshJob, restoreBackup, saveJob, startDeployJob, storeJobFile, uploadDeployBlob
} from "./github.js";
import { corsHeaders, json, listRecentEvents, readJson, safeBranch, safeRepoName, writeEvent } from "./utils.js";
import { handleTelegramWebhook, streamTelegramStageArchive } from "./telegram.js";

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function errorStatus(error) {
  const message = String(error?.message || error);
  if (/not in the server allowlist|not allowed|Origin is not allowed|Forbidden/i.test(message)) return 403;
  if (/not found|does not exist|expired|was not found/i.test(message)) return 404;
  if (/changed after this preview|branch.*changed|status is|not accepting|not uploading/i.test(message)) return 409;
  if (/not configured|must contain|GITHUB_TOKEN|STATE KV/i.test(message)) return 503;
  if (/Request body exceeds|Encoded file exceeds|ZIP archive exceeds|exceeds the .* limit|too large/i.test(message)) return 413;
  if (/maximum|invalid|valid JSON|must use|unsupported|not present|no selected changes|No changes are selected|out of range|not supported|Unsafe|Duplicate|Encrypted|ZIP|payload|per-file|manifest|File\/directory path collision|Archive path conflicts|Unknown file index|allows \d+ changed files|outside the configured limit/i.test(message)) return 400;
  if (/GitHub API 401|GitHub API 403|GitHub API 404|GitHub API 422/.test(message)) return 502;
  return 500;
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/health" && method === "GET") {
    return json({ ok: true, name: "RepoForge", version: "2.0.0", storage: "Cloudflare Workers KV", r2Required: false, planProfile: "workers-free", time: new Date().toISOString() });
  }
  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") return logout(request, env);

  const authenticated = await requireDashboard(request, env);
  if (!authenticated) return json({ error: "Authentication required or session expired. Unlock the dashboard again." }, 401);

  if (path === "/api/session" && method === "GET") {
    return json({ ok: true, role: "admin", expiresIn: Number(env.SESSION_TTL_SECONDS || 21600) });
  }

  if (path === "/api/status" && method === "GET") {
    // Keep status lightweight: the dashboard already fetches repositories,
    // jobs and backups in their dedicated endpoints. Avoid duplicating GitHub
    // and KV reads on every refresh, especially on the Free tier.
    return json({
      ok: true,
      worker: "online",
      github: env.GITHUB_TOKEN ? "configured" : "missing-token",
      storage: "Workers KV",
      r2Required: false,
      plan: "Free compatible",
      allowedRepositories: String(env.ALLOWED_REPOS || "").split(",").map((item) => item.trim()).filter(Boolean).length,
      pendingJobs: null,
      backups: null,
      limits: {
        archiveBytes: Number(env.MAX_ARCHIVE_BYTES || 19 * 1024 * 1024),
        expandedBytes: Number(env.MAX_EXPANDED_BYTES || 16 * 1024 * 1024),
        fileBytes: Number(env.MAX_FILE_BYTES || 1024 * 1024),
        files: Number(env.MAX_FILES || 400),
        changedFiles: Number(env.MAX_CHANGED_FILES || 100),
        remoteFiles: Number(env.MAX_REMOTE_FILES || 3000)
      }
    });
  }

  if (path === "/api/repos" && method === "GET") return json({ repositories: await listRepositories(env) });

  if (path === "/api/branches" && method === "GET") {
    const repo = safeRepoName(url.searchParams.get("repo") || "");
    return json({ branches: await listBranches(env, repo) });
  }

  if (path === "/api/jobs" && method === "GET") {
    const jobs = await listJobs(env, 100);
    return json({ jobs: jobs.map((job) => ({
      id: job.id, repo: job.repo, branch: job.branch, status: job.status,
      createdAt: job.createdAt, deployedAt: job.deployedAt, fileName: job.fileName,
      archiveFileCount: job.archiveFileCount || 0, changeCount: job.changeCount
    })) });
  }

  if (path === "/api/jobs/prepare" && method === "POST") {
    const body = await readJson(request, 512 * 1024);
    const job = await prepareJobFromManifest(env, body, "dashboard-admin");
    return json({ ok: true, job: { id: job.id, repo: job.repo, branch: job.branch, status: job.status, fileName: job.fileName, archiveFileCount: job.archiveFiles.length, targetCount: job.targets.length, createdAt: job.createdAt } }, 201);
  }

  const jobFileMatch = path.match(/^\/api\/jobs\/([a-z0-9]{10})\/files\/(\d+)$/i);
  if (jobFileMatch && method === "PUT") {
    const maxEncoded = Math.ceil(Number(env.MAX_FILE_BYTES || 1024 * 1024) / 3) * 4 + 4;
    const length = Number(request.headers.get("Content-Length") || 0);
    if (length && length > maxEncoded) return json({ error: "Encoded file exceeds the per-file limit." }, 413);
    const type = request.headers.get("Content-Type") || "";
    if (!type.toLowerCase().startsWith("text/plain")) return json({ error: "Upload each file as text/plain base64." }, 415);
    const encoded = await request.text();
    if (encoded.length > maxEncoded) return json({ error: "Encoded file exceeds the per-file limit." }, 413);
    const result = await storeJobFile(env, jobFileMatch[1], Number(jobFileMatch[2]), encoded);
    return json({ ok: true, file: result });
  }

  const jobCompleteMatch = path.match(/^\/api\/jobs\/([a-z0-9]{10})\/complete$/i);
  if (jobCompleteMatch && method === "POST") {
    const job = await completeJobUpload(env, jobCompleteMatch[1]);
    return json({ ok: true, job: { id: job.id, repo: job.repo, branch: job.branch, status: job.status, fileName: job.fileName, archiveFileCount: job.archiveFiles.length, targetCount: job.targets.length, createdAt: job.createdAt } });
  }

  const deployBlobMatch = path.match(/^\/api\/jobs\/([a-z0-9]{10})\/deploy\/blobs\/(\d+)$/i);
  if (deployBlobMatch && method === "POST") {
    const result = await uploadDeployBlob(env, deployBlobMatch[1], Number(deployBlobMatch[2]));
    return json({ ok: true, blob: result });
  }

  const deployStepMatch = path.match(/^\/api\/jobs\/([a-z0-9]{10})\/deploy\/(start|commit)$/i);
  if (deployStepMatch && method === "POST") {
    if (deployStepMatch[2] === "start") {
      const job = await startDeployJob(env, deployStepMatch[1], "dashboard-admin");
      return json({ ok: true, job });
    }
    const result = await finishDeployJob(env, deployStepMatch[1], "dashboard-admin");
    return json({ ok: true, result });
  }

  const jobMatch = path.match(/^\/api\/jobs\/([a-z0-9]{10})(?:\/(actions|refresh|deploy|cancel))?$/i);
  if (jobMatch) {
    const id = jobMatch[1];
    const action = jobMatch[2] || "detail";
    if (action === "detail" && method === "GET") {
      const job = await loadJob(env, id);
      return json({ job });
    }
    if (action === "actions" && method === "PATCH") {
      const job = await loadJob(env, id);
      if (!["pending", "stale"].includes(job.status)) return json({ error: "Only pending or stale jobs can be edited." }, 409);
      const body = await readJson(request, 512 * 1024);
      if (!body.actions || typeof body.actions !== "object" || Array.isArray(body.actions)) return json({ error: "actions must be an object." }, 400);
      const allowed = new Map(job.targets.map((target) => [target.path, target]));
      for (const [filePath, newAction] of Object.entries(body.actions)) {
        const target = allowed.get(filePath);
        if (!target) return json({ error: `Unknown path: ${filePath}` }, 400);
        if (!["update", "keep", "delete"].includes(newAction)) return json({ error: `Invalid action for ${filePath}` }, 400);
        if (newAction === "update" && target.source !== "archive") return json({ error: `Cannot update ${filePath}; it is not present in the archive.` }, 400);
        if (newAction === "delete" && !target.exists) return json({ error: `Cannot delete ${filePath}; it does not exist in the repository.` }, 400);
        job.actions[filePath] = newAction;
      }
      await saveJob(env, job);
      return json({ ok: true, job });
    }
    if (action === "refresh" && method === "POST") {
      const job = await loadJob(env, id);
      return json({ ok: true, job: await refreshJob(env, job) });
    }
    if (action === "deploy" && method === "POST") {
      const job = await startDeployJob(env, id, "dashboard-admin");
      return json({ ok: true, job });
    }
    if (action === "cancel" && method === "POST") {
      const job = await loadJob(env, id);
      if (!["uploading", "pending", "stale", "deploying"].includes(job.status)) return json({ error: "This job can no longer be cancelled." }, 409);
      job.status = "cancelled";
      job.cancelledAt = new Date().toISOString();
      await saveJob(env, job);
      await writeEvent(env, { type: "cancel", repo: job.repo, branch: job.branch, jobId: job.id, actor: "dashboard-admin" });
      return json({ ok: true, job });
    }
  }

  const stageInfoMatch = path.match(/^\/api\/stages\/([a-z0-9]{10})$/i);
  if (stageInfoMatch && method === "GET") {
    const raw = await env.STATE.get(`stage:${stageInfoMatch[1]}`);
    if (!raw) throw new Error("Telegram ZIP stage was not found or has expired.");
    const stage = JSON.parse(raw);
    return json({ stage: { id: stage.id, repo: stage.repo, branch: stage.branch, fileName: stage.fileName, size: stage.size, createdAt: stage.createdAt, status: stage.status } });
  }

  const stageArchiveMatch = path.match(/^\/api\/stages\/([a-z0-9]{10})\/archive$/i);
  if (stageArchiveMatch && method === "GET") {
    const raw = await env.STATE.get(`stage:${stageArchiveMatch[1]}`);
    if (!raw) throw new Error("Telegram ZIP stage was not found or has expired.");
    const stage = JSON.parse(raw);
    const archive = await streamTelegramStageArchive(env, stage);
    const headers = {
      ...corsHeaders(request, env),
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(stage.fileName || "telegram-upload.zip")}"`,
      "Cache-Control": "no-store, private"
    };
    if (archive.size) headers["Content-Length"] = String(archive.size);
    return new Response(archive.body, { status: 200, headers });
  }

  const stageMatch = path.match(/^\/api\/stages\/([a-z0-9]{10})$/i);
  if (stageMatch && method === "DELETE") {
    const id = stageMatch[1];
    const raw = await env.STATE.get(`stage:${id}`);
    if (raw) await env.STATE.delete(`stage:${id}`);
    return json({ ok: true });
  }

  if (path === "/api/backups" && method === "GET") {
    const repo = url.searchParams.get("repo") || "";
    if (repo) safeRepoName(repo);
    return json({ backups: await listBackups(env, repo) });
  }

  if (path === "/api/backups" && method === "POST") {
    const body = await readJson(request);
    const repo = safeRepoName(body.repo || "");
    const repository = await getRepository(env, repo);
    const branch = safeBranch(body.branch || repository.defaultBranch);
    const backup = await createBackup(env, repo, branch, "manual-dashboard");
    return json({ ok: true, backup }, 201);
  }

  const restoreMatch = path.match(/^\/api\/backups\/([a-z0-9]{10})\/restore$/i);
  if (restoreMatch && method === "POST") {
    const result = await restoreBackup(env, restoreMatch[1], "dashboard-admin");
    return json({ ok: true, result });
  }

  if (path === "/api/history" && method === "GET") {
    const repo = safeRepoName(url.searchParams.get("repo") || "");
    const repository = await getRepository(env, repo);
    const branch = safeBranch(url.searchParams.get("branch") || repository.defaultBranch);
    const commits = await listCommits(env, repo, branch, Number(url.searchParams.get("limit") || 20));
    return json({ commits });
  }

  if (path === "/api/audit" && method === "GET") {
    return json({ events: await listRecentEvents(env.STATE, 100) });
  }

  return json({ error: "Endpoint not found." }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.STATE) return new Response("RepoForge requires one Cloudflare Workers KV namespace binding named STATE.", { status: 503 });
    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request, env);
      if (!headers["Access-Control-Allow-Origin"]) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers });
    }
    try {
      if (url.pathname === "/telegram" && request.method === "POST") return await handleTelegramWebhook(request, env, ctx);
      if (url.pathname.startsWith("/api/")) return withCors(await api(request, env), request, env);
      if (url.pathname === "/") return new Response("RepoForge Worker 2.0 is running. Use /api/health.", { headers: { "content-type": "text/plain; charset=utf-8" } });
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      const response = json({ error: error?.message || "Unexpected server error." }, errorStatus(error));
      return url.pathname.startsWith("/api/") ? withCors(response, request, env) : response;
    }
  }
};
