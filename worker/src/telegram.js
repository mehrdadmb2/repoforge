import {
  createBackup, getRepository, listBackups, listBranches, listCommits,
  listJobs, listRepositories, loadJob, refreshJob, restoreBackup, saveJob, startDeployJob
} from "./github.js";
import { escapeHtml, isoNow, makeId, parseCommand, writeEvent } from "./utils.js";

const STAGE_TTL = 60 * 60;
const PAGE_SIZE = 7;

async function telegramApi(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${response.status}`);
  return result.result;
}

export async function streamTelegramStageArchive(env, stage) {
  if (!stage?.telegramFileId || String(stage.adminId || '') !== String(env.TELEGRAM_ADMIN_ID || '')) {
    throw new Error('Telegram archive stage is invalid or does not belong to the configured administrator.');
  }
  const metadata = await telegramApi(env, 'getFile', { file_id: stage.telegramFileId });
  if (!metadata.file_path) throw new Error('Telegram did not return a downloadable file path.');
  const maxBytes = Number(env.MAX_ARCHIVE_BYTES || 19 * 1024 * 1024);
  const fileSize = Number(metadata.file_size || stage.size || 0);
  if (fileSize > maxBytes) throw new Error(`Telegram archive exceeds the ${Math.round(maxBytes / 1048576)} MB limit.`);
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${metadata.file_path}`);
  if (!response.ok || !response.body) throw new Error(`Telegram file download failed (${response.status}).`);
  return { body: response.body, size: fileSize || null };
}

function adminAllowed(env, userId) {
  return Boolean(env.TELEGRAM_ADMIN_ID) && String(userId) === String(env.TELEGRAM_ADMIN_ID);
}

function isPrivateAdminChat(env, message) {
  return message?.chat?.type === "private" && adminAllowed(env, message?.from?.id) && String(message.chat.id) === String(env.TELEGRAM_ADMIN_ID);
}

async function send(env, chatId, html, extra = {}) {
  return telegramApi(env, "sendMessage", {
    chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true,
    ...extra
  });
}

async function edit(env, chatId, messageId, html, extra = {}) {
  return telegramApi(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML", disable_web_page_preview: true,
    ...extra
  });
}

async function answerCallback(env, callbackId, textValue = "", showAlert = false) {
  try { await telegramApi(env, "answerCallbackQuery", { callback_query_id: callbackId, text: textValue, show_alert: showAlert }); }
  catch { /* expired callback queries are harmless */ }
}

