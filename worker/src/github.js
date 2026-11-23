import { assertAllowedRepo, isoNow, makeId, parseAllowList, safeBranch, safePath, writeEvent } from "./utils.js";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const JOB_TTL = 60 * 60 * 24 * 14;
const PAYLOAD_TTL = 60 * 60 * 24 * 14;

export async function githubRequest(env, path, options = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured.");
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "RepoForge/2.1",
      ...(options.headers || {})
    }
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw.slice(0, 500) }; }
  if (!response.ok) {
    const detail = data.message || `HTTP ${response.status}`;
    throw new Error(`GitHub API ${response.status}: ${detail}`);
  }
  return data;
}

function repoParts(repo) {
  const [owner, name] = repo.split("/");
  return { base: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` };
}

function branchPath(branch) {
  return String(branch).split("/").map(encodeURIComponent).join("/");
}

function summarizeJob(job) {
  return {
    schemaVersion: 2,
    id: job.id,
    repo: job.repo,
    branch: job.branch,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt || null,
    deployedAt: job.deployedAt || null,
    fileName: job.fileName,
    archiveFileCount: job.archiveFileCount ?? job.archiveFiles?.length ?? 0,
    targetCount: job.targetCount ?? job.targets?.length ?? 0,
    changeCount: job.changeCount ?? null
  };
}

async function readJobIndex(env) {
  const raw = await env.STATE.get("job:index");
  if (raw) {
    try { return JSON.parse(raw).filter((id) => typeof id === "string"); } catch { /* rebuild below */ }
  }
  // Index from compact summary records, never by reading every full deployment
  // job (which may contain hundreds of paths and actions).
  const listed = await env.STATE.list({ prefix: "job:summary:", limit: 1000 });
  const values = await Promise.all(listed.keys.map(async ({ name }) => {
    const value = await env.STATE.get(name);
    try { return value ? JSON.parse(value) : null; } catch { return null; }
  }));
  const ids = values.filter((job) => job?.schemaVersion === 2 && typeof job.id === "string")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((job) => job.id).slice(0, 500);
  await env.STATE.put("job:index", JSON.stringify(ids), { expirationTtl: JOB_TTL });
  return ids;
}

async function addJobToIndex(env, job) {
  const ids = await readJobIndex(env);
  const next = [job.id, ...ids.filter((id) => id !== job.id)].slice(0, 500);
  await env.STATE.put("job:index", JSON.stringify(next), { expirationTtl: JOB_TTL });
}

async function readBackupIndex(env) {
  const raw = await env.STATE.get("backup:index");
  if (raw) {
    try { return JSON.parse(raw).filter((item) => item && item.id && item.repo); } catch { /* rebuild below */ }
  }
  const listed = await env.STATE.list({ prefix: "backup:", limit: 1000 });
  const values = await Promise.all(listed.keys.filter(({ name }) => name !== "backup:index" && !name.startsWith("backup-id:")).map(async ({ name }) => {
    const value = await env.STATE.get(name);
    try { return value ? JSON.parse(value) : null; } catch { return null; }
  }));
  const backups = values.filter((item) => item && item.id && item.repo)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 500);
  // Cache the legacy v1 backup metadata once. Subsequent dashboard refreshes
  // will read one compact index instead of scanning the namespace each time.
  await env.STATE.put("backup:index", JSON.stringify(backups));
  return backups;
}

async function addBackupToIndex(env, backup) {
  const backups = await readBackupIndex(env);
  const next = [backup, ...backups.filter((item) => item.id !== backup.id)]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 500);
  await env.STATE.put("backup:index", JSON.stringify(next));
}

export async function listRepositories(env) {
  const allow = parseAllowList(env);
  if (!allow.length) throw new Error("ALLOWED_REPOS must contain at least one owner/repository entry.");
  const allowed = new Set(allow);
  const found = new Map();
  // Follow pagination so an allowlisted repository is not silently hidden just
  // because it is beyond the first 100 accessible repositories.
  for (let page = 1; page <= 10 && found.size < allowed.size; page++) {
    const data = await githubRequest(env, `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member`);
    for (const repo of data) {
      const key = String(repo.full_name || "").toLowerCase();
      if (allowed.has(key)) found.set(key, repo);
    }
    if (data.length < 100) break;
  }
  return [...found.values()].map((repo) => ({
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner?.login,
    private: Boolean(repo.private),
    defaultBranch: repo.default_branch,
    htmlUrl: repo.html_url,
    updatedAt: repo.updated_at
  }));
}

export async function getRepository(env, repo) {
  assertAllowedRepo(env, repo);
  const { base } = repoParts(repo);
  const data = await githubRequest(env, base);
  return { fullName: data.full_name, defaultBranch: data.default_branch, private: Boolean(data.private), htmlUrl: data.html_url };
}

export async function listBranches(env, repo) {
  assertAllowedRepo(env, repo);
  const { base } = repoParts(repo);
  const data = await githubRequest(env, `${base}/branches?per_page=100`);
  return data.map((branch) => ({ name: branch.name, sha: branch.commit.sha, protected: Boolean(branch.protected) }));
}

export async function getBranchHead(env, repo, branch) {
  assertAllowedRepo(env, repo);
  const { base } = repoParts(repo);
  const ref = await githubRequest(env, `${base}/git/ref/heads/${branchPath(safeBranch(branch))}`);
  const commit = await githubRequest(env, `${base}/git/commits/${encodeURIComponent(ref.object.sha)}`);
  return { sha: ref.object.sha, treeSha: commit.tree.sha, message: commit.message, parentSha: commit.parents?.[0]?.sha || null, date: commit.committer?.date || commit.author?.date || null };
}

export async function getRemoteTree(env, repo, treeSha) {
  assertAllowedRepo(env, repo);
  const { base } = repoParts(repo);
  const result = await githubRequest(env, `${base}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
  if (result.truncated) throw new Error("GitHub returned a truncated tree. This repository is too large for a reliable file-level preview.");
  const files = (result.tree || []).filter((item) => item.type === "blob");
  const maxRemoteFiles = Number(env.MAX_REMOTE_FILES || 3000);
  if (files.length > maxRemoteFiles) throw new Error(`Repository has ${files.length} files; the configured preview limit is ${maxRemoteFiles}.`);
  return files.map((item) => ({ path: item.path, sha: item.sha, size: item.size || 0, mode: item.mode || "100644" }));
}

export async function prepareJobFromManifest(env, input, actor = "dashboard-admin") {
  const repo = String(input.repo || "");
  assertAllowedRepo(env, repo);
  const repository = await getRepository(env, repo);
  const branch = safeBranch(input.branch || repository.defaultBranch);
  const files = input.files;
  if (!Array.isArray(files) || files.length < 1) throw new Error("The ZIP manifest must contain at least one file.");
  const archiveBytes = Number(input.archiveBytes || 0);
  if (!Number.isFinite(archiveBytes) || archiveBytes < 22 || archiveBytes > Number(env.MAX_ARCHIVE_BYTES || 19 * 1024 * 1024)) {
    throw new Error("Compressed ZIP size is outside the configured limit.");
  }
  const maxFiles = Number(env.MAX_FILES || 400);
  const maxFileBytes = Number(env.MAX_FILE_BYTES || 1024 * 1024);
  const maxExpandedBytes = Number(env.MAX_EXPANDED_BYTES || 16 * 1024 * 1024);
  if (files.length > maxFiles) throw new Error(`ZIP contains too many files. Maximum is ${maxFiles}.`);

  const seen = new Set();
  const parentPaths = new Set();
  let expandedBytes = 0;
  const archiveFiles = files.map((file, index) => {
    const path = safePath(file.path);
    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes) throw new Error(`Invalid size for ${path}. Maximum is ${maxFileBytes} bytes per file.`);
    if (seen.has(path)) throw new Error(`Duplicate archive path: ${path}`);
    if (parentPaths.has(path)) throw new Error(`File/directory path collision in archive: ${path}`);
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = segments.slice(0, depth).join('/');
      if (seen.has(parent)) throw new Error(`File/directory path collision in archive: ${parent}`);
      parentPaths.add(parent);
    }
    seen.add(path);
    expandedBytes += size;
    if (expandedBytes > maxExpandedBytes) throw new Error(`Expanded ZIP exceeds ${maxExpandedBytes} bytes.`);
    return { path, size, index, storageKey: "" };
  });

  const head = await getBranchHead(env, repo, branch);
  const remoteFiles = await getRemoteTree(env, repo, head.treeSha);
  const remoteMap = new Map(remoteFiles.map((file) => [file.path, file]));
  const archiveParents = new Set();
  for (const archivePath of seen) {
    const segments = archivePath.split('/');
    for (let depth = 1; depth < segments.length; depth++) archiveParents.add(segments.slice(0, depth).join('/'));
  }
  for (const remote of remoteFiles) {
    if (seen.has(remote.path)) continue;
    if (archiveParents.has(remote.path)) {
      throw new Error(`Archive path conflicts with an existing repository file: ${remote.path}`);
    }
    const segments = remote.path.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = segments.slice(0, depth).join('/');
      if (seen.has(parent)) throw new Error(`Archive path conflicts with an existing repository file: ${parent}`);
    }
  }
  const targets = [
    ...archiveFiles.map((file) => ({
      path: file.path, source: "archive", size: file.size, action: "update",
      exists: remoteMap.has(file.path), remoteSha: remoteMap.get(file.path)?.sha || null,
      mode: remoteMap.get(file.path)?.mode || "100644", index: file.index
    })),
    ...remoteFiles.filter((file) => !seen.has(file.path)).map((file) => ({
      path: file.path, source: "remote", size: file.size, action: "keep", exists: true,
      remoteSha: file.sha, mode: file.mode, index: null
    }))
  ];
  const id = makeId(10);
  for (const file of archiveFiles) file.storageKey = `payload:${id}:${file.index}`;
  const job = {
    schemaVersion: 2,
    id, repo, branch, source: input.source || "dashboard", actor,
    fileName: String(input.fileName || "release.zip").slice(0, 180),
    status: "uploading", createdAt: isoNow(), baseSha: head.sha, baseTreeSha: head.treeSha,
    expandedBytes, archiveBytes, archiveFiles,
    remoteFiles, targets,
    actions: Object.fromEntries(targets.map((target) => [target.path, target.action])),
    uploadedCount: 0
  };
  await env.STATE.put(`job:${id}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
  await env.STATE.put(`job:summary:${id}`, JSON.stringify(summarizeJob(job)), { expirationTtl: JOB_TTL });
  await addJobToIndex(env, job);
  await writeEvent(env, { type: "prepare", repo, branch, jobId: id, fileName: job.fileName, files: archiveFiles.length, actor });
  return job;
}

export async function storeJobFile(env, jobId, index, base64) {
  const job = await loadJob(env, jobId);
  if (job.status !== "uploading") throw new Error("This job is not accepting file payloads.");
  const file = job.archiveFiles[Number(index)];
  if (!file || file.index !== Number(index)) throw new Error("Unknown file index in this release.");
  if (typeof base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error(`Payload for ${file.path} must be valid base64.`);
  }
  const expectedLength = Math.ceil(file.size / 3) * 4;
  if (base64.length !== expectedLength) throw new Error(`Payload size does not match manifest for ${file.path}.`);
  await env.STATE.put(file.storageKey, base64, { expirationTtl: PAYLOAD_TTL });
  return { index: file.index, path: file.path, size: file.size };
}

export async function completeJobUpload(env, jobId) {
  const job = await loadJob(env, jobId);
  if (job.status !== "uploading") throw new Error(`Job is ${job.status}, not uploading.`);
  let uploaded = 0;
  // Bound parallel KV reads to avoid a long serial wait when a ZIP contains
  // hundreds of small files, while staying comfortably below per-request limits.
  for (let offset = 0; offset < job.archiveFiles.length; offset += 50) {
    const batch = job.archiveFiles.slice(offset, offset + 50);
    const values = await Promise.all(batch.map((file) => env.STATE.get(file.storageKey)));
    for (let index = 0; index < batch.length; index++) {
      if (values[index] !== null) uploaded++;
      else throw new Error(`Missing uploaded payload: ${batch[index].path}. Retry the file upload from the dashboard.`);
    }
  }
  job.uploadedCount = uploaded;
  job.status = "pending";
  job.readyAt = isoNow();
  await saveJob(env, job);
  await writeEvent(env, { type: "upload", repo: job.repo, branch: job.branch, jobId: job.id, files: uploaded, actor: job.actor });
  return job;
}

export async function loadJob(env, id) {
  const raw = await env.STATE.get(`job:${id}`);
  if (!raw) throw new Error("Deployment job was not found or has expired.");
  const job = JSON.parse(raw);
  if (job.schemaVersion !== 2) throw new Error("This deployment job belongs to an older RepoForge version and cannot be resumed. Upload the ZIP again to create a v2 preview.");
  return job;
}

export async function saveJob(env, job) {
  const summary = summarizeJob(job);
  const summaryJson = JSON.stringify(summary);
  const previousSummary = await env.STATE.get(`job:summary:${job.id}`);
  const writes = [env.STATE.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL })];
  // Blob upload steps update only deployment internals; avoid spending a KV
  // write quota unit when the list-facing summary has not changed.
  if (previousSummary !== summaryJson) {
    writes.push(env.STATE.put(`job:summary:${job.id}`, summaryJson, { expirationTtl: JOB_TTL }));
  }
  await Promise.all(writes);
}

export async function listJobs(env, limit = 100) {
  const ids = await readJobIndex(env);
  const selected = ids.slice(0, Math.min(500, Math.max(1, Number(limit) || 100)));
  const jobs = await Promise.all(selected.map(async (id) => {
    const raw = await env.STATE.get(`job:summary:${id}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }));
  const valid = jobs.filter((job) => job?.schemaVersion === 2 && job.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (valid.length !== selected.length) {
    const validIds = valid.map((job) => job.id);
    await env.STATE.put("job:index", JSON.stringify([...validIds, ...ids.slice(selected.length)]), { expirationTtl: JOB_TTL });
  }
  return valid;
}

