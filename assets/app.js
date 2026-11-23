(() => {
  'use strict';

  const CONFIG = window.REPOFORGE_CONFIG || {};
  const API_BASE = String(CONFIG.apiBase || '').replace(/\/$/, '');
  const TOKEN_KEY = 'repoforge.dashboard.session';
  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || '',
    repositories: [],
    jobs: [],
    backups: [],
    events: [],
    activeJob: null,
    dirtyActions: {},
    currentView: 'overview',
    fileFilter: '',
    pendingStage: new URLSearchParams(location.search).get('stage') || '',
    pendingJob: new URLSearchParams(location.search).get('job') || '',
    pendingJobOpened: false,
    stageProcessing: false
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function formatBytes(bytes = 0) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatDate(value) {
    if (!value) return 'Unknown date';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function shortSha(value = '') { return String(value).slice(0, 12); }

  async function api(path, options = {}) {
    if (!API_BASE || API_BASE.includes('SET-WORKER')) throw new Error('Set the Worker URL in config.js before using the dashboard.');
    const headers = new Headers(options.headers || {});
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers, mode: 'cors', cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && state.token) lockDashboard(false);
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  }

  async function apiBinary(path) {
    if (!API_BASE || API_BASE.includes('SET-WORKER')) throw new Error('Worker URL is not configured in config.js.');
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'GET', mode: 'cors', cache: 'no-store',
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) lockDashboard(false);
      throw new Error(data.error || `Download failed (${response.status}).`);
    }
    return response.blob();
  }

  function toast(message, type = 'success') {
    const node = document.createElement('div');
    node.className = `toast ${type === 'error' ? 'error' : ''}`;
    node.textContent = message;
    $('#toastRegion').append(node);
    setTimeout(() => node.remove(), 4200);
  }

  function setMessage(selector, message, type = '') {
    const node = $(selector);
    if (!node) return;
    node.textContent = message || '';
    node.className = `inline-message ${type}`.trim();
  }

  function showApp() {
    $('#loginScreen').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
  }

  function lockDashboard(showToast = true) {
    const previousToken = state.token;
    if (previousToken && API_BASE && !API_BASE.includes('SET-WORKER')) {
      fetch(`${API_BASE}/api/logout`, { method: 'POST', mode: 'cors', headers: { Authorization: `Bearer ${previousToken}` } }).catch(() => {});
    }
    state.token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    $('#appShell').classList.add('hidden');
    $('#loginScreen').classList.remove('hidden');
    $('#passwordInput').value = '';
    $('#loginError').textContent = '';
    if (showToast) toast('Dashboard session locked.', 'success');
  }

  async function login(event) {
    event.preventDefault();
    $('#loginError').textContent = '';
    const button = $('#loginForm button[type="submit"]');
    button.disabled = true;
    button.querySelector('span').textContent = 'Authenticating…';
    try {
      if (!API_BASE || API_BASE.includes('SET-WORKER')) throw new Error('Worker URL is not configured in config.js.');
      const response = await fetch(`${API_BASE}/api/login`, {
        method: 'POST', mode: 'cors', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#passwordInput').value })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to authenticate.');
      state.token = data.token;
      sessionStorage.setItem(TOKEN_KEY, state.token);
      showApp();
      await loadDashboard();
    } catch (error) {
      $('#loginError').textContent = error.message;
    } finally {
      button.disabled = false;
      button.querySelector('span').textContent = 'Unlock control plane';
    }
  }

  async function restoreSession() {
    if (!state.token) return;
    try {
      await api('/api/session');
      showApp();
      await loadDashboard();
    } catch {
      lockDashboard(false);
    }
  }

  async function loadDashboard() {
    try {
      const [status, repos, jobs, backups, audit] = await Promise.all([
        api('/api/status'), api('/api/repos'), api('/api/jobs'), api('/api/backups'), api('/api/audit')
      ]);
      state.repositories = repos.repositories || [];
      state.jobs = jobs.jobs || [];
      state.backups = backups.backups || [];
      state.events = audit.events || [];
      renderStatus(status);
      renderRepositoryOptions();
      renderJobs();
      renderBackups();
      renderActivity();
      const preferred = $('#repoSelect').value || state.repositories[0]?.fullName || '';
      if (preferred) {
        $('#repoSelect').value = preferred;
        await loadBranches(preferred);
      }
      if (state.pendingStage && !state.stageProcessing) await processTelegramStage();
      if (state.pendingJob && !state.pendingJobOpened && !state.pendingStage) {
        state.pendingJobOpened = true;
        history.replaceState(null, '', `${location.pathname}${location.hash}`);
        await openJob(state.pendingJob);
      }
    } catch (error) {
      toast(error.message, 'error');
      $('#workerState').textContent = 'ERROR';
      $('#workerCaption').textContent = 'API connection failed';
      $('#heroSystemState').textContent = 'CONNECTION ERROR';
    }
  }

  function renderStatus(status) {
    $('#workerState').textContent = 'ONLINE';
    $('#workerCaption').textContent = 'Secure API connection established';
    $('#heroSystemState').textContent = 'OPERATIONAL';
    $('#statRepos').textContent = status.allowedRepositories ?? 0;
    $('#statPending').textContent = state.jobs.filter((job) => ['pending', 'stale', 'uploading', 'deploying'].includes(job.status)).length;
    $('#statBackups').textContent = state.backups.length;
    $('#statLimit').textContent = status.limits?.changedFiles ?? '—';
    $('#uploadLimit').textContent = `${Math.round((status.limits?.archiveBytes || 19 * 1024 * 1024) / 1024 / 1024)} MB`;
  }

  function renderRepositoryOptions() {
    const select = $('#repoSelect');
    const backupSelect = $('#backupRepoFilter');
    const previous = select.value;
    select.innerHTML = state.repositories.length
      ? state.repositories.map((repo) => `<option value="${escapeHtml(repo.fullName)}">${escapeHtml(repo.fullName)}${repo.private ? ' · PRIVATE' : ''}</option>`).join('')
      : '<option value="">No allowed repositories</option>';
    if (state.repositories.some((repo) => repo.fullName === previous)) select.value = previous;
    backupSelect.innerHTML = '<option value="">All allowed repositories</option>' + state.repositories.map((repo) => `<option value="${escapeHtml(repo.fullName)}">${escapeHtml(repo.fullName)}</option>`).join('');
  }

  async function loadBranches(repo) {
    const select = $('#branchSelect');
    select.disabled = true;
    select.innerHTML = '<option value="">Loading branches…</option>';
    if (!repo) return;
    try {
      const data = await api(`/api/branches?repo=${encodeURIComponent(repo)}`);
      const branches = data.branches || [];
      select.innerHTML = branches.length ? branches.map((branch) => `<option value="${escapeHtml(branch.name)}">${escapeHtml(branch.name)}${branch.protected ? ' · PROTECTED' : ''}</option>`).join('') : '<option value="">No branches</option>';
      const target = state.repositories.find((item) => item.fullName === repo)?.defaultBranch;
      if (target && branches.some((item) => item.name === target)) select.value = target;
    } catch (error) {
      select.innerHTML = '<option value="">Unable to load branches</option>';
      toast(error.message, 'error');
    } finally {
      select.disabled = false;
    }
  }

  function statusClass(status) {
    if (['uploading', 'deploying'].includes(status)) return 'pending';
    return ['pending', 'deployed', 'stale', 'cancelled'].includes(status) ? status : 'cancelled';
  }

  function jobRow(job) {
    const changed = job.changeCount != null ? `${job.changeCount} changed` : `${job.archiveFileCount ?? job.archiveFiles?.length ?? 0} ZIP files`;
    return `<article class="job-row">
      <div class="job-main"><div class="job-file-icon">⇧</div><div><strong>${escapeHtml(job.fileName || `Release ${job.id}`)}</strong><small>${escapeHtml(job.repo)} · ${escapeHtml(job.branch)} · #${escapeHtml(job.id)}</small></div></div>
      <div class="job-meta"><b>${escapeHtml(changed)}</b><small>${escapeHtml(formatDate(job.deployedAt || job.createdAt))}</small></div>
      <span class="status-pill ${statusClass(job.status)}">${escapeHtml(job.status)}</span>
      <button class="job-open" data-open-job="${escapeHtml(job.id)}" aria-label="Inspect deployment">↗</button>
    </article>`;
  }

  function emptyState(title, description, icon = '⌁') {
    return `<div class="empty-state"><span class="empty-symbol">${icon}</span><b>${escapeHtml(title)}</b><p>${escapeHtml(description)}</p></div>`;
  }

  function renderJobs() {
    const jobs = [...state.jobs].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    $('#recentJobs').innerHTML = jobs.length ? jobs.slice(0, 6).map(jobRow).join('') : emptyState('No releases yet', 'Your deployment jobs will appear here after the first ZIP inspection.');
    const filter = $('#jobFilter').value;
    const filtered = filter === 'all' ? jobs : jobs.filter((job) => job.status === filter);
    $('#allJobs').innerHTML = filtered.length ? filtered.map(jobRow).join('') : emptyState('Nothing in this queue', 'There are no deployments matching this status filter.');
    $('#jobCount').textContent = jobs.length;
    const pending = jobs.filter((job) => ['pending', 'stale', 'uploading', 'deploying'].includes(job.status)).length;
    $('#pendingNav').textContent = pending;
    $('#statPending').textContent = pending;
  }

  function renderBackups() {
    const repoFilter = $('#backupRepoFilter').value;
    const list = repoFilter ? state.backups.filter((backup) => backup.repo === repoFilter) : state.backups;
    $('#backupCount').textContent = list.length;
    $('#backupList').innerHTML = list.length ? list.map((backup) => `<article class="backup-card glass-panel">
      <div class="backup-card-top"><h3>${escapeHtml(backup.repo)}</h3><span class="backup-id">${escapeHtml(backup.id)}</span></div>
      <div class="backup-info"><span>◈ ${escapeHtml(backup.branch)}</span><span>◷ ${escapeHtml(formatDate(backup.createdAt))}</span></div>
      <div class="backup-sha">${escapeHtml(shortSha(backup.sha))} · ${escapeHtml(backup.reason || 'snapshot')}</div>
      <div class="backup-actions"><small>${escapeHtml(backup.backupBranch || 'Git backup ref')}</small><button class="button button-secondary" data-restore-backup="${escapeHtml(backup.id)}">Restore snapshot ↗</button></div>
    </article>`).join('') : `<div class="empty-state glass-panel backup-empty">${emptyState('No backups available', 'Backups will appear after you create one or deploy a release.', '◫')}</div>`;
    $('#statBackups').textContent = state.backups.length;
  }

  const activityLabels = {
    upload: ['ZIP inspected', '⇧'], deploy: ['Release deployed', '✓'], backup: ['Backup created', '◫'],
    restore: ['Snapshot restored', '↶'], cancel: ['Deployment cancelled', '×']
  };

  function renderActivity() {
    $('#activityList').innerHTML = state.events.length ? state.events.map((event) => {
      const [label, icon] = activityLabels[event.type] || ['System event', '·'];
      const details = [event.repo, event.branch, event.jobId ? `job ${event.jobId}` : '', event.backupId ? `backup ${event.backupId}` : '', event.changed != null ? `${event.changed} file changes` : ''].filter(Boolean).join(' · ');
      return `<article class="timeline-item"><span class="timeline-icon">${icon}</span><div><b>${escapeHtml(label)}</b><p>${escapeHtml(details || event.type || 'Event recorded')}</p></div><time>${escapeHtml(formatDate(event.at))}</time></article>`;
    }).join('') : emptyState('No recorded events', 'Actions performed through RepoForge will be logged here.', '◷');
  }

  async function refreshJobsAndStatus() {
    const [jobs, status, audit] = await Promise.all([api('/api/jobs'), api('/api/status'), api('/api/audit')]);
    state.jobs = jobs.jobs || [];
    state.events = audit.events || [];
    renderJobs(); renderActivity(); renderStatus(status);
  }

  async function refreshAllBackups() {
    const data = await api('/api/backups');
    state.backups = data.backups || [];
    renderBackups();
  }

  async function uploadPreparedArchive(file, repo, branch, source = 'dashboard', stageId = '') {
    if (!window.RepoForgeZip?.extract) throw new Error('Local ZIP engine did not load. Refresh the page and try again.');
    const stripRoot = $('#stripRoot')?.checked !== false;
    setMessage('#uploadMessage', 'Reading ZIP structure and validating paths in your browser…');
    const extracted = await window.RepoForgeZip.extract(file, {
      limits: CONFIG.limits || {},
      stripRoot
    }, (progress) => {
      setMessage('#uploadMessage', `Extracting in browser: ${progress.current}/${progress.total} · ${progress.path}`);
    });

    const files = extracted.files;
    if (!files.length) throw new Error('The archive contains no deployable files.');
    const manifest = files.map((item) => ({ path: item.path, size: item.size }));
    setMessage('#uploadMessage', `Comparing ${files.length} files with ${repo}@${branch}…`);
    const prepared = await api('/api/jobs/prepare', {
      method: 'POST',
      body: JSON.stringify({
        repo, branch, fileName: file.name || extracted.fileName,
        archiveBytes: file.size, files: manifest, source
      })
    });
    const jobId = prepared.job.id;
    let completed = 0;
    let nextIndex = 0;
    let uploadError = null;
    const concurrency = Math.min(3, files.length);

    async function uploadWorker() {
      while (nextIndex < files.length && !uploadError) {
        const index = nextIndex++;
        const item = files[index];
        try {
          await api(`/api/jobs/${encodeURIComponent(jobId)}/files/${index}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: item.base64
          });
          completed++;
          setMessage('#uploadMessage', `Secure payload upload: ${completed}/${files.length} · ${item.path}`);
        } catch (error) {
          uploadError = error;
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => uploadWorker()));
    if (uploadError) {
      try { await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: '{}' }); } catch { /* keep the original error */ }
      throw new Error(`Upload stopped at ${completed}/${files.length}. ${uploadError.message}`);
    }

    const completedJob = await api(`/api/jobs/${encodeURIComponent(jobId)}/complete`, { method: 'POST', body: '{}' });
    if (stageId) {
      try { await api(`/api/stages/${encodeURIComponent(stageId)}`, { method: 'DELETE' }); } catch { /* stage expires automatically */ }
    }
    return completedJob.job;
  }

  async function handleUpload() {
    const file = $('#zipInput').files[0];
    const repo = $('#repoSelect').value;
    const branch = $('#branchSelect').value;
    if (!file) return setMessage('#uploadMessage', 'Choose a ZIP archive first.', 'error');
    if (!repo || !branch) return setMessage('#uploadMessage', 'Choose a repository and branch first.', 'error');
    if (!file.name.toLowerCase().endsWith('.zip')) return setMessage('#uploadMessage', 'Only .zip files are accepted.', 'error');
    const button = $('#uploadButton');
    button.disabled = true;
    $('#uploadProgress').classList.remove('hidden');
    setMessage('#uploadMessage', 'Preparing browser-side ZIP inspection…');
    try {
      const job = await uploadPreparedArchive(file, repo, branch, 'dashboard');
      $('#zipInput').value = '';
      $('#dropTitle').textContent = 'Drop your release ZIP here';
      $('#dropSubtitle').innerHTML = 'or <u>browse files</u> · ZIP archive only';
      setMessage('#uploadMessage', `ZIP inspected. Job ${job.id} is ready for file-by-file review.`, 'success');
      toast(`Release preview created · ${job.id}`);
      await refreshJobsAndStatus();
      await openJob(job.id);
    } catch (error) {
      setMessage('#uploadMessage', error.message, 'error');
      toast(error.message, 'error');
    } finally {
      button.disabled = !$('#zipInput').files.length;
      $('#uploadProgress').classList.add('hidden');
    }
  }

  async function processTelegramStage() {
    if (!state.pendingStage || state.stageProcessing) return;
    state.stageProcessing = true;
    try {
      setView('overview');
      setMessage('#uploadMessage', 'Telegram ZIP detected. Loading its temporary archive…');
      const stageInfo = await api(`/api/stages/${encodeURIComponent(state.pendingStage)}`);
      const blob = await apiBinary(`/api/stages/${encodeURIComponent(state.pendingStage)}/archive`);
      const file = new File([blob], stageInfo.stage.fileName || 'telegram-release.zip', { type: 'application/zip' });
      const job = await uploadPreparedArchive(file, stageInfo.stage.repo, stageInfo.stage.branch, 'telegram', state.pendingStage);
      toast(`Telegram release staged · ${job.id}`);
      state.pendingStage = '';
      history.replaceState(null, '', `${location.pathname}${location.hash}`);
      await refreshJobsAndStatus();
      await openJob(job.id);
    } catch (error) {
      setMessage('#uploadMessage', `Telegram ZIP could not be prepared: ${error.message}`, 'error');
      toast(error.message, 'error');
    } finally {
      state.stageProcessing = false;
    }
  }

  function setView(view) {
    state.currentView = view;
    $$('.view').forEach((node) => node.classList.toggle('active-view', node.id === `view-${view}`));
    $$('.nav-link').forEach((node) => node.classList.toggle('active', node.dataset.view === view));
    const labels = { overview: 'Overview', deployments: 'Deployments', backups: 'Backups', activity: 'Activity' };
    $('#breadcrumbTitle').textContent = labels[view] || 'Overview';
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  }

  function countActions(job) {
    const targets = job.targets || [];
    const update = targets.filter((target) => target.source === 'archive' && (job.actions?.[target.path] || target.action) === 'update').length;
    const remove = targets.filter((target) => target.exists && (job.actions?.[target.path] || target.action) === 'delete').length;
    const keep = targets.length - update - remove;
    return { update, remove, keep, total: update + remove };
  }

  async function openJob(id) {
    try {
      const data = await api(`/api/jobs/${encodeURIComponent(id)}`);
      state.activeJob = data.job;
      state.dirtyActions = {};
      state.fileFilter = '';
      $('#fileSearch').value = '';
      renderActiveJob();
      $('#jobModal').classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    } catch (error) { toast(error.message, 'error'); }
  }

  function renderActiveJob() {
    const job = state.activeJob;
    if (!job) return;
    const counts = countActions(job);
    $('#modalTitle').textContent = job.fileName || `Release ${job.id}`;
    $('#modalSubtitle').textContent = `${job.repo} · ${job.branch} · job ${job.id}`;
    $('#modalMeta').innerHTML = [
      `STATUS ${job.status.toUpperCase()}`, `BASE ${shortSha(job.baseSha)}`, `${job.archiveFiles.length} ZIP FILES`, `${job.targets.length} TOTAL PATHS`
    ].map((value) => `<span class="meta-chip">${escapeHtml(value)}</span>`).join('');
    $('#reviewSummary').innerHTML = `
      <div class="review-count update"><small>UPDATE / ADD</small><b>${counts.update}</b></div>
      <div class="review-count keep"><small>KEEP UNCHANGED</small><b>${counts.keep}</b></div>
      <div class="review-count delete"><small>DELETE REMOTE</small><b>${counts.remove}</b></div>
      <div class="review-count"><small>SELECTED CHANGES</small><b>${counts.total}</b></div>`;
    const max = Number($('#statLimit').textContent) || 25;
    $('#changeSummary').textContent = `${counts.total} of ${max} file changes selected`;
    $('#modalLimitNote').textContent = counts.total > max ? `Limit exceeded. Split this release or increase server MAX_CHANGED_FILES after reviewing plan limits.` : 'A backup branch is created before the commit.';
    const canDeploy = ['pending', 'deploying'].includes(job.status) && counts.total > 0 && counts.total <= max;
    $('#deployJob').disabled = !canDeploy;
    $('#deployJob').textContent = job.status === 'deploying' ? 'Resume deployment ↗' : 'Deploy release ↗';
    $('#saveActions').disabled = !['pending', 'stale'].includes(job.status);
    $('#refreshJob').disabled = !['pending', 'stale'].includes(job.status);
    renderFileRows();
  }

  function renderFileRows() {
    const job = state.activeJob;
    const filter = state.fileFilter.toLowerCase().trim();
    const rows = (job?.targets || []).filter((target) => !filter || target.path.toLowerCase().includes(filter));
    if (!rows.length) {
      $('#fileList').innerHTML = '<div class="file-empty">No paths match your filter.</div>';
      return;
    }
    $('#fileList').innerHTML = rows.map((target) => {
      const action = job.actions[target.path] || target.action;
      const source = target.source === 'archive';
      return `<div class="file-row">
        <div class="file-path-wrap"><span class="file-kind ${source ? 'zip' : ''}">${source ? 'ZIP' : 'GH'}</span><span class="file-path" title="${escapeHtml(target.path)}">${escapeHtml(target.path)}</span></div>
        <span class="file-size">${formatBytes(target.size || 0)}</span>
        <select class="action-select action-${action}" data-file-action="${escapeHtml(target.path)}" aria-label="Action for ${escapeHtml(target.path)}">
          ${source ? `<option value="update" ${action === 'update' ? 'selected' : ''}>UPDATE / ADD</option>` : ''}
          <option value="keep" ${action === 'keep' ? 'selected' : ''}>KEEP</option>
          ${(!source || target.exists) ? `<option value="delete" ${action === 'delete' ? 'selected' : ''}>DELETE</option>` : ''}
        </select>
      </div>`;
    }).join('');
  }

  async function saveJobActions() {
    const job = state.activeJob;
    if (!job) return;
    const button = $('#saveActions');
    button.disabled = true;
    try {
      const changes = { ...state.dirtyActions };
      if (!Object.keys(changes).length) return true;
      const data = await api(`/api/jobs/${encodeURIComponent(job.id)}/actions`, { method: 'PATCH', body: JSON.stringify({ actions: changes }) });
      state.activeJob = data.job;
      state.dirtyActions = {};
      renderActiveJob();
      setMessage('#modalMessage', 'File decisions saved.', 'success');
      toast('File-level choices saved.');
      return true;
    } catch (error) {
      setMessage('#modalMessage', error.message, 'error');
      toast(error.message, 'error');
      return false;
    } finally { button.disabled = false; }
  }

  async function refreshActiveJob() {
    const job = state.activeJob;
    if (!job) return;
    $('#refreshJob').disabled = true;
    setMessage('#modalMessage', 'Refreshing repository snapshot…');
    try {
      const data = await api(`/api/jobs/${encodeURIComponent(job.id)}/refresh`, { method: 'POST', body: '{}' });
      state.activeJob = data.job;
      state.dirtyActions = {};
      renderActiveJob();
      setMessage('#modalMessage', 'Repository state refreshed. Review any changed paths before deploying.', 'success');
      await refreshJobsAndStatus();
    } catch (error) { setMessage('#modalMessage', error.message, 'error'); }
    finally { $('#refreshJob').disabled = false; }
  }

  async function deployActiveJob() {
    if (!state.activeJob) return;
    let job = state.activeJob;
    const counts = countActions(job);
    if (!counts.total) return toast('No file changes are selected.', 'error');
    if (!['pending', 'deploying'].includes(job.status)) return toast(`This job is ${job.status} and cannot be deployed.`, 'error');
    const isResume = job.status === 'deploying';
    const confirmed = window.confirm(isResume
      ? `Resume deployment ${job.id}? The pre-deployment backup already exists. Missing Git blobs will be uploaded and then one commit will be published.`
      : `Deploy ${counts.total} file change(s) to ${job.repo}@${job.branch}?\n\nRepoForge creates a backup first, uploads each file in a separate request for Cloudflare Free compatibility, then publishes one commit.`);
    if (!confirmed) return;
    $('#deployJob').disabled = true;
    try {
      if (!isResume) {
        setMessage('#modalMessage', 'Creating pre-deployment backup and opening a deployment session…');
        const saved = await saveJobActions();
        if (!saved) return;
        const started = await api(`/api/jobs/${encodeURIComponent(job.id)}/deploy/start`, { method: 'POST', body: '{}' });
        state.activeJob = started.job;
        job = state.activeJob;
        renderActiveJob();
      }

      const indexes = job.deployment?.updateIndexes || [];
      const blobs = job.deployment?.blobShas || {};
      let done = Object.keys(blobs).length;
      for (const index of indexes) {
        if (job.deployment.blobShas?.[String(index)]) continue;
        const file = job.archiveFiles[index];
        setMessage('#modalMessage', `Uploading Git Blob ${done + 1}/${indexes.length}: ${file?.path || `file ${index + 1}`}…`);
        const result = await api(`/api/jobs/${encodeURIComponent(job.id)}/deploy/blobs/${index}`, { method: 'POST', body: '{}' });
        job.deployment.blobShas = job.deployment.blobShas || {};
        job.deployment.blobShas[String(index)] = result.blob.sha;
        done++;
      }

      setMessage('#modalMessage', 'All file blobs are ready. Creating the release tree and final commit…');
      const final = await api(`/api/jobs/${encodeURIComponent(job.id)}/deploy/commit`, { method: 'POST', body: '{}' });
      setMessage('#modalMessage', `Deployment complete · commit ${shortSha(final.result.commit.sha)}`, 'success');
      toast(`Release deployed · ${shortSha(final.result.commit.sha)}`);
      await refreshJobsAndStatus();
      await refreshAllBackups();
      await openJob(job.id);
    } catch (error) {
      setMessage('#modalMessage', `${error.message} The deployment session may be resumable; retry with Resume deployment after checking its status.`, 'error');
      toast(error.message, 'error');
      try {
        const fresh = await api(`/api/jobs/${encodeURIComponent(job.id)}`);
        state.activeJob = fresh.job;
        renderActiveJob();
      } catch { /* preserve original error */ }
    } finally {
      if ($('#deployJob')) $('#deployJob').disabled = false;
    }
  }

  function closeModal() {
    $('#jobModal').classList.add('hidden');
    document.body.style.overflow = '';
    state.activeJob = null;
  }

  async function restoreBackup(id) {
    const backup = state.backups.find((item) => item.id === id);
    if (!backup) return;
    const confirmed = window.confirm(`Restore ${backup.repo}@${backup.branch} to snapshot ${id}?\n\nThe current branch will be backed up first. Restore creates a new commit; it does not force-push.`);
    if (!confirmed) return;
    try {
      const data = await api(`/api/backups/${encodeURIComponent(id)}/restore`, { method: 'POST', body: '{}' });
      toast(`Restore complete · ${shortSha(data.result.commit.sha)}`);
      await refreshJobsAndStatus();
      await refreshAllBackups();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function createManualBackup() {
    const repo = $('#repoSelect').value;
    const branch = $('#branchSelect').value;
    if (!repo || !branch) return toast('Choose a repository and branch on the Overview page first.', 'error');
    if (!window.confirm(`Create a backup snapshot of ${repo}@${branch}?`)) return;
    try {
      const data = await api('/api/backups', { method: 'POST', body: JSON.stringify({ repo, branch }) });
      toast(`Backup created · ${data.backup.id}`);
      await refreshAllBackups();
      await refreshJobsAndStatus();
    } catch (error) { toast(error.message, 'error'); }
  }

  function wireInteractions() {
    $('#loginForm').addEventListener('submit', login);
    $('#togglePassword').addEventListener('click', () => {
      const input = $('#passwordInput');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    $('#logoutButton').addEventListener('click', () => lockDashboard(true));
    $('#repoSelect').addEventListener('change', (event) => loadBranches(event.target.value));
    $('#zipInput').addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (file) {
        $('#dropTitle').textContent = file.name;
        $('#dropSubtitle').textContent = `${formatBytes(file.size)} · Ready to inspect`;
        $('#uploadButton').disabled = false;
        setMessage('#uploadMessage', 'ZIP selected. Select Inspect ZIP to create a preview.');
      } else $('#uploadButton').disabled = true;
    });
    $('#uploadButton').addEventListener('click', handleUpload);
    const drop = $('#dropZone');
    ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('dragging'); }));
    drop.addEventListener('drop', (event) => {
      const file = [...(event.dataTransfer?.files || [])].find((item) => item.name.toLowerCase().endsWith('.zip'));
      if (!file) return toast('Drop a .zip archive.', 'error');
      const transfer = new DataTransfer(); transfer.items.add(file); $('#zipInput').files = transfer.files; $('#zipInput').dispatchEvent(new Event('change'));
    });

    $$('.nav-link').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
    $$('[data-goto]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.goto)));
    $('#jobFilter').addEventListener('change', renderJobs);
    $('#refreshJobs').addEventListener('click', () => refreshJobsAndStatus().then(() => toast('Deployment queue refreshed.')).catch((error) => toast(error.message, 'error')));
    $('#refreshBackups').addEventListener('click', () => refreshAllBackups().then(() => toast('Backup vault refreshed.')).catch((error) => toast(error.message, 'error')));
    $('#createBackupButton').addEventListener('click', createManualBackup);
    $('#refreshActivity').addEventListener('click', () => refreshJobsAndStatus().then(() => toast('Activity log refreshed.')).catch((error) => toast(error.message, 'error')));
    $('#backupRepoFilter').addEventListener('change', renderBackups);
    $('#fileSearch').addEventListener('input', (event) => { state.fileFilter = event.target.value; renderFileRows(); });
    $('#fileList').addEventListener('change', (event) => {
      const path = event.target.dataset.fileAction;
      if (!path || !state.activeJob) return;
      state.activeJob.actions[path] = event.target.value;
      state.dirtyActions[path] = event.target.value;
      event.target.className = `action-select action-${event.target.value}`;
      renderActiveJob();
    });
    $('#saveActions').addEventListener('click', saveJobActions);
    $('#refreshJob').addEventListener('click', refreshActiveJob);
    $('#deployJob').addEventListener('click', deployActiveJob);
    $$('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModal));
    $('#jobModal').addEventListener('click', (event) => {
      const close = event.target.closest('[data-close-modal]');
      if (close) closeModal();
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#jobModal').classList.contains('hidden')) closeModal(); });

    document.addEventListener('click', (event) => {
      const openButton = event.target.closest('[data-open-job]');
      if (openButton) openJob(openButton.dataset.openJob);
      const restoreButton = event.target.closest('[data-restore-backup]');
      if (restoreButton) restoreBackup(restoreButton.dataset.restoreBackup);
    });
  }

  function wireMotion() {
    let scheduled = false;
    window.addEventListener('pointermove', (event) => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--mx', `${event.clientX}px`);
        document.documentElement.style.setProperty('--my', `${event.clientY}px`);
        scheduled = false;
      });
    }, { passive: true });

    document.addEventListener('pointermove', (event) => {
      const card = event.target.closest('.tilt-card');
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - .5;
      const y = (event.clientY - rect.top) / rect.height - .5;
      card.style.transform = `perspective(700px) rotateY(${x * 4}deg) rotateX(${-y * 4}deg) translateY(-2px)`;
    }, { passive: true });
    document.addEventListener('pointerout', (event) => {
      const card = event.target.closest('.tilt-card');
      if (card && !card.contains(event.relatedTarget)) card.style.transform = '';
    });
  }

  async function init() {
    wireInteractions();
    wireMotion();
    const view = location.hash.replace('#', '');
    if (['overview', 'deployments', 'backups', 'activity'].includes(view)) setView(view);
    await restoreSession();
    const boot = $('#bootScreen');
    if (boot) {
      boot.classList.add('is-hidden');
      window.setTimeout(() => boot.remove(), 650);
    }
  }

  init();
})();
