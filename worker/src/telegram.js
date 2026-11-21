import {
  createBackup, createJobFromZip, deployJob, getRepository, listBackups,
  listBranches, listCommits, listRepositories, loadJob, refreshJob,
  restoreBackup, saveJob
} from "./github.js";
import { escapeHtml, listByPrefix, parseCommand, safeBranch, safeRepoName } from "./utils.js";

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
  catch { /* Telegram may expire the callback query; the main action is already handled. */ }
}

async function selection(env, userId) {
  const raw = await env.STATE.get(`tg-selection:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

async function latestJob(env) {
  const jobs = await listByPrefix(env.STATE, "job:", 100);
  return jobs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0] || null;
}

function actionLabel(action) {
  return action === "update" ? "UPDATE" : action === "delete" ? "DELETE" : "KEEP";
}

function nextAction(target, current) {
  if (target.source === "archive") return current === "update" ? "keep" : current === "keep" ? "delete" : "update";
  return current === "delete" ? "keep" : "delete";
}

async function renderFiles(env, chatId, job, page = 0, messageId = null) {
  const pageSize = 7;
  const pages = Math.max(1, Math.ceil(job.targets.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const start = safePage * pageSize;
  const slice = job.targets.slice(start, start + pageSize);
  const updateCount = Object.values(job.actions).filter((v) => v === "update").length;
  const deleteCount = Object.values(job.actions).filter((v) => v === "delete").length;
  const lines = [
    `<b>📂 File review · ${escapeHtml(job.id)}</b>`,
    `<code>${escapeHtml(job.repo)} · ${escapeHtml(job.branch)}</code>`,
    `Page ${safePage + 1}/${pages} · ${job.targets.length} paths`,
    `🟢 Update: <b>${updateCount}</b>  🗑 Delete: <b>${deleteCount}</b>  ⚪ Keep: <b>${job.targets.length - updateCount - deleteCount}</b>`,
    "",
    ...slice.map((target, offset) => {
      const action = job.actions[target.path] || target.action;
      const icon = action === "update" ? "🟢" : action === "delete" ? "🗑" : "⚪";
      const origin = target.source === "archive" ? "ZIP" : "REPO";
      return `${icon} <b>${start + offset + 1}.</b> <code>${escapeHtml(target.path)}</code>\n   <i>${origin} · ${actionLabel(action)} · ${target.size} bytes</i>`;
    })
  ];
  const keyboard = slice.map((target, offset) => [{
    text: `${target.source === "archive" ? "↻" : "🗑/↩"} ${start + offset + 1} · ${actionLabel(job.actions[target.path] || target.action)}`,
    callback_data: `file:${job.id}:${start + offset}`
  }]);
  const nav = [];
  if (safePage > 0) nav.push({ text: "‹ Previous", callback_data: `page:${job.id}:${safePage - 1}` });
  if (safePage < pages - 1) nav.push({ text: "Next ›", callback_data: `page:${job.id}:${safePage + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([
    { text: "🔄 Refresh preview", callback_data: `refresh:${job.id}` },
    { text: "🚀 Review deploy", callback_data: `deploy:${job.id}` }
  ]);
  keyboard.push([{ text: "✖ Cancel job", callback_data: `cancel:${job.id}` }]);
  const markup = { inline_keyboard: keyboard };
  const html = lines.join("\n");
  if (messageId) return edit(env, chatId, messageId, html, { reply_markup: markup });
  return send(env, chatId, html, { reply_markup: markup });
}

async function preview(env, chatId, jobId, messageId = null) {
  const job = jobId ? await loadJob(env, jobId) : await latestJob(env);
  if (!job) return send(env, chatId, "No deployment jobs yet. Send a ZIP file after selecting a repository.");
  const updateCount = Object.values(job.actions).filter((v) => v === "update").length;
  const deleteCount = Object.values(job.actions).filter((v) => v === "delete").length;
  const keepCount = job.targets.length - updateCount - deleteCount;
  const html = [
    `<b>🧩 Deployment preview · ${escapeHtml(job.id)}</b>`,
    `<code>${escapeHtml(job.repo)}</code> · <code>${escapeHtml(job.branch)}</code>`,
    `Status: <b>${escapeHtml(job.status)}</b>`,
    `Archive: <code>${escapeHtml(job.fileName)}</code>`,
    `ZIP files: <b>${job.archiveFiles.length}</b> · Repository paths: <b>${job.targets.length}</b>`,
    `🟢 Update <b>${updateCount}</b> · ⚪ Keep <b>${keepCount}</b> · 🗑 Delete <b>${deleteCount}</b>`,
    `Base commit: <code>${escapeHtml(job.baseSha.slice(0, 12))}</code>`,
    "",
    "Review individual files before deployment. No repository changes have been made yet."
  ].join("\n");
  const markup = { inline_keyboard: [
    [{ text: "📂 Review files", callback_data: `page:${job.id}:0` }, { text: "🚀 Deploy review", callback_data: `deploy:${job.id}` }],
    [{ text: "🔄 Refresh", callback_data: `refresh:${job.id}` }, { text: "✖ Cancel", callback_data: `cancel:${job.id}` }]
  ] };
  if (messageId) return edit(env, chatId, messageId, html, { reply_markup: markup });
  return send(env, chatId, html, { reply_markup: markup });
}

async function processDocument(env, message, chatId) {
  const document = message.document;
  const name = document?.file_name || "upload.zip";
  if (!name.toLowerCase().endsWith(".zip")) return send(env, chatId, "Please send a <b>.zip</b> archive. Other archive formats are not supported yet.");
  const maxBytes = Number(env.MAX_ARCHIVE_BYTES || 18 * 1024 * 1024);
  if (document.file_size && document.file_size > maxBytes) return send(env, chatId, `Archive is too large. Maximum configured size: ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  const selected = await selection(env, message.from.id);
  let repo = selected?.repo;
  let branch = selected?.branch;
  const caption = message.caption || "";
  const captionMatch = caption.match(/(?:^|\s)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\s+([^\s]+))?/);
  if (captionMatch) { repo = captionMatch[1]; branch = captionMatch[2] || branch; }
  if (!repo) return send(env, chatId, "Choose a target first with <code>/select owner/repository [branch]</code>, then resend the ZIP.");

  const meta = await telegramApi(env, "getFile", { file_id: document.file_id });
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${meta.file_path}`);
  if (!response.ok) throw new Error(`Unable to download Telegram document (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("Downloaded archive exceeds the configured upload limit.");
  const job = await createJobFromZip(env, { repo, branch, zipBytes: bytes, fileName: name, stripRoot: true, source: "telegram", actor: String(message.from.id) });
  await send(env, chatId, `✅ ZIP received and inspected. Created job <code>${escapeHtml(job.id)}</code>. Nothing has been pushed to GitHub yet.`);
  await preview(env, chatId, job.id);
}

async function help(env, chatId) {
  const rows = [
    "<b>RepoForge Manager · Commands</b>",
    "<code>/repos</code> — list allowed repositories",
    "<code>/select owner/repo [branch]</code> — choose target",
    "<code>/current</code> — show active target",
    "Send a ZIP archive — create a deployment preview",
    "<code>/preview [jobId]</code> — inspect latest or selected job",
    "<code>/files [jobId] [page]</code> — browse file actions",
    "<code>/keep jobId index</code> — keep a path unchanged",
    "<code>/update jobId index</code> — select ZIP file for update",
    "<code>/delete jobId index</code> — delete matching remote file",
    "<code>/sync [jobId]</code> — refresh remote branch snapshot",
    "<code>/deploy jobId</code> — request deployment confirmation",
    "<code>/backup</code> — snapshot active branch",
    "<code>/backups</code> — list available snapshots",
    "<code>/restore backupId</code> — request restore confirmation",
    "<code>/history</code> — recent commits on active branch",
    "<code>/cancel jobId</code> — cancel a pending job",
    "<code>/status</code> — service and GitHub status",
    "<code>/help</code> — show this guide",
    "",
    "All actions are restricted to the configured Telegram admin ID. Deploy and restore always require an explicit confirmation button."
  ];
  return send(env, chatId, rows.join("\n"));
}

async function runCommand(env, message, chatId, commandText) {
  const { command, args } = parseCommand(commandText);
  switch (command) {
    case "/start":
      return send(env, chatId, "<b>RepoForge is online.</b>\nYour Telegram account is authorized as the configured administrator.\nUse <code>/help</code> to see available commands.");
    case "/help":
      return help(env, chatId);
    case "/status": {
      const configured = Boolean(env.GITHUB_TOKEN && env.TELEGRAM_BOT_TOKEN && env.STATE && env.ARCHIVES);
      let github = "not checked";
      try { const repos = await listRepositories(env); github = `connected · ${repos.length} allowed repo(s)`; }
      catch (error) { github = `error · ${escapeHtml(error.message)}`; }
      const selected = await selection(env, message.from.id);
      return send(env, chatId, `<b>System status</b>\nWorker: <b>online</b>\nConfiguration: <b>${configured ? "ready" : "incomplete"}</b>\nGitHub: ${github}\nActive target: ${selected ? `<code>${escapeHtml(selected.repo)}@${escapeHtml(selected.branch)}</code>` : "not selected"}`);
    }
    case "/repos": {
      const repos = await listRepositories(env);
      if (!repos.length) return send(env, chatId, "No allowed repositories were returned. Check ALLOWED_REPOS and token access.");
      const lines = repos.slice(0, 25).map((repo, index) => `${index + 1}. <code>${escapeHtml(repo.fullName)}</code> ${repo.private ? "🔒" : "🌐"}\n   default: <code>${escapeHtml(repo.defaultBranch)}</code>`);
      return send(env, chatId, `<b>Allowed repositories (${repos.length})</b>\n\n${lines.join("\n")}`);
    }
    case "/select": {
      if (!args[0]) return send(env, chatId, "Usage: <code>/select owner/repository [branch]</code>");
      const repo = safeRepoName(args[0]);
      const info = await getRepository(env, repo);
      const branch = safeBranch(args[1] || info.defaultBranch);
      const branches = await listBranches(env, repo);
      if (!branches.some((item) => item.name === branch)) return send(env, chatId, `Branch <code>${escapeHtml(branch)}</code> was not found in <code>${escapeHtml(repo)}</code>.`);
      const selected = { repo, branch, selectedAt: new Date().toISOString() };
      await env.STATE.put(`tg-selection:${message.from.id}`, JSON.stringify(selected));
      return send(env, chatId, `✅ Active target set to\n<code>${escapeHtml(repo)}@${escapeHtml(branch)}</code>`);
    }
    case "/current": {
      const selected = await selection(env, message.from.id);
      return send(env, chatId, selected ? `Active target: <code>${escapeHtml(selected.repo)}@${escapeHtml(selected.branch)}</code>` : "No target selected. Use <code>/select owner/repo [branch]</code>.");
    }
    case "/upload":
      return send(env, chatId, "Select a repository using <code>/select owner/repo [branch]</code>, then send the ZIP file as a document. You can add <code>owner/repo branch</code> in the ZIP caption to override the active target.");
    case "/preview":
      return preview(env, chatId, args[0]);
    case "/files": {
      const job = args[0] ? await loadJob(env, args[0]) : await latestJob(env);
      if (!job) return send(env, chatId, "No deployment job found.");
      return renderFiles(env, chatId, job, Math.max(0, Number(args[1] || 1) - 1));
    }
    case "/keep":
    case "/update":
    case "/delete": {
      if (!args[0] || !/^\d+$/.test(args[1] || "")) return send(env, chatId, `Usage: <code>${command} jobId fileIndex</code>. Index is shown by /files.`);
      const job = await loadJob(env, args[0]);
      const index = Number(args[1]) - 1;
      const target = job.targets[index];
      if (!target) return send(env, chatId, "File index is out of range.");
      if (command === "/update" && target.source !== "archive") return send(env, chatId, "This path exists only in the repository and has no ZIP content to upload.");
      job.actions[target.path] = command.slice(1);
      await saveJob(env, job);
      return send(env, chatId, `Updated <code>${escapeHtml(target.path)}</code> → <b>${actionLabel(job.actions[target.path])}</b>.`);
    }
    case "/sync": {
      const job = await loadJob(env, args[0] || (await latestJob(env))?.id);
      if (!job) return send(env, chatId, "No deployment job found.");
      const refreshed = await refreshJob(env, job);
      return preview(env, chatId, refreshed.id);
    }
    case "/deploy": {
      const jobId = args[0] || (await latestJob(env))?.id;
      if (!jobId) return send(env, chatId, "No pending deployment job found.");
      const job = await loadJob(env, jobId);
      return send(env, chatId, `Confirm deployment of <code>${escapeHtml(job.id)}</code> to <code>${escapeHtml(job.repo)}@${escapeHtml(job.branch)}</code>?\nSelected updates/deletions will be committed together. A backup ref is created first.`, { reply_markup: { inline_keyboard: [[{ text: "✅ Confirm deploy", callback_data: `confirmdeploy:${job.id}` }, { text: "Cancel", callback_data: `page:${job.id}:0` }]] } });
    }
    case "/backup": {
      const selected = await selection(env, message.from.id);
      if (!selected) return send(env, chatId, "Select a repository first with <code>/select owner/repo [branch]</code>.");
      const backup = await createBackup(env, selected.repo, selected.branch, "manual-telegram");
      return send(env, chatId, `✅ Backup created.\nRepo: <code>${escapeHtml(backup.repo)}</code>\nBranch: <code>${escapeHtml(backup.branch)}</code>\nBackup ID: <code>${escapeHtml(backup.id)}</code>\nCommit: <code>${backup.sha.slice(0, 12)}</code>`);
    }
    case "/backups": {
      const selected = await selection(env, message.from.id);
      const backups = await listBackups(env, selected?.repo || "");
      if (!backups.length) return send(env, chatId, "No backups have been recorded yet.");
      const rows = backups.slice(0, 20).map((backup) => `<code>${escapeHtml(backup.id)}</code> · <code>${escapeHtml(backup.repo)}@${escapeHtml(backup.branch)}</code>\n${escapeHtml(backup.createdAt)} · ${escapeHtml(backup.reason)}`);
      return send(env, chatId, `<b>Recent backups</b>\n\n${rows.join("\n\n")}`);
    }
    case "/restore": {
      if (!args[0]) return send(env, chatId, "Usage: <code>/restore backupId</code>");
      const backups = await listBackups(env);
      const backup = backups.find((item) => item.id === args[0]);
      if (!backup) return send(env, chatId, "Backup ID was not found.");
      return send(env, chatId, `⚠️ Restore <code>${escapeHtml(backup.id)}</code> to <code>${escapeHtml(backup.repo)}@${escapeHtml(backup.branch)}</code>? The current branch will also be backed up first.`, { reply_markup: { inline_keyboard: [[{ text: "⚠️ Confirm restore", callback_data: `confirmrestore:${backup.id}` }, { text: "Cancel", callback_data: "noop" }]] } });
    }
    case "/history": {
      const selected = await selection(env, message.from.id);
      if (!selected) return send(env, chatId, "Select a repository first.");
      const commits = await listCommits(env, selected.repo, selected.branch, 12);
      if (!commits.length) return send(env, chatId, "No commits found.");
      const lines = commits.map((item) => `• <b>${escapeHtml(item.message)}</b>\n  <code>${item.sha.slice(0, 10)}</code> · ${escapeHtml(item.date || "unknown date")} · ${escapeHtml(item.author || "unknown")}`);
      return send(env, chatId, `<b>Recent commits</b>\n\n${lines.join("\n\n")}`);
    }
    case "/cancel": {
      if (!args[0]) return send(env, chatId, "Usage: <code>/cancel jobId</code>");
      const job = await loadJob(env, args[0]);
      if (job.status !== "pending" && job.status !== "stale") return send(env, chatId, `Cannot cancel a job with status <b>${escapeHtml(job.status)}</b>.`);
      job.status = "cancelled";
      job.cancelledAt = new Date().toISOString();
      await saveJob(env, job);
      return send(env, chatId, `Job <code>${escapeHtml(job.id)}</code> cancelled. No GitHub changes were made.`);
    }
    default:
      return send(env, chatId, "Unknown command. Use <code>/help</code> for available commands.");
  }
}

async function handleCallback(env, callback) {
  const queryId = callback.id;
  const userId = callback.from?.id;
  const message = callback.message;
  if (!adminAllowed(env, userId) || message?.chat?.type !== "private" || String(message.chat.id) !== String(env.TELEGRAM_ADMIN_ID)) {
    await answerCallback(env, queryId, "Unauthorized", true);
    return;
  }
  const data = callback.data || "";
  const [action, id, indexRaw] = data.split(":");
  try {
    if (action === "noop") { await answerCallback(env, queryId); return; }
    if (action === "file") {
      const job = await loadJob(env, id);
      const index = Number(indexRaw);
      const target = job.targets[index];
      if (!target) throw new Error("File entry no longer exists.");
      job.actions[target.path] = nextAction(target, job.actions[target.path] || target.action);
      await saveJob(env, job);
      await answerCallback(env, queryId, `${target.path}: ${actionLabel(job.actions[target.path])}`);
      await renderFiles(env, message.chat.id, job, Math.floor(index / 7), message.message_id);
      return;
    }
    if (action === "page") {
      const job = await loadJob(env, id);
      await answerCallback(env, queryId);
      await renderFiles(env, message.chat.id, job, Number(indexRaw || 0), message.message_id);
      return;
    }
    if (action === "refresh") {
      const job = await loadJob(env, id);
      await refreshJob(env, job);
      await answerCallback(env, queryId, "Preview refreshed.");
      await preview(env, message.chat.id, id, message.message_id);
      return;
    }
    if (action === "deploy") {
      await answerCallback(env, queryId);
      const job = await loadJob(env, id);
      await edit(env, message.chat.id, message.message_id, `Confirm deployment of <code>${escapeHtml(job.id)}</code> to <code>${escapeHtml(job.repo)}@${escapeHtml(job.branch)}</code>? A backup is created automatically before the commit.`, { reply_markup: { inline_keyboard: [[{ text: "✅ Confirm deploy", callback_data: `confirmdeploy:${job.id}` }, { text: "Back to files", callback_data: `page:${job.id}:0` }]] } });
      return;
    }
    if (action === "confirmdeploy") {
      await answerCallback(env, queryId, "Deployment started.");
      await edit(env, message.chat.id, message.message_id, `⏳ Deploying job <code>${escapeHtml(id)}</code>…`);
      const result = await deployJob(env, id, String(userId));
      await send(env, message.chat.id, `✅ <b>Deployment complete</b>\nRepo: <code>${escapeHtml(result.job.repo)}</code>\nBranch: <code>${escapeHtml(result.job.branch)}</code>\nUpdated: <b>${result.updated}</b> · Deleted: <b>${result.deleted}</b>\nBackup: <code>${escapeHtml(result.backup.id)}</code>\nCommit: <a href="${escapeHtml(result.commit.url)}">${result.commit.sha.slice(0, 12)}</a>`);
      return;
    }
    if (action === "cancel") {
      const job = await loadJob(env, id);
      if (job.status === "pending" || job.status === "stale") {
        job.status = "cancelled";
        job.cancelledAt = new Date().toISOString();
        await saveJob(env, job);
      }
      await answerCallback(env, queryId, "Job cancelled.");
      await edit(env, message.chat.id, message.message_id, `Job <code>${escapeHtml(id)}</code> is <b>${escapeHtml(job.status)}</b>.`);
      return;
    }
    if (action === "confirmrestore") {
      await answerCallback(env, queryId, "Restoring backup.");
      await edit(env, message.chat.id, message.message_id, `⏳ Restoring backup <code>${escapeHtml(id)}</code>…`);
      const result = await restoreBackup(env, id, String(userId));
      await send(env, message.chat.id, `✅ <b>Restore complete</b>\nRepo: <code>${escapeHtml(result.backup.repo)}</code>\nBranch: <code>${escapeHtml(result.backup.branch)}</code>\nPre-restore backup: <code>${escapeHtml(result.beforeRestore.id)}</code>\nCommit: <a href="${escapeHtml(result.commit.url)}">${result.commit.sha.slice(0, 12)}</a>`);
      return;
    }
    await answerCallback(env, queryId, "Unknown action.", true);
  } catch (error) {
    await answerCallback(env, queryId, "Action failed.", true);
    await send(env, message?.chat?.id || env.TELEGRAM_ADMIN_ID, `❌ ${escapeHtml(error.message)}`);
  }
}

export async function handleTelegramWebhook(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !/^\d+$/.test(String(env.TELEGRAM_ADMIN_ID || "")) || String(env.TELEGRAM_WEBHOOK_SECRET || "").length < 24) {
    return new Response("Telegram is not configured safely. Set a numeric admin ID and a webhook secret of at least 24 characters.", { status: 503 });
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

  try {
    if (update.callback_query) {
      await handleCallback(env, update.callback_query);
      return new Response("ok");
    }
    const message = update.message;
    if (!message) return new Response("ok");
    if (!isPrivateAdminChat(env, message)) {
      if (message.chat?.type === "private" && message.from?.id) {
        try { await send(env, message.chat.id, "⛔ This bot is private and restricted to its configured administrator."); } catch { /* ignore */ }
      }
      return new Response("ok");
    }
    if (message.document) {
      await processDocument(env, message, message.chat.id);
      return new Response("ok");
    }
    if (message.text?.startsWith("/")) await runCommand(env, message, message.chat.id, message.text);
    else await send(env, message.chat.id, "Send a ZIP archive or use <code>/help</code>.");
  } catch (error) {
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id || env.TELEGRAM_ADMIN_ID;
    try { await send(env, chatId, `❌ <b>RepoForge error</b>\n${escapeHtml(error.message)}`); } catch { /* webhook must still return */ }
  }
  return new Response("ok");
}