async function getJsonState(env, key) {
  const raw = await env.STATE.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function selection(env, userId) {
  return getJsonState(env, `tg-selection:${userId}`);
}

async function latestJob(env) {
  const summary = (await listJobs(env, 100))[0];
  return summary ? loadJob(env, summary.id) : null;
}

function actionLabel(action) {
  return action === "update" ? "UPDATE" : action === "delete" ? "DELETE" : "KEEP";
}

function actionEmoji(action) {
  return action === "update" ? "🟢" : action === "delete" ? "🔴" : "⚪";
}

function nextAction(target, current) {
  if (target.source === "archive") {
    if (!target.exists) return current === "update" ? "keep" : "update";
    return current === "update" ? "keep" : current === "keep" ? "delete" : "update";
  }
  return current === "delete" ? "keep" : "delete";
}

function summarize(job) {
  const targets = job.targets || [];
  const update = targets.filter((target) => target.source === "archive" && (job.actions[target.path] || target.action) === "update").length;
  const remove = targets.filter((target) => target.exists && (job.actions[target.path] || target.action) === "delete").length;
  const keep = targets.length - update - remove;
  return { update, remove, keep, changes: update + remove };
}

async function showRepositories(env, chatId, userId, messageId = null) {
  const repos = await listRepositories(env);
  if (!repos.length) return send(env, chatId, "<b>No allowed repositories found.</b>\nCheck the <code>ALLOWED_REPOS</code> Worker secret and GitHub token permissions.");
  await env.STATE.put(`tg-repo-menu:${userId}`, JSON.stringify(repos.map((repo) => ({ fullName: repo.fullName, defaultBranch: repo.defaultBranch }))), { expirationTtl: 600 });
  const keyboard = repos.slice(0, 30).map((repo, index) => [{ text: `${repo.private ? "🔒" : "🌐"} ${repo.fullName}`, callback_data: `repo:${index}` }]);
  const payload = { reply_markup: { inline_keyboard: keyboard } };
  if (messageId) return edit(env, chatId, messageId, "<b>Select a repository</b>\nOnly repositories listed in <code>ALLOWED_REPOS</code> are shown.", payload);
  return send(env, chatId, "<b>Select a repository</b>\nOnly repositories listed in <code>ALLOWED_REPOS</code> are shown.", payload);
}

async function showBranches(env, chatId, userId, repo, messageId = null) {
  const branches = await listBranches(env, repo);
  if (!branches.length) return send(env, chatId, `No branches found for <code>${escapeHtml(repo)}</code>.`);
  const repository = await getRepository(env, repo);
  const sorted = [...branches].sort((a, b) => Number(b.name === repository.defaultBranch) - Number(a.name === repository.defaultBranch));
  await env.STATE.put(`tg-branch-menu:${userId}`, JSON.stringify({ repo, branches: sorted.map((branch) => branch.name) }), { expirationTtl: 600 });
  const keyboard = sorted.slice(0, 50).map((branch, index) => [{ text: `${branch.name === repository.defaultBranch ? "⭐ " : "🌿 "}${branch.name}${branch.protected ? " · protected" : ""}`, callback_data: `branch:${index}` }]);
  const payload = { reply_markup: { inline_keyboard: keyboard } };
  if (messageId) return edit(env, chatId, messageId, `<b>Select a branch</b>\n<code>${escapeHtml(repo)}</code>`, payload);
  return send(env, chatId, `<b>Select a branch</b>\n<code>${escapeHtml(repo)}</code>`, payload);
}

async function showPreview(env, chatId, job, messageId = null) {
  const counts = summarize(job);
  const text = `<b>Release preview</b>\n` +
    `ID: <code>${escapeHtml(job.id)}</code>\n` +
    `Repository: <code>${escapeHtml(job.repo)}</code>\n` +
    `Branch: <code>${escapeHtml(job.branch)}</code>\n` +
    `Status: <b>${escapeHtml(job.status)}</b>\n` +
    `ZIP files: <b>${job.archiveFiles.length}</b> · Total paths: <b>${job.targets.length}</b>\n\n` +
    `🟢 Update: <b>${counts.update}</b>\n⚪ Keep: <b>${counts.keep}</b>\n🔴 Delete: <b>${counts.remove}</b>\n` +
    `Selected changes: <b>${counts.changes}</b> / ${Number(env.MAX_CHANGED_FILES || 100)}`;
  const buttons = [
    [{ text: "📁 Review files", callback_data: `p:${job.id}:0` }],
    ...(["pending", "deploying"].includes(job.status) && counts.changes > 0 && counts.changes <= Number(env.MAX_CHANGED_FILES || 100)
      ? [[{ text: job.status === "deploying" ? "↗ Continue in dashboard" : "🚀 Deploy release", callback_data: `d:${job.id}` }]] : []),
    ...(job.status === "pending" || job.status === "stale" ? [[{ text: "↻ Refresh preview", callback_data: `r:${job.id}` }, { text: "✖ Cancel", callback_data: `c:${job.id}` }]] : [])
  ];
  const payload = { reply_markup: { inline_keyboard: buttons } };
  if (messageId) return edit(env, chatId, messageId, text, payload);
  return send(env, chatId, text, payload);
}

async function renderFiles(env, chatId, job, page = 0, messageId = null) {
  const pages = Math.max(1, Math.ceil(job.targets.length / PAGE_SIZE));
  const currentPage = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const targets = job.targets.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const lines = targets.map((target, offset) => {
    const index = currentPage * PAGE_SIZE + offset;
    const action = job.actions[target.path] || target.action;
    const kind = target.source === "archive" ? "ZIP" : "GH";
    return `${index + 1}. ${actionEmoji(action)} <code>${escapeHtml(target.path)}</code>\n   ${kind} · ${target.source === "archive" ? (target.exists ? "exists" : "new") : "repository-only"} · ${actionLabel(action)}`;
  });
  const keyboard = targets.map((target, offset) => {
    const index = currentPage * PAGE_SIZE + offset;
    const action = job.actions[target.path] || target.action;
    return [{ text: `${actionEmoji(action)} ${String(index + 1).padStart(2, "0")} · ${actionLabel(action)}`, callback_data: `f:${job.id}:${index}` }];
  });
  const nav = [];
  if (currentPage > 0) nav.push({ text: "← Previous", callback_data: `p:${job.id}:${currentPage - 1}` });
  nav.push({ text: `${currentPage + 1}/${pages}`, callback_data: "noop" });
  if (currentPage + 1 < pages) nav.push({ text: "Next →", callback_data: `p:${job.id}:${currentPage + 1}` });
  keyboard.push(nav, [{ text: "📊 Summary", callback_data: `s:${job.id}` }, { text: "🚀 Deploy", callback_data: `d:${job.id}` }]);
  const payload = { reply_markup: { inline_keyboard: keyboard } };
  const text = `<b>File review</b> · <code>${escapeHtml(job.id)}</code>\n${escapeHtml(job.repo)} @ ${escapeHtml(job.branch)}\n\n${lines.join("\n\n") || "No files."}\n\nTap an action to cycle its state.`;
  if (messageId) return edit(env, chatId, messageId, text, payload);
  return send(env, chatId, text, payload);
}

async function commandHelp(env, chatId) {
  return send(env, chatId,
    `<b>RepoForge Manager · Commands</b>\n\n` +
    `<code>/status</code> — service status\n` +
    `<code>/repos</code> — choose repository\n` +
    `<code>/select</code> — choose repository and branch\n` +
    `<code>/current</code> — selected target\n` +
    `<code>/branches</code> — change branch\n` +
    `<code>/upload</code> — ZIP upload instructions\n` +
    `<code>/jobs</code> — recent deployment jobs\n` +
    `<code>/preview [jobId]</code> — inspect a release\n` +
    `<code>/files [jobId]</code> — file-level controls\n` +
    `<code>/deploy [jobId]</code> — confirm a deployment\n` +
    `<code>/cancel [jobId]</code> — cancel a pending job\n` +
    `<code>/backup</code> — create a manual backup\n` +
    `<code>/backups</code> — list saved backups\n` +
    `<code>/restore backupId</code> — restore a backup\n` +
    `<code>/history</code> — recent Git commits\n` +
    `<code>/help</code> — this help message\n\n` +
    `Send a ZIP as a Telegram document after selecting a repository and branch. The bot stores only the Telegram file reference and target metadata in KV, then gives you a private dashboard link for browser-side ZIP inspection.`
  );
}

async function runCommand(env, message, chatId, rawText) {
  const { command, args } = parseCommand(rawText);
  const userId = message.from.id;
  switch (command) {
    case "/start":
      return send(env, chatId, `<b>RepoForge Manager is ready.</b>\nAdministrator: <code>${escapeHtml(userId)}</code>\n\nUse <code>/help</code> to see all commands, then <code>/select</code> to choose a repository and branch.`);
    case "/help":
      return commandHelp(env, chatId);
    case "/status": {
      const [repos, jobs, backups] = await Promise.all([listRepositories(env), listJobs(env, 100), listBackups(env)]);
      const pending = jobs.filter((job) => ["pending", "stale", "uploading", "deploying"].includes(job.status)).length;
      return send(env, chatId, `<b>RepoForge status</b>\n🟢 Worker: online\n🟢 GitHub: connected\n🟢 Storage: Workers KV\n🟢 R2 dependency: none\n\nAllowed repositories: <b>${repos.length}</b>\nPending jobs: <b>${pending}</b>\nBackups: <b>${backups.length}</b>\nPlan profile: <b>Cloudflare Free</b>`);
    }
    case "/repos":
    case "/select":
      return showRepositories(env, chatId, userId);
    case "/current": {
      const selected = await selection(env, userId);
      return selected
        ? send(env, chatId, `<b>Current target</b>\nRepository: <code>${escapeHtml(selected.repo)}</code>\nBranch: <code>${escapeHtml(selected.branch)}</code>\nSelected: ${escapeHtml(selected.selectedAt || "")}`)
        : send(env, chatId, "No repository selected. Use <code>/select</code>.");
    }
    case "/branches": {
      const selected = await selection(env, userId);
      if (!selected) return send(env, chatId, "Select a repository first with <code>/select</code>.");
      return showBranches(env, chatId, userId, selected.repo);
    }
    case "/upload": {
      const selected = await selection(env, userId);
      if (!selected) return send(env, chatId, "First choose a repository and branch with <code>/select</code>.");
      return send(env, chatId, `Send your ZIP as a Telegram <b>document</b> now.\nTarget: <code>${escapeHtml(selected.repo)}@${escapeHtml(selected.branch)}</code>\nMaximum compressed ZIP: <b>${Math.round(Number(env.MAX_ARCHIVE_BYTES || 19 * 1024 * 1024) / 1048576)} MB</b>.\n\nZIP extraction is performed in your browser after you open the dashboard link; the Worker does not spend its 10 ms Free-plan CPU budget decompressing files.`);
    }
    case "/jobs": {
      const jobs = await listJobs(env, 20);
      if (!jobs.length) return send(env, chatId, "No deployment jobs yet.");
      const keyboard = jobs.slice(0, 15).map((job) => [{ text: `${job.status.toUpperCase()} · ${job.repo} · ${job.id}`, callback_data: `s:${job.id}` }]);
      return send(env, chatId, `<b>Recent deployment jobs</b>\nSelect a job to inspect it.`, { reply_markup: { inline_keyboard: keyboard } });
    }
    case "/preview": {
      const job = args[0] ? await loadJob(env, args[0]) : await latestJob(env);
      if (!job) return send(env, chatId, "No deployment jobs found.");
      return showPreview(env, chatId, job);
    }
    case "/files": {
      const job = args[0] ? await loadJob(env, args[0]) : await latestJob(env);
      if (!job) return send(env, chatId, "No deployment jobs found.");
      return renderFiles(env, chatId, job, 0);
    }
    case "/deploy": {
      const job = args[0] ? await loadJob(env, args[0]) : await latestJob(env);
      if (!job) return send(env, chatId, "No deployment jobs found.");
      const counts = summarize(job);
      if (!["pending", "deploying"].includes(job.status) || counts.changes < 1) return send(env, chatId, `This job cannot be deployed. Status: <b>${escapeHtml(job.status)}</b>; selected changes: ${counts.changes}.`);
      return send(env, chatId, `⚠️ <b>Confirm release</b>\n<code>${escapeHtml(job.repo)}@${escapeHtml(job.branch)}</code>\nJob: <code>${escapeHtml(job.id)}</code>\nChanges: <b>${counts.changes}</b>\n\nA Git backup branch will be created before one commit is pushed.`, { reply_markup: { inline_keyboard: [[{ text: "✅ Confirm deployment", callback_data: `D:${job.id}` }, { text: "Cancel", callback_data: "noop" }]] } });
    }
    case "/cancel": {
      const id = args[0];
      if (!id) return send(env, chatId, "Usage: <code>/cancel jobId</code>");
      const job = await loadJob(env, id);
      if (!["uploading", "pending", "stale", "deploying"].includes(job.status)) return send(env, chatId, `Cannot cancel a job with status <b>${escapeHtml(job.status)}</b>.`);
      job.status = "cancelled";
      job.cancelledAt = isoNow();
      await saveJob(env, job);
      return send(env, chatId, `Job <code>${escapeHtml(id)}</code> cancelled. No new GitHub commit was made.`);
    }
    case "/backup": {
      const selected = await selection(env, userId);
      if (!selected) return send(env, chatId, "Select a repository and branch first.");
      const backup = await createBackup(env, selected.repo, selected.branch, "manual-telegram");
      return send(env, chatId, `✅ <b>Backup created</b>\nRepository: <code>${escapeHtml(backup.repo)}</code>\nBranch: <code>${escapeHtml(backup.branch)}</code>\nBackup ID: <code>${escapeHtml(backup.id)}</code>\nGit branch: <code>${escapeHtml(backup.backupBranch)}</code>`);
    }
    case "/backups": {
      const backups = await listBackups(env);
      if (!backups.length) return send(env, chatId, "No backups have been created yet.");
      const keyboard = backups.slice(0, 20).map((backup) => [{ text: `${backup.repo} · ${backup.id} · ${backup.reason}`, callback_data: `bkp:${backup.id}` }]);
      return send(env, chatId, `<b>Recent backups</b>\nChoose a backup to inspect or restore.`, { reply_markup: { inline_keyboard: keyboard } });
    }
    case "/restore": {
      const id = args[0];
      if (!id) return send(env, chatId, "Usage: <code>/restore backupId</code>. Use <code>/backups</code> to find an ID.");
      const backup = (await listBackups(env)).find((item) => item.id === id);
      if (!backup) return send(env, chatId, "Backup ID was not found in KV metadata.");
      return send(env, chatId, `⚠️ <b>Confirm restore</b>\n<code>${escapeHtml(backup.repo)}@${escapeHtml(backup.branch)}</code>\nBackup: <code>${escapeHtml(id)}</code>\n\nThe current branch will also be backed up before restoration.`, { reply_markup: { inline_keyboard: [[{ text: "⚠️ Confirm restore", callback_data: `R:${id}` }, { text: "Cancel", callback_data: "noop" }]] } });
    }
    case "/history": {
      const selected = await selection(env, userId);
      if (!selected) return send(env, chatId, "Select a repository first.");
      const commits = await listCommits(env, selected.repo, selected.branch, 10);
      if (!commits.length) return send(env, chatId, "No commits found.");
      return send(env, chatId, `<b>Recent commits</b>\n\n${commits.map((item) => `• <b>${escapeHtml(item.message)}</b>\n  <code>${item.sha.slice(0, 10)}</code> · ${escapeHtml(item.date || "unknown")} · ${escapeHtml(item.author || "unknown")}`).join("\n\n")}`);
    }
    default:
      return send(env, chatId, "Unknown command. Use <code>/help</code> for the complete command list.");
  }
}

async function receiveZip(env, message, chatId) {
  const selected = await selection(env, message.from.id);
  if (!selected) return send(env, chatId, "Choose your target first with <code>/select</code>, then send the ZIP again.");
  const document = message.document;
  const fileName = String(document.file_name || "release.zip");
  if (!fileName.toLowerCase().endsWith(".zip")) return send(env, chatId, "Only <b>.zip</b> files are accepted.");
  const maxBytes = Number(env.MAX_ARCHIVE_BYTES || 19 * 1024 * 1024);
  if (Number(document.file_size || 0) > maxBytes) return send(env, chatId, `ZIP exceeds the ${Math.round(maxBytes / 1048576)} MB limit.`);

  const declaredSize = Number(document.file_size || 0);
  if (declaredSize > maxBytes) throw new Error("Telegram ZIP exceeds the configured maximum size.");

  const id = makeId(10);
  const stage = {
    id, repo: selected.repo, branch: selected.branch, fileName,
    size: declaredSize || null, telegramFileId: String(document.file_id),
    createdAt: isoNow(), adminId: String(message.from.id),
    status: "waiting-for-dashboard"
  };
  // Keep only the file_id and metadata in KV. The archive itself is streamed
  // from Telegram to the authenticated dashboard later, avoiding a large KV value.
  await env.STATE.put(`stage:${id}`, JSON.stringify(stage), { expirationTtl: Number(env.STAGE_TTL_SECONDS || STAGE_TTL) });
  await writeEvent(env, { type: "telegram-stage", repo: stage.repo, branch: stage.branch, stageId: id, fileName, bytes: stage.size, actor: String(message.from.id) });

  const dashboardUrl = String(env.DASHBOARD_URL || "https://mehrdadmb2.github.io/repoforge/").replace(/\/$/, "/");
  const link = `${dashboardUrl}?stage=${encodeURIComponent(id)}`;
  return send(env, chatId,
    `✅ <b>ZIP received and staged</b>\nFile: <code>${escapeHtml(fileName)}</code>\nSize: <b>${stage.size ? `${(stage.size / 1048576).toFixed(2)} MB` : "not reported"}</b>\nTarget: <code>${escapeHtml(stage.repo)}@${escapeHtml(stage.branch)}</code>\n\nOpen the private dashboard to inspect the archive, choose Update / Keep / Delete for each file, and deploy. The temporary Telegram file reference expires in about one hour.`,
    { reply_markup: { inline_keyboard: [[{ text: "Open RepoForge dashboard", url: link }]] } }
  );
}

async function handleCallback(env, callback) {
  const userId = callback.from?.id;
  const message = callback.message;
  if (!adminAllowed(env, userId) || message?.chat?.type !== "private" || String(message.chat.id) !== String(env.TELEGRAM_ADMIN_ID)) {
    await answerCallback(env, callback.id, "Unauthorized", true);
    return;
  }
  const data = String(callback.data || "");
  const parts = data.split(":");
  const action = parts[0];
  const id = parts[1];
  try {
    if (action === "noop") { await answerCallback(env, callback.id); return; }
    if (action === "repo") {
      const repos = await getJsonState(env, `tg-repo-menu:${userId}`) || [];
      const repo = repos[Number(id)];
      if (!repo) throw new Error("Repository menu expired. Run /select again.");
      await answerCallback(env, callback.id, "Repository selected.");
      await showBranches(env, message.chat.id, userId, repo.fullName, message.message_id);
      return;
    }
    if (action === "branch") {
      const menu = await getJsonState(env, `tg-branch-menu:${userId}`);
      const branch = menu?.branches?.[Number(id)];
      if (!menu || !branch) throw new Error("Branch menu expired. Run /select again.");
      const selected = { repo: menu.repo, branch, selectedAt: isoNow() };
      await env.STATE.put(`tg-selection:${userId}`, JSON.stringify(selected), { expirationTtl: 60 * 60 * 24 * 30 });
      await answerCallback(env, callback.id, "Target saved.");
      await edit(env, message.chat.id, message.message_id, `✅ <b>Target selected</b>\nRepository: <code>${escapeHtml(selected.repo)}</code>\nBranch: <code>${escapeHtml(selected.branch)}</code>\n\nYou can now send a ZIP document to this chat.`);
      return;
    }
    if (action === "s") {
      const job = await loadJob(env, id);
      await answerCallback(env, callback.id);
      return showPreview(env, message.chat.id, job, message.message_id);
    }
    if (action === "p") {
      const job = await loadJob(env, id);
      await answerCallback(env, callback.id);
      return renderFiles(env, message.chat.id, job, Number(parts[2] || 0), message.message_id);
    }
    if (action === "f") {
      const job = await loadJob(env, id);
      if (!["pending", "stale"].includes(job.status)) throw new Error("This job is not editable.");
      const index = Number(parts[2]);
      const target = job.targets[index];
      if (!target) throw new Error("File entry no longer exists.");
      job.actions[target.path] = nextAction(target, job.actions[target.path] || target.action);
      await saveJob(env, job);
      await answerCallback(env, callback.id, `${target.path}: ${actionLabel(job.actions[target.path])}`);
      return renderFiles(env, message.chat.id, job, Math.floor(index / PAGE_SIZE), message.message_id);
    }
    if (action === "r") {
      const job = await loadJob(env, id);
      await refreshJob(env, job);
      await answerCallback(env, callback.id, "Preview refreshed.");
      return showPreview(env, message.chat.id, await loadJob(env, id), message.message_id);
    }
    if (action === "d") {
      const job = await loadJob(env, id);
      const counts = summarize(job);
      if (!["pending", "deploying"].includes(job.status) || counts.changes < 1 || counts.changes > Number(env.MAX_CHANGED_FILES || 100)) throw new Error("This job cannot be deployed in its current state.");
      await answerCallback(env, callback.id);
      return edit(env, message.chat.id, message.message_id,
        `⚠️ <b>Confirm deployment</b>\n<code>${escapeHtml(job.repo)}@${escapeHtml(job.branch)}</code>\nJob: <code>${escapeHtml(job.id)}</code>\nChanges: <b>${counts.changes}</b>\n\nA backup branch will be created first.`,
        { reply_markup: { inline_keyboard: [[{ text: "✅ Confirm", callback_data: `D:${job.id}` }, { text: "Back", callback_data: `s:${job.id}` }]] } }
      );
    }
    if (action === "D") {
      const job = await startDeployJob(env, id, String(userId));
      const dashboardUrl = String(env.DASHBOARD_URL || "https://mehrdadmb2.github.io/repoforge/").replace(/\/$/, "/");
      const link = `${dashboardUrl}?job=${encodeURIComponent(job.id)}&deploy=1`;
      await answerCallback(env, callback.id, "Backup created. Continue in dashboard.");
      return edit(env, message.chat.id, message.message_id,
        `✅ <b>Deployment session prepared</b>\nRepository: <code>${escapeHtml(job.repo)}</code>\nBranch: <code>${escapeHtml(job.branch)}</code>\nJob: <code>${escapeHtml(job.id)}</code>\nBackup: <code>${escapeHtml(job.deployment.backupId)}</code>\n\nTo stay within Cloudflare Workers Free CPU limits, each Git Blob is uploaded in a separate request. Open the dashboard to finish the commit safely.`,
        { reply_markup: { inline_keyboard: [[{ text: "Continue deployment in dashboard", url: link }]] } }
      );
    }
    if (action === "c") {
      const job = await loadJob(env, id);
      if (["uploading", "pending", "stale", "deploying"].includes(job.status)) {
        job.status = "cancelled";
        job.cancelledAt = isoNow();
        await saveJob(env, job);
      }
      await answerCallback(env, callback.id, "Job cancelled.");
      return edit(env, message.chat.id, message.message_id, `Job <code>${escapeHtml(id)}</code> is <b>${escapeHtml(job.status)}</b>.`);
    }
    if (action === "bkp") {
      const backup = (await listBackups(env)).find((item) => item.id === id);
      if (!backup) throw new Error("Backup not found.");
      await answerCallback(env, callback.id);
      return edit(env, message.chat.id, message.message_id,
        `<b>Backup details</b>\nRepository: <code>${escapeHtml(backup.repo)}</code>\nBranch: <code>${escapeHtml(backup.branch)}</code>\nID: <code>${escapeHtml(backup.id)}</code>\nCommit: <code>${backup.sha.slice(0, 12)}</code>\nCreated: ${escapeHtml(backup.createdAt)}\nReason: ${escapeHtml(backup.reason)}`,
        { reply_markup: { inline_keyboard: [[{ text: "⚠️ Restore this backup", callback_data: `R:${backup.id}` }]] } }
      );
    }
    if (action === "R") {
      await answerCallback(env, callback.id, "Restore started.");
      await edit(env, message.chat.id, message.message_id, `⏳ Restoring backup <code>${escapeHtml(id)}</code>…`);
      const result = await restoreBackup(env, id, String(userId));
      return send(env, message.chat.id, `✅ <b>Restore complete</b>\nRepository: <code>${escapeHtml(result.backup.repo)}</code>\nBranch: <code>${escapeHtml(result.backup.branch)}</code>\nPre-restore backup: <code>${escapeHtml(result.beforeRestore.id)}</code>\nCommit: <a href="${escapeHtml(result.commit.url)}">${result.commit.sha.slice(0, 12)}</a>`);
    }
    await answerCallback(env, callback.id, "Unknown action.", true);
  } catch (error) {
    await answerCallback(env, callback.id, "Action failed.", true);
    await send(env, message?.chat?.id || env.TELEGRAM_ADMIN_ID, `❌ ${escapeHtml(error.message)}`);
  }
}

export async function handleTelegramWebhook(request, env, ctx = null) {
  if (!env.TELEGRAM_BOT_TOKEN || !/^\d+$/.test(String(env.TELEGRAM_ADMIN_ID || "")) || String(env.TELEGRAM_WEBHOOK_SECRET || "").length < 24) {
    return new Response("Telegram is not configured. Check bot token, numeric admin ID, and webhook secret.", { status: 503 });
  }
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  let update;
  try { update = await request.json(); }
  catch { return new Response("Bad Request", { status: 400 }); }

  if (Number.isInteger(update.update_id)) {
    const updateKey = `tg-update:${update.update_id}`;
    if (await env.STATE.get(updateKey)) return new Response("ok");
    await env.STATE.put(updateKey, "1", { expirationTtl: 60 * 60 * 24 });
  }

  const processUpdate = async () => {
    try {
      if (update.callback_query) {
        await handleCallback(env, update.callback_query);
        return;
      }
      const message = update.message;
      if (!message) return;
      if (!isPrivateAdminChat(env, message)) {
        if (message.chat?.type === "private" && message.from?.id) {
          try { await send(env, message.chat.id, "⛔ This bot is private and restricted to its configured administrator."); } catch { /* ignore delivery errors */ }
        }
        return;
      }
      if (message.document) {
        await receiveZip(env, message, message.chat.id);
        return;
      }
      if (message.text?.startsWith("/")) {
        await runCommand(env, message, message.chat.id, message.text);
      } else {
        await send(env, message.chat.id, "Send a ZIP archive or use <code>/help</code>.");
      }
    } catch (error) {
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id || env.TELEGRAM_ADMIN_ID;
      try { await send(env, chatId, `❌ <b>RepoForge error</b>\n${escapeHtml(error.message)}`); } catch { /* do not reject a background task */ }
    }
  };

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(processUpdate());
    return new Response("ok");
  }
  await processUpdate();
  return new Response("ok");
}
