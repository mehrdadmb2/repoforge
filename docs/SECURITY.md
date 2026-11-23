# RepoForge security model

## Authentication boundaries

- Dashboard: a password stored as a Cloudflare Worker secret. Password minimum: 12 characters.
- Sessions: HMAC-SHA256 signed tokens, server-side revocation nonce in KV and configurable expiration. The browser keeps the token in `sessionStorage`, not `localStorage`.
- Telegram: private chat only, exact numeric `TELEGRAM_ADMIN_ID` match for both sender and chat ID.
- Webhook: validates `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET`.
- GitHub: GitHub PAT is stored only as `GITHUB_TOKEN` Worker secret. Every repository access is checked against `ALLOWED_REPOS`.
- CORS: exact-match origin allowlist. CORS is not the authentication mechanism; the signed dashboard token is also required.

## GitHub permissions

Use a Fine-grained PAT restricted to the smallest useful set of repositories. For the core Git Data workflow:

- Metadata: Read-only
- Contents: Read and write

Only add Workflows: Read and write if you deliberately deploy `.github/workflows/*`. Do not grant account administration or broad organization permissions for normal file deployment.

## ZIP safety

The browser ZIP parser rejects:

- Absolute paths and Windows drive paths
- `.` and `..` path segments
- `.git` paths
- Duplicate filenames and file/directory path collisions within the ZIP or against the current repository tree
- Symbolic links
- Encrypted ZIP entries
- ZIP64 and multi-disk archives
- Unsupported compression methods
- Archives exceeding configured compressed, expanded, per-file or file-count limits

The Worker independently validates every manifest path, file size, unique path and base64 length before accepting payloads. A malicious browser cannot use a path traversal entry to write outside the GitHub repository tree.

## Deployment safety

- Every deployment requires an explicit file-level action selection.
- A pre-deploy Git backup branch is created before publishing the commit.
- Git blob creation is isolated one file per Worker request to stay within Free CPU limits.
- The branch base SHA is checked both before backup and before final commit publication.
- The final ref update uses `force: false`.
- Restore creates a pre-restore backup and a new commit rather than force-pushing an old branch state.
- A deployment session can be resumed when some Git blobs were created but the final commit was not published.

## Free-plan storage considerations

Workers KV Free has finite daily operation quotas and a maximum 25 MiB value size. RepoForge stores each file payload separately and limits each file to 1 MiB. Telegram staging stores only a short-lived `file_id` reference and metadata in KV; the archive is streamed from Telegram to the authenticated dashboard on demand. Its compressed-size limit is 19 MiB and the stage metadata expires after one hour. The dashboard should avoid repeated uploads of hundreds of files; use incremental update ZIPs where practical.

## Public Pages limitation

GitHub Pages is a public static hosting service for this repository configuration. The dashboard's password protects the API and application views, but it cannot make public `index.html`, CSS or JavaScript source files private. Never place secrets in `config.js` or any Pages asset. If the static site itself must be private, use an authenticated hosting/access layer rather than relying on client-side password UI.

## Incident response

If a token is exposed:

1. Revoke the GitHub PAT in GitHub settings and issue a replacement.
2. Revoke the Telegram bot token with BotFather if exposed.
3. Rotate `SESSION_SECRET`, `DASHBOARD_PASSWORD` and `TELEGRAM_WEBHOOK_SECRET` as appropriate.
4. Redeploy the Worker.
5. Review GitHub commit history, backup branches and RepoForge audit events.
