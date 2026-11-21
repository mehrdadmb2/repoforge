# Security checklist

## Credentials

- [ ] Create a fine-grained PAT for selected repositories only.
- [ ] Grant `Metadata: Read-only` and `Contents: Read and write`.
- [ ] Grant `Workflows: Read and write` only when workflow files must be changed.
- [ ] Keep token expiration short enough for your rotation policy.
- [ ] Add the PAT only with `wrangler secret put GITHUB_TOKEN`.
- [ ] Never add a token to `site/config.js`, frontend JavaScript, a ZIP, README, issue, screenshot or chat log.
- [ ] Keep `ALLOWED_REPOS` limited to exact `owner/repository` names.
- [ ] Use a long, unique dashboard password and a random `SESSION_SECRET`.
- [ ] Use a strong, random `TELEGRAM_WEBHOOK_SECRET` and numeric `TELEGRAM_ADMIN_ID`.

## Deployment safety

- [ ] Keep `MAX_CHANGED_FILES` conservative until you validate Worker CPU and subrequest limits.
- [ ] Keep ZIP limits conservative; do not increase them without checking the Worker memory limit.
- [ ] Enable branch protection where appropriate. RepoForge never force-pushes.
- [ ] Confirm that `repoforge-backup-*` branches are retained by repository cleanup rules.
- [ ] Configure R2 lifecycle deletion for old `uploads/` objects.
- [ ] Review the exact update/keep/delete choices before deployment.
- [ ] Refresh a stale preview; do not deploy against an outdated base SHA.

## Hosting and browser

- [ ] Configure the exact GitHub Pages origin in `SITE_ORIGIN`, for example `https://username.github.io`.
- [ ] Do not include a project path such as `/repoforge` in `SITE_ORIGIN`.
- [ ] Remember that public GitHub Pages source is public even when the dashboard login is enabled.
- [ ] Use Cloudflare Access or a private authenticated origin if the HTML/JS itself must not be public.
- [ ] Serve the site and Worker only over HTTPS.
- [ ] Review third-party font loading policy. The dashboard can use system fallbacks if Google Fonts are unavailable.

## Operational checks

- [ ] Test a ZIP containing a new file, an existing file, and a file absent from the ZIP.
- [ ] Test Keep on an existing file.
- [ ] Test Delete on a repository-only file.
- [ ] Test a manual backup and restore on a disposable branch first.
- [ ] Test a stale preview by pushing a commit between preview and deployment.
- [ ] Test wrong Telegram user ID and a non-private chat.
- [ ] Rotate secrets immediately if a token or password is exposed.

## Threat boundaries

RepoForge is designed for one administrator. It does not protect a compromised GitHub account, Cloudflare account, Telegram account, browser session, or administrator device. A malicious ZIP can still contain harmful source code; path validation protects the repository path namespace, not the semantics of the code being deployed. Always inspect the source before release.