async function makeBackupRef(env, repo, branch, head, reason = "pre-deploy") {
  const { base } = repoParts(repo);
  const id = makeId(10);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const backupBranch = `repoforge-backup-${stamp}-${id}`;
  await githubRequest(env, `${base}/git/refs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${backupBranch}`, sha: head.sha })
  });
  const backup = { id, repo, branch, sha: head.sha, treeSha: head.treeSha, backupBranch, reason, createdAt: isoNow() };
  await env.STATE.put(`backup:${repo.toLowerCase()}:${id}`, JSON.stringify(backup));
  await env.STATE.put(`backup-id:${id}`, JSON.stringify(backup));
  await addBackupToIndex(env, backup);
  await writeEvent(env, { type: "backup", repo, branch, backupId: id, backupBranch, sha: head.sha, reason });
  return backup;
}

export async function createBackup(env, repo, branch, reason = "manual") {
  const head = await getBranchHead(env, repo, branch);
  return makeBackupRef(env, repo, branch, head, reason);
}

export async function listBackups(env, repo = "") {
  const values = await readBackupIndex(env);
  const normalizedRepo = repo ? repo.toLowerCase() : "";
  return values.filter((backup) => !normalizedRepo || backup.repo.toLowerCase() === normalizedRepo)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function refreshJob(env, job) {
  if (!['pending', 'stale'].includes(job.status)) throw new Error("Only pending or stale jobs can be refreshed.");
  const head = await getBranchHead(env, job.repo, job.branch);
  const remoteFiles = await getRemoteTree(env, job.repo, head.treeSha);
  const archivePaths = new Set(job.archiveFiles.map((file) => file.path));
  const remoteMap = new Map(remoteFiles.map((file) => [file.path, file]));
  job.baseSha = head.sha;
  job.baseTreeSha = head.treeSha;
  job.remoteFiles = remoteFiles;
  job.targets = [
    ...job.archiveFiles.map((file) => ({
      path: file.path, source: "archive", size: file.size, action: job.actions[file.path] || "update",
      exists: remoteMap.has(file.path), remoteSha: remoteMap.get(file.path)?.sha || null,
      mode: remoteMap.get(file.path)?.mode || "100644", index: file.index
    })),
    ...remoteFiles.filter((file) => !archivePaths.has(file.path)).map((file) => ({
      path: file.path, source: "remote", size: file.size, action: job.actions[file.path] || "keep",
      exists: true, remoteSha: file.sha, mode: file.mode, index: null
    }))
  ];
  for (const target of job.targets) {
    if (!['update', 'keep', 'delete'].includes(job.actions[target.path])) job.actions[target.path] = target.action;
    target.action = job.actions[target.path];
  }
  job.status = "pending";
  job.staleAt = null;
  job.updatedAt = isoNow();
  await saveJob(env, job);
  return job;
}

function validateBase64(value, path) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Stored payload is invalid for ${path}. Re-upload this release.`);
  }
  return value;
}

export async function startDeployJob(env, jobId, actor = "admin") {
  const job = await loadJob(env, jobId);
  if (job.status === "deploying" && job.deployment?.backupId) return job;
  if (job.status !== "pending") throw new Error(`Job status is ${job.status}; only pending jobs can start deployment.`);
  assertAllowedRepo(env, job.repo);
  const head = await getBranchHead(env, job.repo, job.branch);
  if (head.sha !== job.baseSha) {
    job.status = "stale";
    job.staleAt = isoNow();
    await saveJob(env, job);
    throw new Error("The target branch changed after this preview. Refresh the preview and inspect the changed paths before deploying.");
  }

  const remoteMap = new Map(job.remoteFiles.map((item) => [item.path, item]));
  const updateIndexes = [];
  const deletions = [];
  for (const target of job.targets) {
    const action = job.actions[target.path] || "keep";
    const remote = remoteMap.get(target.path);
    if (action === "update" && target.source === "archive") updateIndexes.push(target.index);
    if (action === "delete" && remote) deletions.push({ path: target.path, mode: remote.mode || "100644", type: "blob", sha: null });
  }
  const changeCount = updateIndexes.length + deletions.length;
  const maxChanges = Number(env.MAX_CHANGED_FILES || 100);
  if (changeCount < 1) throw new Error("No changes are selected for deployment.");
  if (changeCount > maxChanges) throw new Error(`Selected ${changeCount} changes; this Free-plan profile allows ${maxChanges} changed files per commit. Split the release into smaller batches.`);

  // Check the selected payloads before creating a backup branch.
  const payloadChecks = await Promise.all(updateIndexes.map(async (index) => {
    const file = job.archiveFiles[index];
    return { index, file, present: Boolean(file) && await env.STATE.get(file.storageKey) !== null };
  }));
  for (const check of payloadChecks) {
    if (!check.present) throw new Error(`Missing payload for ${check.file?.path || `file index ${check.index}`}. Re-upload this release.`);
  }

  const backup = await makeBackupRef(env, job.repo, job.branch, head, "pre-deploy");
  job.status = "deploying";
  job.deployStartedAt = isoNow();
  job.deployment = {
    baseSha: head.sha,
    treeSha: head.treeSha,
    backupId: backup.id,
    backupBranch: backup.backupBranch,
    updateIndexes,
    deletions,
    blobShas: {},
    actor
  };
  job.backupId = backup.id;
  job.lastError = null;
  await saveJob(env, job);
  await writeEvent(env, { type: "deploy-start", repo: job.repo, branch: job.branch, jobId: job.id, backupId: backup.id, updateFiles: updateIndexes.length, deletedFiles: deletions.length, actor });
  return job;
}

export async function uploadDeployBlob(env, jobId, index) {
  const job = await loadJob(env, jobId);
  if (job.status !== "deploying" || !job.deployment) throw new Error("This job has no active deployment session.");
  const numericIndex = Number(index);
  if (!job.deployment.updateIndexes.includes(numericIndex)) throw new Error("This file is not selected for update in the active deployment.");
  const existingSha = job.deployment.blobShas[String(numericIndex)];
  if (existingSha) return { index: numericIndex, sha: existingSha, alreadyUploaded: true };

  const file = job.archiveFiles[numericIndex];
  if (!file) throw new Error("Deployment file metadata is missing.");
  const encoded = validateBase64(await env.STATE.get(file.storageKey), file.path);
  const { base } = repoParts(job.repo);
  const blob = await githubRequest(env, `${base}/git/blobs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: encoded, encoding: "base64" })
  });
  job.deployment.blobShas[String(numericIndex)] = blob.sha;
  job.deployment.updatedAt = isoNow();
  await saveJob(env, job);
  return { index: numericIndex, sha: blob.sha, alreadyUploaded: false };
}

