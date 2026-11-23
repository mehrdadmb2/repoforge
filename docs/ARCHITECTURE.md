# RepoForge v2.1 architecture

## Components

### GitHub Pages

The repository root contains `index.html` and `config.js`. Static assets are under `assets/`. The Pages workflow assembles a minimal `dist/` folder with only the root website files and publishes that artifact. `worker/` and `docs/` are deliberately excluded from the public site artifact.

### Cloudflare Worker

The Worker is an API-only service. Its responsibilities are authentication, allowlist enforcement, GitHub API access, Telegram webhook processing, metadata persistence and coordinating the multi-request deployment lifecycle.

### Workers KV

Only one KV namespace is required:

| Key prefix | Purpose | Retention |
|---|---|---|
| `session:` | HMAC session revocation state | Session TTL |
| `login-attempt:` | Login throttling | 15 minutes |
| `job:` | Full release manifest, file choices and deployment state | 14 days |
| `job:summary:` | Compact list-card metadata; avoids reading full jobs for dashboard lists | 14 days |
| `job:index` | Recently created job IDs, newest first | 14 days |
| `payload:` | Base64 file content prepared by the browser | 14 days |
| `backup:` | Backup metadata indexed by repository | Persistent until manually cleaned |
| `backup-id:` | Direct lookup index by backup ID | Persistent until manually cleaned |
| `backup:index` | Latest backup metadata for dashboard and bot lists | Persistent, last 500 entries |
| `stage:` | Telegram file ID, target repo/branch and upload metadata (no ZIP bytes) | 1 hour |
| `tg-selection:` | Selected repository and branch for admin | 14 days |
| `tg-*menu:` | Temporary inline keyboard menu state | 10 minutes |
| `tg-update:` | Telegram update deduplication | 24 hours |
| `event:` | Audit event records | 180 days |
| `event:index` | Latest 100 audit events, newest first | 180 days |

No R2, D1, Durable Object, external database or paid Workers CPU plan is assumed. v1 R2-backed pending jobs are excluded from the v2 queue because their payloads are not available in KV; legacy backup metadata is still searched when restoring older snapshots.

## ZIP pipeline

1. Dashboard reads the ZIP as an ArrayBuffer.
2. `assets/zip.js` parses the ZIP central directory and rejects ZIP64, encrypted entries, unsupported compression, duplicate paths, traversal paths, `.git` paths and symbolic links.
3. Stored and DEFLATE entries are expanded with the browser's native `DecompressionStream('deflate-raw')` implementation.
4. The browser sends a manifest to `/api/jobs/prepare`.
5. The Worker reads the current GitHub branch and recursive Git tree to build a file-level diff.
6. The browser uploads each file's base64 data using a separate `PUT /api/jobs/:id/files/:index` request. Each payload is one KV value.
7. `/complete` confirms all expected payload keys are present and changes the job state from `uploading` to `pending`.

The Worker never extracts a ZIP and does not persist the Telegram ZIP bytes. This is intentional: Workers Free has a small CPU budget per request and KV writes are limited on the free tier.

## Telegram ZIP pipeline

1. Bot receives a `.zip` document in a private chat from the configured admin only.
2. Bot stores only Telegram `file_id`, target repo/branch and metadata in KV; ZIP bytes are not copied into KV.
3. Bot returns `DASHBOARD_URL?stage=<id>`.
4. After dashboard login, the Worker obtains a fresh Telegram file path and streams the ZIP directly to the browser. The browser extracts it locally and uses the same prepare/upload/complete API flow as a dashboard upload.
5. Stage metadata is deleted after successful transfer, or expires automatically after one hour.

## Deployment state machine

```text
uploading
   │ all payloads present
   ▼
pending ── branch changed ──> stale ── refresh ──> pending
   │
   │ start: verify base SHA + create backup branch
   ▼
deploying
   │ one request per selected file -> GitHub Blob SHA saved in KV
   │ final request -> Git Tree -> Commit -> non-force Ref update
   ├── success ──> deployed
   ├── branch moved ──> stale
   └── user cancels ──> cancelled
```

The deployment phases are separate requests so each Worker invocation performs a bounded amount of CPU work. The final Git ref update is non-force. It will not overwrite a concurrent non-fast-forward update.

## Backup and restore

A backup creates a branch `repoforge-backup-<timestamp>-<id>` at the exact commit observed before deployment. Its metadata stores the repo, original branch, commit SHA and backup branch name. Restore creates a new commit whose tree matches the backup but whose parent is the current branch tip, then advances the branch without force-pushing. A pre-restore backup is created first.

## Cross-origin model

The Pages site and Worker are different origins. `SITE_ORIGIN` must contain the origin only, for example `https://mehrdadmb2.github.io`, not the `/repoforge/` path. Authenticated browser API calls carry a signed bearer token and must originate from an allowlisted origin. The dashboard URL includes the repository path and is configured separately as `DASHBOARD_URL`.


## v2.1 authentication and webhook secret handling

`DASHBOARD_PASSWORD` and `SESSION_SECRET` accept any non-empty string; there is no enforced minimum character count. Short values are weaker and remain subject to IP-based login throttling. `TELEGRAM_WEBHOOK_SECRET` also accepts any non-empty text; the Worker derives the fixed Telegram-compatible header value as lowercase SHA-256 hex. The helper script registers that derived value with Telegram and the Worker temporarily accepts the previous raw header for migration compatibility.
