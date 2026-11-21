import { assertAllowedRepo, makeId, safeBranch, toBase64, writeEvent } from "./utils.js";
import { inspectZip, stripCommonRoot } from "./zip.js";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";

export async function githubRequest(env, path, options = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured.");
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "RepoForge/1.0",
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
  return { owner, name, base: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` };
}

export async function listRepositories(env) {
  const allow = (env.ALLOWED_REPOS || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (!allow.length) throw new Error("ALLOWED_REPOS must contain at least one owner/repository entry.");
  const data = await githubRequest(env, "/user/repos?per_page=100&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member");
  return data.filter((repo) => allow.includes(repo.full_name.toLowerCase())).map((repo) => ({
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner?.login,
    private: repo.private,
    defaultBranch: repo.default_branch,
    htmlUrl: repo.html_url,
    updatedAt: repo.updated_at
  }));
}

export async function listBranches(env, repo) {
  assertAllowedRepo(env, repo);
  const { base } = repoParts(repo);
  const data = await githubRequest(env, `${base}/branches?per_page=100`);
  return data.map((branch) => ({ name: branch.name, sha: branch.commit.sha, protected: branch.protected }));
}

export async function getRepository(env, repo) {
  assertAllowedRepo(env, repo);
  const { base } = repoParts(repo);
  const data = await githubRequest(env, base);
  return { fullName: data.full_name, defaultBranch: data.default_branch, private: data.private, htmlUrl: data.html_url };
}

export async function getBranchHead(env, repo, branch) {
  assertAllowedRepo(env, repo);
  const { base } = repoParts(repo);
  const refPath = branch.split("/").map(encodeURIComponent).join("/");
  const ref = await githubRequest(env, `${base}/git/ref/heads/${refPath}`);
  const commit = await githubRequest(env, `${base}/git/commits/${ref.object.sha}`);
  return { sha: ref.object.sha, treeSha: commit.tree.sha, commitMessage: commit.message, date: commit.committer?.date || commit.author?.date || null };
}

export async function getRemoteTree(env, repo, treeSha) {
  assertAllowedRepo(env, repo);
  const { base } = repoParts(repo);
  const result = await githubRequest(env, `${base}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
  if (result.truncated) throw new Error("GitHub returned a truncated repository tree. This repository is too large for a safe file-by-file deployment preview.");
  const files = (result.tree || []).filter((item) => item.type === "blob");
  const maxRemoteFiles = Number(env.MAX_REMOTE_FILES || 3000);
  if (files.length > maxRemoteFiles) throw new Error(`Repository contains ${files.length} files; the configured preview limit is ${maxRemoteFiles}.`);
  return files.map((item) => ({
    path: item.path,
    sha: item.sha,
    size: item.size || 0,
    mode: item.mode || "100644"
  }));
}

export async function createJobFromZip(env, { repo, branch, zipBytes, fileName, stripRoot = true, source = "dashboard", actor = "admin" }) {
  assertAllowedRepo(env, repo);
  const maxArchiveBytes = Number(env.MAX_ARCHIVE_BYTES || 18 * 1024 * 1024);
  if (!(zipBytes instanceof Uint8Array) || zipBytes.byteLength < 22 || zipBytes.byteLength > maxArchiveBytes) {
    throw new Error(`ZIP archive must be between 22 bytes and ${maxArchiveBytes} bytes.`);
  }
  const repository = await getRepository(env, repo);
  const targetBranch = safeBranch(branch || repository.defaultBranch);
  const head = await getBranchHead(env, repo, targetBranch);
  const remoteFiles = await getRemoteTree(env, repo, head.treeSha);
  const filesRaw = inspectZip(zipBytes, {
    maxFiles: Number(env.MAX_FILES || 400),
    maxFileBytes: Number(env.MAX_FILE_BYTES || 8 * 1024 * 1024),
    maxExpandedBytes: Number(env.MAX_EXPANDED_BYTES || 32 * 1024 * 1024)
  });
  const files = stripCommonRoot(filesRaw, stripRoot).map(({ path, size, compressedSize }) => ({ path, size, compressedSize }));
  const remoteMap = new Map(remoteFiles.map((item) => [item.path, item]));
  const archivePaths = new Set(files.map((item) => item.path));
  const targets = [
    ...files.map((file) => ({ path: file.path, source: "archive", size: file.size, action: "update", exists: remoteMap.has(file.path), remoteSha: remoteMap.get(file.path)?.sha || null })),
    ...remoteFiles.filter((remote) => !archivePaths.has(remote.path)).map((remote) => ({ path: remote.path, source: "remote", size: remote.size, action: "keep", exists: true, remoteSha: remote.sha }))
  ];
  const id = makeId(10);
  const archiveKey = `uploads/${id}.zip`;
  await env.ARCHIVES.put(archiveKey, zipBytes, { httpMetadata: { contentType: "application/zip" }, customMetadata: { repo, branch: targetBranch, jobId: id } });
  const job = {
    id, repo, branch: targetBranch, source, actor, fileName: fileName || "upload.zip", archiveKey,
    status: "pending", createdAt: new Date().toISOString(), baseSha: head.sha, baseTreeSha: head.treeSha,
    archiveFiles: files, remoteFiles: remoteFiles.map(({ path, sha, size, mode }) => ({ path, sha, size, mode })),
    targets, stripRoot: Boolean(stripRoot),
    actions: Object.fromEntries(targets.map((target) => [target.path, target.action]))
  };
  await env.STATE.put(`job:${id}`, JSON.stringify(job), { expirationTtl: 60 * 60 * 24 * 14 });
  await writeEvent(env, { type: "upload", repo, branch: targetBranch, jobId: id, fileName: job.fileName, files: files.length, source, actor });
  return job;
}

export async function loadJob(env, id) {
  const raw = await env.STATE.get(`job:${id}`);
  if (!raw) throw new Error("Deployment job was not found or has expired.");
  return JSON.parse(raw);
}

export async function saveJob(env, job) {
  await env.STATE.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: 60 * 60 * 24 * 14 });
}