export async function finishDeployJob(env, jobId, actor = "admin") {
  const job = await loadJob(env, jobId);
  if (job.status !== "deploying" || !job.deployment) throw new Error("This job has no active deployment session.");
  const deployment = job.deployment;
  const { base } = repoParts(job.repo);
  const head = await getBranchHead(env, job.repo, job.branch);

  // Recover safely if GitHub accepted the final ref update but saving the job failed.
  if (head.sha !== deployment.baseSha) {
    if (String(head.message || "").includes(`RepoForge: deploy ${job.id}`) && head.parentSha === deployment.baseSha) {
      const updatedCount = deployment.updateIndexes.length;
      const deletedCount = deployment.deletions.length;
      job.status = "deployed";
      job.deployedAt = isoNow();
      job.deployedSha = head.sha;
      job.changeCount = updatedCount + deletedCount;
      job.updatedCount = updatedCount;
      job.deletedCount = deletedCount;
      job.actor = actor;
      await saveJob(env, job);
      return { job, backup: { id: deployment.backupId, backupBranch: deployment.backupBranch }, commit: { sha: head.sha, url: `https://github.com/${job.repo}/commit/${head.sha}` }, changed: job.changeCount, updated: updatedCount, deleted: deletedCount, recovered: true };
    }
    job.status = "stale";
    job.staleAt = isoNow();
    job.lastError = "The target branch changed while this deployment was being prepared. Refresh and review before retrying.";
    await saveJob(env, job);
    throw new Error(job.lastError);
  }

  const changes = [...deployment.deletions];
  for (const index of deployment.updateIndexes) {
    const blobSha = deployment.blobShas[String(index)];
    if (!blobSha) throw new Error(`Blob for file ${index + 1} has not been uploaded yet.`);
    const file = job.archiveFiles[index];
    const target = job.targets.find((item) => item.path === file.path);
    changes.push({ path: file.path, mode: target?.mode === "100755" ? "100755" : "100644", type: "blob", sha: blobSha });
  }

  const tree = await githubRequest(env, `${base}/git/trees`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_tree: deployment.treeSha, tree: changes })
  });
  const commit = await githubRequest(env, `${base}/git/commits`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `RepoForge: deploy ${job.id} (${changes.length} file changes)`,
      tree: tree.sha, parents: [deployment.baseSha]
    })
  });

  try {
    await githubRequest(env, `${base}/git/refs/heads/${branchPath(job.branch)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.sha, force: false })
    });
  } catch (error) {
    const latest = await getBranchHead(env, job.repo, job.branch);
    job.status = latest.sha === deployment.baseSha ? "deploying" : "stale";
    job.lastError = String(error.message || error).slice(0, 500);
    if (job.status === "stale") job.staleAt = isoNow();
    await saveJob(env, job);
    throw error;
  }

  const updatedCount = deployment.updateIndexes.length;
  const deletedCount = deployment.deletions.length;
  job.status = "deployed";
  job.deployedAt = isoNow();
  job.deployedSha = commit.sha;
  job.backupId = deployment.backupId;
  job.changeCount = updatedCount + deletedCount;
  job.updatedCount = updatedCount;
  job.deletedCount = deletedCount;
  job.actor = actor;
  job.lastError = null;
  await saveJob(env, job);
  await writeEvent(env, { type: "deploy", repo: job.repo, branch: job.branch, jobId: job.id, commitSha: commit.sha, backupId: deployment.backupId, changed: job.changeCount, updated: updatedCount, deleted: deletedCount, actor });
  return {
    job,
    backup: { id: deployment.backupId, backupBranch: deployment.backupBranch },
    commit: { sha: commit.sha, url: commit.html_url || `https://github.com/${job.repo}/commit/${commit.sha}` },
    changed: job.changeCount, updated: updatedCount, deleted: deletedCount
  };
}

