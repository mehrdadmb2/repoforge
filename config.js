/* Public browser configuration only. Never put passwords or API tokens here. */
window.REPOFORGE_CONFIG = Object.freeze({
  apiBase: "https://repoforge-worker.game-developer-mb.workers.dev",
  dashboardUrl: "https://mehrdadmb2.github.io/repoforge/",
  botUrl: "https://t.me/RepoForgeManagerBot",
  repositoryUrl: "https://github.com/mehrdadmb2/repoforge",
  version: "2.1.0",
  limits: Object.freeze({
    maxArchiveBytes: 19 * 1024 * 1024,
    maxExpandedBytes: 16 * 1024 * 1024,
    maxFileBytes: 1 * 1024 * 1024,
    maxFiles: 400
  })
});