async function makeBackupRef(env, repo, branch, head, reason = "pre-deploy") {
  const { base } = repoParts(repo);
  const id = makeId(10);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const backupBranch = `repoforge-backup-${stamp}-${id}`;
  await githubRequest(env, `${base}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${backupBranch}`, sha: head.sha })
  });
  const backup = { id, repo, branch, sha: head.sha, treeSha: head.treeSha, backupBranch, reason, createdAt: new Date().toISOString() };
  await env.STATE.put(`backup:${repo.toLowerCase()}:${id}`, JSON.stringify(backup));
  await writeEvent(env, { type: "backup", repo, branch, backupId: id, backupBranch, sha: head.sha, reason });
  return backup;
}

export async function createBackup(env, repo, branch, reason = "manual") {
  const head = await getBranchHead(env, repo, branch);
  return makeBackupRef(env, repo, branch, head, reason);
}

export async function listBackups(env, repo = "") {
  const prefix = repo ? `backup:${repo.toLowerCase()}:` : "backup:";
  const list = await env.STATE.list({ prefix, limit: 100 });
  const values = await Promise.all(list.keys.map(async ({ name }) => {
    const raw = await env.STATE.get(name);
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  }));
  return values.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function refreshJob(env, job) {
  const head = await getBranchHead(env, job.repo, job.branch);
  const remoteFiles = await getRemoteTree(env, job.repo, head.treeSha);
  const archivePaths = new Set(job.archiveFiles.map((file) => file.path));
  const remoteMap = new Map(remoteFiles.map((file) => [file.path, file]));
  job.baseSha = head.sha;
  job.baseTreeSha = head.treeSha;
  job.remoteFiles = remoteFiles;
  if (job.status === "stale") {
    job.status = "pending";
    job.staleAt = null;
  }
  job.targets = [
    ...job.archiveFiles.map((file) => ({ path: file.path, source: "archive", size: file.size, action: job.actions[file.path] || "update", exists: remoteMap.has(file.path), remoteSha: remoteMap.get(file.path)?.sha || null })),
    ...remoteFiles.filter((file) => !archivePaths.has(file.path)).map((file) => ({ path: file.path, source: "remote", size: file.size, action: job.actions[file.path] || "keep", exists: true, remoteSha: file.sha }))
  ];
  for (const target of job.targets) job.actions[target.path] = target.action;
  job.updatedAt = new Date().toISOString();
  await saveJob(env, job);
  return job;
}

async function createBlob(env, base, bytes) {
  const blob = await githubRequest(env, `${base}/git/blobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: toBase64(bytes), encoding: "base64" })
  });
  return blob.sha;
}

async function readArchiveFiles(env, job) {
  const object = await env.ARCHIVES.get(job.archiveKey);
  if (!object) throw new Error("The uploaded ZIP has expired or was removed from R2.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const extracted = inspectZip(bytes, {
    maxFiles: Number(env.MAX_FILES || 400),
    maxFileBytes: Number(env.MAX_FILE_BYTES || 8 * 1024 * 1024),
    maxExpandedBytes: Number(env.MAX_EXPANDED_BYTES || 32 * 1024 * 1024)
  });
  return stripCommonRoot(extracted, job.stripRoot);
}

export async function deployJob(env, jobId, actor = "admin") {
  const job = await loadJob(env, jobId);
  if (job.status !== "pending") throw new Error(`Job status is ${job.status}; only pending jobs can be deployed.`);
  assertAllowedRepo(env, job.repo);
  const head = await getBranchHead(env, job.repo, job.branch);
  if (head.sha !== job.baseSha) {
    job.status = "stale";
    job.staleAt = new Date().toISOString();
    await saveJob(env, job);
    throw new Error("The target branch changed after this preview. Refresh the preview and review the updated file list before deploying.");
  }

  const archiveFiles = await readArchiveFiles(env, job);
  const archiveMap = new Map(archiveFiles.map((file) => [file.path, file]));
  const remoteMap = new Map(job.remoteFiles.map((file) => [file.path, file]));
  const changes = [];
  const updates = [];
  for (const target of job.targets) {
    const action = job.actions[target.path] || "keep";
    const remote = remoteMap.get(target.path);
    if (action === "update") {
      const file = archiveMap.get(target.path);
      if (!file) throw new Error(`Cannot update ${target.path}: it is not present in the uploaded ZIP.`);
      updates.push({ path: target.path, file, mode: remote?.mode === "100755" ? "100755" : "100644" });
    } else if (action === "delete" && remote) {
      changes.push({ path: target.path, mode: remote.mode || "100644", type: "blob", sha: null });
    }
  }

  const changeCount = updates.length + changes.length;
  if (!changeCount) throw new Error("There are no selected changes to deploy.");
  const maxChanges = Number(env.MAX_CHANGED_FILES || 25);
  if (changeCount > maxChanges) throw new Error(`This deployment changes ${changeCount} files. The configured maximum is ${maxChanges}. Split the release into smaller ZIP uploads or raise MAX_CHANGED_FILES after reviewing your Workers plan limits.`);

  // Persist an in-progress state before any mutating GitHub calls to make duplicate
  // Telegram callbacks and repeated dashboard clicks fail closed.
  job.status = "deploying";
  job.deployStartedAt = new Date().toISOString();
  job.lastError = null;
  await saveJob(env, job);

  const { base } = repoParts(job.repo);
  let backup = null;
  try {
    // Preserve the current commit before creating blobs, trees, commits, or refs.
    backup = await makeBackupRef(env, job.repo, job.branch, head, "pre-deploy");

    for (const update of updates) {
      const sha = await createBlob(env, base, update.file.bytes);
      changes.push({ path: update.path, mode: update.mode, type: "blob", sha });
    }

    const tree = await githubRequest(env, `${base}/git/trees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_tree: head.treeSha, tree: changes })
    });
    const commit = await githubRequest(env, `${base}/git/commits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `RepoForge: deploy ${job.id} (${changeCount} file changes)`,
        tree: tree.sha,
        parents: [head.sha]
      })
    });

    // Optimistic concurrency: never force-push. A concurrent branch update causes
    // this request to fail safely rather than overwriting another commit.
    const branchRefPath = job.branch.split("/").map(encodeURIComponent).join("/");
    await githubRequest(env, `${base}/git/refs/heads/${branchRefPath}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.sha, force: false })
    });

    job.status = "deployed";
    job.deployedAt = new Date().toISOString();
    job.deployedSha = commit.sha;
    job.backupId = backup.id;
    job.changeCount = changeCount;
    job.updatedCount = updates.length;
    job.deletedCount = changes.length - updates.length;
    job.actor = actor;
    await saveJob(env, job);
    await writeEvent(env, { type: "deploy", repo: job.repo, branch: job.branch, jobId: job.id, commitSha: commit.sha, backupId: backup.id, changed: changeCount, updated: updates.length, deleted: changes.length - updates.length, actor });
    return { job, backup, commit: { sha: commit.sha, url: commit.html_url || `https://github.com/${job.repo}/commit/${commit.sha}` }, changed: changeCount, updated: updates.length, deleted: changes.length - updates.length };
  } catch (error) {
    // If GitHub accepted the ref update but a later audit write failed, the next
    // retry will be marked stale by the branch SHA check; it will never force-push.
    job.status = "pending";
    job.lastError = String(error.message || error).slice(0, 500);
    job.failedAt = new Date().toISOString();
    if (backup) job.backupId = backup.id;
    await saveJob(env, job);
    throw error;
  }
}

