# RepoForge

**Private GitHub repository deployment control plane** powered by Cloudflare Workers, Workers KV, R2, GitHub REST API, Telegram Bot API and GitHub Pages.

RepoForge accepts a ZIP release, inspects its paths, compares them with a selected GitHub branch, and lets the administrator choose an action for every path:

- **Update** — create or replace the path with the ZIP file.
- **Keep** — leave the repository path unchanged.
- **Delete** — remove the matching path from the target branch.

Paths found in the repository but absent from the ZIP are shown as **repository-only** paths. They default to **Keep** and can be changed to **Delete**. Nothing is changed on GitHub until the administrator confirms deployment.

A deployment creates a dedicated `repoforge-backup-*` branch at the current commit, then creates one Git tree and one commit for the selected file changes. The target branch is updated without force-push. If the branch changed after preview, the job is marked stale and must be refreshed and reviewed again.

## Components

| Component | Responsibility |
|---|---|
| `site/` | Responsive GitHub Pages dashboard. No GitHub or Telegram secrets are shipped to the browser. |
| `worker/` | Authenticated API, GitHub operations, Telegram webhook, ZIP validation and deployment orchestration. |
| Workers KV (`STATE`) | Session-independent job metadata, admin selection, backup index and audit events. |
| R2 (`ARCHIVES`) | Temporarily stores ZIP uploads so the Worker can inspect them again at deployment time. |
| GitHub | Source of truth for files, commits, branches and backup refs. |
| Telegram | Private administrator interface, ZIP intake, file review and confirmations. |

## Important security model

1. Use a **fine-grained GitHub Personal Access Token**, not a classic account-wide token. Grant access only to the repositories in `ALLOWED_REPOS`.
2. Required GitHub repository permissions: **Metadata: Read-only** and **Contents: Read and write**. Add **Workflows: Read and write** only if you intend to update files under `.github/workflows/`.
3. Store the GitHub token, bot token, dashboard password, HMAC session secret, Telegram administrator ID, webhook secret and repository allowlist as **Cloudflare Worker secrets**. They must never be added to GitHub Pages, `config.js`, ZIP archives, or committed files.
4. `ALLOWED_REPOS` is an additional server-side allowlist. A repository must be both accessible to the PAT and explicitly listed there.
5. Telegram accepts actions only from `TELEGRAM_ADMIN_ID` in a private chat. The webhook also validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
6. Dashboard login issues a signed, short-lived bearer session stored in `sessionStorage`. It is cleared when the browser tab/session ends or the user locks the dashboard.
7. GitHub Pages is static hosting: the login gate protects the dashboard controls and every API operation, but **the static HTML/CSS/JavaScript source itself is still publicly downloadable** on a public Pages site. Never put secrets or private repository content in the site bundle. For strict page-level privacy, put the site behind Cloudflare Access or host it on an authenticated private origin.
8. RepoForge never force-pushes. Branch protection rules may reject direct commits; in that case configure the target branch to allow this deployment model or add a pull-request release workflow before using it on that branch.

## Current release limits

Defaults in `worker/wrangler.toml` are deliberately conservative:

- ZIP archive: 18 MiB maximum (Telegram's Bot API download limit is 20 MB).
- Expanded content: 32 MiB maximum.
- Individual file: 8 MiB maximum.
- ZIP entries: 400 maximum.
- Repository preview: 3,000 tracked files maximum.
- Changed files per commit: 25 maximum.
- ZIP64, encrypted ZIP files, symlinks, multi-disk ZIPs, unsupported compression methods and unsafe paths are rejected.

Cloudflare Workers have a 128 MB isolate memory limit. The Free plan has a 10 ms CPU limit; ZIP decompression and multi-file Git operations are much more practical on Workers Paid with an appropriate CPU limit. This project configures `cpu_ms = 30000`; deploy on a plan that permits that setting. See the official platform limits before increasing archive or file limits.

## Repository layout

```text
repoforge/
├── .github/workflows/pages.yml
├── docs/
│   ├── ARCHITECTURE.md
│   ├── SECURITY.md
│   ├── SETUP-FA.md
│   └── BRAND-PROMPTS.md
├── site/
│   ├── assets/
│   │   ├── app.js
│   │   ├── repoforge.svg
│   │   └── styles.css
│   ├── config.js
│   └── index.html
├── worker/
│   ├── src/
│   │   ├── auth.js
│   │   ├── github.js
│   │   ├── index.js
│   │   ├── telegram.js
│   │   ├── utils.js
│   │   └── zip.js
│   ├── .dev.vars.example
│   ├── package.json
│   └── wrangler.toml
├── BOT_COMMANDS.txt
└── README.md
```

## Quick start

The complete Persian setup guide is in [`docs/SETUP-FA.md`](docs/SETUP-FA.md). Follow it in order:

1. Create the GitHub repository `repoforge` and upload this project.
2. Create a Workers KV namespace named `STATE` and an R2 bucket named `repoforge-archives`.
3. Replace the KV namespace ID in `worker/wrangler.toml`.
4. Configure Worker variables and secrets; deploy with Wrangler.
5. Set the Worker URL in `site/config.js` and set `SITE_ORIGIN` in `wrangler.toml` to the **origin only** of your GitHub Pages site (no repository path).
6. Enable GitHub Pages using GitHub Actions.
7. Register the Telegram webhook and add the public command list from `BOT_COMMANDS.txt` in BotFather.

## Deployment behavior

A pending job stores the archive in R2 and metadata in KV. Its preview contains all ZIP paths plus all repository-only paths. Default actions are `Update` for ZIP files and `Keep` for repository-only files. The administrator can change each action in the web review modal or Telegram file browser.

Before the target branch is changed, RepoForge creates a backup branch pointing to the current HEAD. It then creates blobs for selected ZIP files, creates a tree based on the current tree, creates one commit whose parent is the current HEAD, and updates the branch ref with `force: false`.

A restore creates a new commit using the selected backup tree and the current branch HEAD as its parent. It also creates a pre-restore backup. This keeps history append-only and avoids force-pushing an old commit pointer.

## Limitations / planned extensions

- This starter is a single-administrator deployment manager, not a general Git hosting platform.
- GitHub branch listing currently reads up to 100 branches per repository.
- Recursive Git tree responses marked truncated are rejected rather than showing an incomplete destructive preview.
- The current implementation uses a single Git tree/commit and a configurable 25-file cap. It does not implement Git LFS uploads, submodule management, releases, repository creation/deletion, branch protection changes, or pull-request approval flows.
- Pending ZIP files are retained in R2 until bucket lifecycle cleanup. Configure an R2 lifecycle rule to expire objects under `uploads/` after 14 days.
- The dashboard source is public on a public GitHub Pages site. The API and actions are password-protected; the static source is not confidential.

## Documentation

- [Persian setup guide](docs/SETUP-FA.md)
- [Architecture and deployment flow](docs/ARCHITECTURE.md)
- [Security model and threat checklist](docs/SECURITY.md)
- [Banner and avatar image prompts](docs/BRAND-PROMPTS.md)
- [Bot commands](BOT_COMMANDS.txt)
