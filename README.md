# RepoForge

**Private GitHub deployment control plane powered by GitHub Pages, Cloudflare Workers Free, Workers KV and Telegram.**

RepoForge lets one administrator upload a project ZIP, compare it with a selected GitHub repository and branch, decide file-by-file what to update, keep or delete, create a Git backup, and publish the selected changes as one commit.

## v2.1.0 — Configured Free-plan release

This release fixes the original deployment layout and removes the R2 dependency completely.

- `index.html` and `config.js` are at the repository root, as required by GitHub Pages publishing sources.
- Dashboard assets are under `/assets`.
- The Pages workflow creates a clean `dist/` artifact from root website files only. Worker source, documentation and configuration are not published as site assets.
- Cloudflare storage uses **one Workers KV namespace**. No R2 bucket, D1 database, Durable Object or paid Worker CPU setting is needed.
- ZIP parsing and DEFLATE extraction happen in the administrator's browser, not in the 10 ms Workers Free CPU runtime.
- Telegram ZIP uploads store only a temporary Telegram file reference in KV; the Worker streams the archive to the signed-in dashboard on demand.
- Each file payload is sent to KV in its own small HTTP request. GitHub blobs are also created one per request. A final request creates one Git Tree, one Commit and advances the branch without force-pushing.
- The bot accepts commands only from the configured numeric Telegram administrator ID in a private chat.
- The dashboard has password authentication, HMAC-signed sessions, short-lived session storage and login throttling. Non-empty passwords and session secrets of any length are accepted; short values remain less secure.
- The configured Worker endpoint is `https://repoforge-worker.game-developer-mb.workers.dev`; Pages and Telegram URLs are preconfigured.
- Telegram webhook setup hashes any non-empty operator secret to a Telegram-compatible 64-character header token; the old raw-header format remains temporarily compatible.

## Repository layout

```text
repoforge/
├── index.html                 # GitHub Pages entry point (repository root)
├── config.js                  # Public API URL and browser-side limits
├── assets/
│   ├── app.js                 # Dashboard and API client
│   ├── zip.js                 # Browser-side ZIP inspection/extraction
│   ├── styles.css
│   └── repoforge.svg
├── .nojekyll
├── .github/workflows/pages.yml
├── worker/
│   ├── wrangler.toml          # One KV binding; no R2
│   ├── package.json
│   └── src/
│       ├── index.js           # API router and auth gate
│       ├── auth.js            # Password login and HMAC sessions
│       ├── github.js          # GitHub Git Database, backups and deployments
│       ├── telegram.js        # Admin-only bot and ZIP staging
│       └── utils.js
├── scripts/
│   ├── Deploy-Worker.ps1
│   ├── Set-TelegramWebhook.ps1
│   └── Test-RepoForge.ps1
├── docs/
│   ├── SETUP-FA.md
│   ├── ARCHITECTURE.md
│   ├── SECURITY.md
│   └── BRAND-PROMPTS.md
├── BOT_COMMANDS.txt
└── LICENSE
```

## Deployment model

1. Sign in to the dashboard.
2. Select one repository and branch from the server-side allowlist.
3. Select a ZIP. The browser checks the central directory, rejects unsafe paths and unsupported archive features, expands files locally and builds a manifest.
4. The Worker compares the manifest to the GitHub tree. New and existing ZIP paths default to **Update**; paths found only in GitHub default to **Keep**.
5. Choose `Update`, `Keep` or `Delete` individually. `Delete` is offered only when a remote file exists.
6. Start deployment. RepoForge creates a backup branch pointing at the exact current commit.
7. The browser uploads selected Git blobs through separate requests. The Worker stores each blob SHA in KV so the process can resume after a browser interruption.
8. The final API request creates one tree and one commit, then moves the target branch with `force: false`. If the branch changed meanwhile, the operation stops and requires a refreshed preview.

## Telegram flow

1. Use `/select` and choose a repository and branch.
2. Send the ZIP as a Telegram **document**.
3. The bot stores only the Telegram `file_id` and target metadata in Workers KV, then returns a private dashboard link.
4. Sign in to the dashboard and open the link. The Worker streams the archive from Telegram to the browser; the browser extracts it and creates the file-level preview.
5. Use Telegram or the dashboard to inspect and change file actions. The bot can start the backup/deployment session and then links back to the dashboard for the per-file Blob requests and final commit.

## Free-plan profile and limits

The supplied defaults are deliberately conservative:

| Limit | Default |
|---|---:|
| Telegram ZIP compressed download limit | 19 MiB |
| Expanded archive size | 16 MiB |
| Individual file size | 1 MiB |
| ZIP file count | 400 |
| Repository file count for preview | 3,000 |
| Changed files per commit | 100 |
| Temporary Telegram stage | 1 hour |
| Job manifest retention | 14 days |
| File payload retention | 14 days |

These application limits do not increase Cloudflare or Telegram limits. Workers Free has a 10 ms CPU budget per invocation; Workers KV Free has finite daily read/write quotas and a 25 MiB value-size ceiling. Telegram's hosted Bot API currently limits `getFile` downloads to 20 MB. The 19 MiB cap leaves headroom. Keep an eye on KV write quotas when uploading many hundreds of files. See the linked official documentation in `docs/SETUP-FA.md`.

## Required secrets

Set these with `wrangler secret put` in the `worker/` directory:

- `GITHUB_TOKEN`
- `ALLOWED_REPOS`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `DASHBOARD_PASSWORD`
- `SESSION_SECRET`

Only the public dashboard origin and base URL are stored in `wrangler.toml` and `config.js`. Never put a GitHub token, Telegram bot token or dashboard password in the Pages bundle.

## Quick start

See **[docs/SETUP-FA.md](docs/SETUP-FA.md)** for the complete Windows PowerShell and Wrangler setup, including the webhook helper scripts. The dashboard URL for this repository is:

`https://mehrdadmb2.github.io/repoforge/`

The Worker endpoint is configured as `https://repoforge-worker.game-developer-mb.workers.dev`. The dashboard URL is `https://mehrdadmb2.github.io/repoforge/`, and the bot URL is `https://t.me/RepoForgeManagerBot`. Run `scripts/Set-TelegramWebhook.ps1` with the same raw `TELEGRAM_WEBHOOK_SECRET` value stored in Wrangler after deploying the Worker. This value may be any non-empty text; the helper derives the Telegram-compatible header value.

## Validation

From `worker/`:

```powershell
npm install
npm run check
npm test
npx wrangler deploy
```

The tests validate the browser ZIP parser and path/branch validation locally. They do not replace a live integration test with your GitHub PAT, Cloudflare KV namespace, Telegram token and webhook.

## Safety notes

- Start with a test repository before granting access to important projects.
- The allowlist is an additional restriction beyond GitHub token permissions.
- Do not grant `Workflows` write permission unless you actually need to modify `.github/workflows/*`.
- Backups are Git branches in the target repository and their metadata is indexed in KV. Do not delete backup branches manually if you expect to restore them from the dashboard.
- A backup is not an independent off-site archive. For critical repositories, also keep GitHub-native or local backups.