export async function restoreBackup(env, backupId, actor = "admin") {
  const list = await env.STATE.list({ prefix: "backup:", limit: 1000 });
  let backup = null;
  for (const { name } of list.keys) {
    const raw = await env.STATE.get(name);
    if (!raw) continue;
    try { const value = JSON.parse(raw); if (value.id === backupId) { backup = value; break; } } catch { /* ignore malformed record */ }
  }
  if (!backup) throw new Error("Backup was not found.");
  assertAllowedRepo(env, backup.repo);
  const current = await getBranchHead(env, backup.repo, backup.branch);
  const beforeRestore = await makeBackupRef(env, backup.repo, backup.branch, current, "pre-restore");
  const { base } = repoParts(backup.repo);
  const backupCommit = await githubRequest(env, `${base}/git/commits/${backup.sha}`);
  const restoredCommit = await githubRequest(env, `${base}/git/commits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `RepoForge: restore backup ${backup.id}`,
      tree: backupCommit.tree.sha,
      parents: [current.sha]
    })
  });
  const branchRefPath = backup.branch.split("/").map(encodeURIComponent).join("/");
  await githubRequest(env, `${base}/git/refs/heads/${branchRefPath}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: restoredCommit.sha, force: false })
  });
  await writeEvent(env, { type: "restore", repo: backup.repo, branch: backup.branch, backupId, beforeRestoreBackupId: beforeRestore.id, commitSha: restoredCommit.sha, actor });
  return { backup, beforeRestore, commit: { sha: restoredCommit.sha, url: restoredCommit.html_url || `https://github.com/${backup.repo}/commit/${restoredCommit.sha}` } };
}

export async function listCommits(env, repo, branch, limit = 20) {
  assertAllowedRepo(env, repo);
  const { base } = repoParts(repo);
  const data = await githubRequest(env, `${base}/commits?sha=${encodeURIComponent(branch)}&per_page=${Math.min(50, Math.max(1, limit))}`);
  return data.map((item) => ({ sha: item.sha, message: item.commit?.message?.split("\n")[0] || "(no message)", date: item.commit?.committer?.date || item.commit?.author?.date, author: item.commit?.author?.name, url: item.html_url }));
}