async function findBackup(env, backupId) {
  const raw = await env.STATE.get(`backup-id:${backupId}`);
  if (raw) {
    try { return JSON.parse(raw); } catch { /* search legacy key layout below */ }
  }
  // v1 used backup:<owner/repo>:<id> keys and had no backup-id index.
  const listed = await env.STATE.list({ prefix: "backup:", limit: 1000 });
  for (const { name } of listed.keys) {
    if (name === "backup:index" || name.startsWith("backup-id:")) continue;
    const value = await env.STATE.get(name);
    if (!value) continue;
    try {
      const backup = JSON.parse(value);
      if (backup?.id === backupId && backup?.repo && backup?.branch && backup?.sha) return backup;
    } catch { /* ignore malformed legacy metadata */ }
  }
  return null;
}

export async function restoreBackup(env, backupId, actor = "admin") {
  const backup = await findBackup(env, backupId);
  if (!backup) throw new Error("Backup was not found or its KV metadata has expired.");
  assertAllowedRepo(env, backup.repo);
  const current = await getBranchHead(env, backup.repo, backup.branch);
  const beforeRestore = await makeBackupRef(env, backup.repo, backup.branch, current, "pre-restore");
  const { base } = repoParts(backup.repo);
  const oldCommit = await githubRequest(env, `${base}/git/commits/${encodeURIComponent(backup.sha)}`);
  const restoredCommit = await githubRequest(env, `${base}/git/commits`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: `RepoForge: restore backup ${backup.id}`, tree: oldCommit.tree.sha, parents: [current.sha] })
  });
  await githubRequest(env, `${base}/git/refs/heads/${branchPath(backup.branch)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: restoredCommit.sha, force: false })
  });
  await writeEvent(env, { type: "restore", repo: backup.repo, branch: backup.branch, backupId, beforeRestoreBackupId: beforeRestore.id, commitSha: restoredCommit.sha, actor });
  return { backup, beforeRestore, commit: { sha: restoredCommit.sha, url: restoredCommit.html_url || `https://github.com/${backup.repo}/commit/${restoredCommit.sha}` } };
}

export async function listCommits(env, repo, branch, limit = 20) {
  assertAllowedRepo(env, repo);
  const { base } = repoParts(repo);
  const data = await githubRequest(env, `${base}/commits?sha=${encodeURIComponent(safeBranch(branch))}&per_page=${Math.min(50, Math.max(1, limit))}`);
  return data.map((item) => ({ sha: item.sha, message: item.commit?.message?.split("\n")[0] || "(no message)", date: item.commit?.committer?.date || item.commit?.author?.date, author: item.commit?.author?.name, url: item.html_url }));
}
