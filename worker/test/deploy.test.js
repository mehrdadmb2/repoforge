import test from "node:test";
import assert from "node:assert/strict";
import {
  completeJobUpload, loadJob, prepareJobFromManifest, restoreBackup,
  saveJob, startDeployJob, storeJobFile, uploadDeployBlob, finishDeployJob,
  listBackups, listJobs
} from "../src/github.js";

class MemoryKV {
  constructor() { this.data = new Map(); }
  async get(key, type) {
    const value = this.data.get(key);
    if (value == null) return null;
    if (type === "arrayBuffer" && value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return value;
  }
  async put(key, value) { this.data.set(key, value); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = "", limit = 1000 } = {}) {
    return { keys: [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) };
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

test("ZIP manifest -> KV payloads -> backup -> Git blobs -> one commit -> restore", async () => {
  const previousFetch = globalThis.fetch;
  const kv = new MemoryKV();
  const env = {
    GITHUB_TOKEN: "test-token",
    ALLOWED_REPOS: "test-owner/demo",
    STATE: kv,
    MAX_ARCHIVE_BYTES: "1000000",
    MAX_EXPANDED_BYTES: "1000000",
    MAX_FILE_BYTES: "1000000",
    MAX_FILES: "20",
    MAX_REMOTE_FILES: "100",
    MAX_CHANGED_FILES: "25"
  };
  let currentHead = "initial-commit";
  let nextId = 1;
  const commits = new Map([
    ["initial-commit", { sha: "initial-commit", tree: { sha: "initial-tree" }, message: "Initial commit", parents: [] }]
  ]);
  const blobs = new Map();
  const trees = new Map();
  const backupRefs = new Map();
  let finalTreeChanges = null;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = String(init.method || "GET").toUpperCase();
    const base = "/repos/test-owner/demo";
    const body = init.body ? JSON.parse(init.body) : {};

    if (path === `${base}` && method === "GET") return jsonResponse({ full_name: "test-owner/demo", default_branch: "main", private: true, html_url: "https://github.com/test-owner/demo" });
    if (path === `${base}/git/ref/heads/main` && method === "GET") return jsonResponse({ object: { sha: currentHead } });
    if (path.startsWith(`${base}/git/commits/`) && method === "GET") {
      const sha = decodeURIComponent(path.split("/").at(-1));
      const commit = commits.get(sha);
      return commit ? jsonResponse(commit) : jsonResponse({ message: "Not Found" }, 404);
    }
    if (path.startsWith(`${base}/git/trees/`) && method === "GET") {
      const sha = decodeURIComponent(path.split("/").at(-1));
      if (sha === "initial-tree") return jsonResponse({ truncated: false, tree: [
        { path: "README.md", type: "blob", sha: "old-readme", size: 3, mode: "100644" },
        { path: "old.txt", type: "blob", sha: "old-file", size: 3, mode: "100644" }
      ] });
      return jsonResponse({ truncated: false, tree: [] });
    }
    if (path === `${base}/git/refs` && method === "POST") {
      backupRefs.set(body.ref, body.sha);
      return jsonResponse({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (path === `${base}/git/blobs` && method === "POST") {
      const sha = `blob-${nextId++}`;
      blobs.set(sha, body.content);
      return jsonResponse({ sha }, 201);
    }
    if (path === `${base}/git/trees` && method === "POST") {
      const sha = `tree-${nextId++}`;
      trees.set(sha, body);
      finalTreeChanges = body.tree;
      return jsonResponse({ sha }, 201);
    }
    if (path === `${base}/git/commits` && method === "POST") {
      const sha = `commit-${nextId++}`;
      const commit = { sha, tree: { sha: body.tree }, message: body.message, parents: body.parents.map((parentSha) => ({ sha: parentSha })) };
      commits.set(sha, commit);
      return jsonResponse({ ...commit, html_url: `https://github.com/test-owner/demo/commit/${sha}` }, 201);
    }
    if (path === `${base}/git/refs/heads/main` && method === "PATCH") {
      const commit = commits.get(body.sha);
      if (!commit || body.force !== false || commit.parents?.[0]?.sha !== currentHead) return jsonResponse({ message: "Update is not a fast-forward" }, 422);
      currentHead = body.sha;
      return jsonResponse({ ref: "refs/heads/main", object: { sha: currentHead } });
    }
    return jsonResponse({ message: `Unhandled mock route ${method} ${path}` }, 500);
  };

  try {
    const encodedReadme = btoa("new");
    const encodedNew = btoa("add");
    const job = await prepareJobFromManifest(env, {
      repo: "test-owner/demo", branch: "main", fileName: "test-release.zip", archiveBytes: 120,
      files: [{ path: "README.md", size: 3 }, { path: "new.txt", size: 3 }]
    });
    assert.equal(job.status, "uploading");
    const compactJobs = await listJobs(env, 10);
    assert.equal(compactJobs.length, 1);
    assert.equal(compactJobs[0].id, job.id);
    assert.equal(compactJobs[0].archiveFileCount, 2);
    assert.equal(Object.hasOwn(compactJobs[0], "archiveFiles"), false, "job list must not return full archive metadata");
    assert.equal(Object.hasOwn(compactJobs[0], "targets"), false, "job list must not return full target arrays");
    await assert.rejects(() => prepareJobFromManifest(env, {
      repo: "test-owner/demo", branch: "main", fileName: "invalid.zip", archiveBytes: 120,
      files: [{ path: "config", size: 1 }, { path: "config/settings.json", size: 1 }]
    }), /File\/directory path collision/);
    await assert.rejects(() => prepareJobFromManifest(env, {
      repo: "test-owner/demo", branch: "main", fileName: "remote-conflict.zip", archiveBytes: 120,
      files: [{ path: "old.txt/settings.json", size: 1 }]
    }), /Archive path conflicts with an existing repository file: old.txt/);
    await storeJobFile(env, job.id, 0, encodedReadme);
    await storeJobFile(env, job.id, 1, encodedNew);
    await completeJobUpload(env, job.id);
    assert.equal((await listJobs(env, 10))[0].status, "pending", "compact job summary follows upload completion");

    const editable = await loadJob(env, job.id);
    editable.actions["README.md"] = "keep";
    editable.actions["old.txt"] = "delete";
    await saveJob(env, editable);

    const started = await startDeployJob(env, job.id, "test-admin");
    assert.equal(started.status, "deploying");
    assert.ok(started.deployment.backupId);
    assert.equal(backupRefs.get(`refs/heads/${started.deployment.backupBranch}`), "initial-commit");

    const blob = await uploadDeployBlob(env, job.id, 1);
    assert.ok(blob.sha.startsWith("blob-"));
    const finished = await finishDeployJob(env, job.id, "test-admin");
    assert.equal(finished.job.status, "deployed");
    assert.equal((await listJobs(env, 10)).find((item) => item.id === job.id).status, "deployed", "compact job summary follows deployment completion");
    assert.equal(finished.updated, 1);
    assert.equal(finished.deleted, 1);
    assert.equal(currentHead, finished.commit.sha);
    assert.equal(finalTreeChanges.find((entry) => entry.path === "old.txt").sha, null);
    assert.equal(finalTreeChanges.find((entry) => entry.path === "new.txt").sha, blob.sha);
    assert.equal(blobs.has(blob.sha), true);

    const backupList = await listBackups(env, "test-owner/demo");
    assert.equal(backupList.length, 1);
    // Simulate a v1 backup that has no direct backup-id index.
    await kv.delete(`backup-id:${backupList[0].id}`);
    const restored = await restoreBackup(env, backupList[0].id, "test-admin");
    assert.equal(restored.backup.sha, "initial-commit");
    assert.equal(currentHead, restored.commit.sha);
    assert.equal(commits.get(currentHead).tree.sha, "initial-tree");
    assert.notEqual(commits.get(currentHead).parents[0].sha, "initial-commit");

    // A concurrent push after backup/blob upload must stop the final publication.
    const raceBase = currentHead;
    const raceJob = await prepareJobFromManifest(env, {
      repo: "test-owner/demo", branch: "main", fileName: "race-test.zip", archiveBytes: 120,
      files: [{ path: "README.md", size: 3 }]
    });
    await storeJobFile(env, raceJob.id, 0, btoa("new"));
    await completeJobUpload(env, raceJob.id);
    await startDeployJob(env, raceJob.id, "test-admin");
    await uploadDeployBlob(env, raceJob.id, 0);
    commits.set("race-commit", { sha: "race-commit", tree: { sha: "race-tree" }, message: "External concurrent commit", parents: [{ sha: raceBase }] });
    currentHead = "race-commit";
    await assert.rejects(() => finishDeployJob(env, raceJob.id, "test-admin"), /target branch changed/);
    assert.equal(currentHead, "race-commit", "the external commit must remain the branch head");
    assert.equal((await loadJob(env, raceJob.id)).status, "stale");

    await kv.put("job:legacyjob22", JSON.stringify({ id: "legacyjob22", status: "pending", archiveKey: "uploads/legacy.zip" }));
    await assert.rejects(() => loadJob(env, "legacyjob22"), /older RepoForge version/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
