# راه‌اندازی نهایی RepoForge v2.1.0 — Windows + Wrangler + Cloudflare Free

این نسخه برای GitHub Pages + Cloudflare Workers Free + یک Workers KV Namespace + Telegram طراحی شده است. به R2، D1، Durable Objects یا Workers Paid نیاز ندارد.

## آدرس‌های نهایی

- GitHub: `https://github.com/mehrdadmb2/repoforge`
- GitHub Pages: `https://mehrdadmb2.github.io/repoforge/`
- Worker: `https://repoforge-worker.game-developer-mb.workers.dev`
- Telegram: `https://t.me/RepoForgeManagerBot`

`config.js` از قبل به Worker واقعی تنظیم شده است. `SITE_ORIGIN` در `worker/wrangler.toml` باید فقط `https://mehrdadmb2.github.io` باشد و `DASHBOARD_URL` باید آدرس کامل Pages با مسیر `/repoforge/` باشد.

## 1) پیش‌نیازها و مسیر پروژه

PowerShell 7 یا Windows PowerShell، Node.js LTS، npm، Git و دسترسی به حساب Cloudflare و GitHub لازم است.

```powershell
node -v
npm -v
git --version
npx wrangler --version
```

اگر پوشه محلی را نداری:

```powershell
mkdir "$HOME\Documents\GitHub" -Force
cd "$HOME\Documents\GitHub"
git clone https://github.com/mehrdadmb2/repoforge.git
cd .\repoforge
```

## 2) به‌روزرسانی ریپو و GitHub Pages

```powershell
git pull --ff-only origin main
```

ساختار اصلی باید شامل `index.html` و `config.js` در ریشه و `assets/` در ریشه باشد. پوشه `site/` دیگر استفاده نمی‌شود.

در GitHub → Settings → Pages → Build and deployment، Source را روی **GitHub Actions** بگذار. Workflow از `index.html`, `config.js` و `assets/` یک Artifact تمیز می‌سازد و فایل Worker یا مستندات را عمومی نمی‌کند.

پس از Push تغییرات سایت، در Actions بررسی کن `Deploy RepoForge dashboard to GitHub Pages` سبز شود.

## 3) ساخت KV (فقط یک‌بار)

```powershell
cd "$HOME\Documents\GitHub\repoforge\worker"
npx wrangler login
npx wrangler whoami
npx wrangler kv namespace create STATE
```

شناسه `id` خروجی را در `worker/wrangler.toml` در قسمت زیر قرار بده:

```toml
[[kv_namespaces]]
binding = "STATE"
id = "YOUR_REAL_NAMESPACE_ID"
```

اگر قبلاً Namespace مربوط به RepoForge را ساخته‌ای، همان ID موجود را نگه دار و KV جدید نساز.

**هیچ دستور R2 اجرا نکن.**

## 4) ساخت GitHub Fine-grained Token

از GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens یک Token بساز:

- Resource owner: `mehrdadmb2`
- Repository access: فقط ریپوهای موردنیاز
- Metadata: Read-only
- Contents: Read and write
- Workflows: فقط در صورت نیاز واقعی به تغییر فایل‌های `.github/workflows/*`

برای قابلیت‌های اصلی RepoForge، دسترسی Full Account یا توکن Classic با همه مجوزها لازم نیست.

## 5) ثبت Secretهای Worker

از PowerShell داخل پوشه `worker` اجرا کن. هر دستور مقدار را تعاملی دریافت می‌کند:

```powershell
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ALLOWED_REPOS
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_ADMIN_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put SESSION_SECRET
```

مقادیر:

| Secret | مقدار |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT |
| `ALLOWED_REPOS` | `mehrdadmb2/repoforge` یا لیست ریپوها با کاما |
| `TELEGRAM_BOT_TOKEN` | توکن BotFather |
| `TELEGRAM_ADMIN_ID` | شناسه عددی ادمین تلگرام |
| `TELEGRAM_WEBHOOK_SECRET` | هر متن غیرخالی؛ طول دلخواه |
| `DASHBOARD_PASSWORD` | هر رمز غیرخالی؛ طول دلخواه |
| `SESSION_SECRET` | هر متن غیرخالی؛ طول دلخواه |

### سیاست طول رمزها

RepoForge برای رمز داشبورد، Session Secret و مقدار اصلی Webhook هیچ حداقل تعداد کاراکتری تحمیل نمی‌کند. مقادیر خالی پذیرفته نمی‌شوند. رمز یک‌کاراکتری هم کار می‌کند، اما به‌راحتی قابل حدس است؛ برای امنیت بهتر، رمز داشبورد را منحصربه‌فرد و Session/Webhook Secret را تصادفی و طولانی انتخاب کن. این توصیه امنیتی است، نه محدودیت فنی اجباری.

`TELEGRAM_ADMIN_ID` همچنان باید فقط عدد باشد. توکن BotFather باید معتبر باشد.

### نکته مهم درباره Telegram Webhook Secret

Telegram برای `setWebhook.secret_token` محدودیت قالب و طول خودش را دارد. RepoForge این محدودیت را از مقدار اصلی پنهان می‌کند: Worker مقدار `TELEGRAM_WEBHOOK_SECRET` را با SHA-256 به یک مقدار hex شصت‌وچهارکاراکتری تبدیل می‌کند. اسکریپت مرحله 7 دقیقاً همان مقدار را به Telegram می‌دهد. پس در Wrangler مقدار اصلی را وارد کن، نه هش آن.

## 6) نصب و تست Worker

```powershell
cd "$HOME\Documents\GitHub\repoforge\worker"
npm install
npm run check
npm test
```

هر دو دستور Check و Test باید بدون خطا تمام شوند.

## 7) ثبت یا به‌روزرسانی Webhook تلگرام

پس از قرار گرفتن کد جدید روی Worker، از پوشه ریشه ریپو اجرا کن:

```powershell
cd "$HOME\Documents\GitHub\repoforge"
.\scripts\Set-TelegramWebhook.ps1
```

اسکریپت ابتدا `/api/health` را بررسی می‌کند، سپس از توکن BotFather و مقدار اصلی `TELEGRAM_WEBHOOK_SECRET` که در Wrangler ذخیره کرده‌ای سؤال می‌کند، SHA-256 hex را می‌سازد، `setWebhook` را اجرا می‌کند و در پایان `getWebhookInfo` را نمایش می‌دهد.

اگر قبلاً Webhook را با مقدار خام ثبت کرده‌ای، کد جدید موقتاً هر دو حالت خام و هش‌شده را قبول می‌کند؛ با اجرای اسکریپت به فرمت جدید مهاجرت کن.

## 8) Deploy Worker با Wrangler

پس از جایگزینی KV ID و ثبت Secretها:

```powershell
cd "$HOME\Documents\GitHub\repoforge"
.\scripts\Deploy-Worker.ps1
```

یا دستی:

```powershell
cd .\worker
npx wrangler deploy
```

Worker باید روی همان آدرس قبلی به‌روزرسانی شود:

```text
https://repoforge-worker.game-developer-mb.workers.dev
```

تست سلامت:

```powershell
Invoke-RestMethod "https://repoforge-worker.game-developer-mb.workers.dev/api/health" | ConvertTo-Json -Depth 5
```

باید `ok: true`, `version: 2.1.0`, `storage: Cloudflare Workers KV` و `r2Required: false` نمایش داده شود.

## 9) Push تغییرات Pages و بررسی سایت

از ریشه ریپو:

```powershell
git add -A
git status
git commit -m "Configure RepoForge v2.1.0 endpoints and flexible secrets"
git push origin main
```

Workflow Pages را بررسی و سپس سایت را باز کن:

`https://mehrdadmb2.github.io/repoforge/`

واردشدن با `DASHBOARD_PASSWORD` انجام می‌شود. هر رمز غیرخالی پذیرفته می‌شود و هیچ minimum length در Worker وجود ندارد.

## 10) تست پایان‌به‌پایان

```powershell
.\scripts\Test-RepoForge.ps1
```

سپس در Telegram به `@RepoForgeManagerBot` پیام بده:

```text
/start
/status
/repos
```

ریپوی `mehrdadmb2/repoforge` را انتخاب کن، ZIP را به‌صورت Document ارسال کن و لینک خصوصی داشبورد را باز کن. در داشبورد فایل‌ها را بازبینی کن. ابتدا فقط روی ریپوی آزمایشی تست کن.

## 11) لاگ و عیب‌یابی

```powershell
cd "$HOME\Documents\GitHub\repoforge\worker"
npx wrangler tail --format pretty
```

- `401`: نشست منقضی شده یا رمز داشبورد اشتباه است.
- `403 Origin`: `SITE_ORIGIN` باید دقیقاً `https://mehrdadmb2.github.io` باشد.
- `503 STATE`: KV binding یا ID اشتباه است.
- `GitHub API 401/403`: توکن GitHub یا مجوز Contents را بررسی کن.
- `Telegram 403`: Webhook را با `scripts/Set-TelegramWebhook.ps1` دوباره ثبت کن و مطمئن شو همان مقدار اصلی secret را وارد می‌کنی.
- `ALLOWED_REPOS`: فرمت باید `owner/repo` باشد و توکن نیز باید به آن ریپو دسترسی داشته باشد.

## 12) محدودیت‌های Free و نکات اجرایی

- پردازش ZIP در مرورگر انجام می‌شود تا Worker از CPU محدود Free استفاده سنگین نکند.
- ارسال Blobها و مراحل انتشار به درخواست‌های کوچک تقسیم شده‌اند.
- KV Free سهمیه روزانه دارد؛ آپلود ZIP با تعداد بسیار زیاد فایل می‌تواند سهمیه نوشتن را مصرف کند.
- سقف‌های نرم پروژه: ZIP فشرده ۱۹ MiB، مجموع استخراج ۱۶ MiB، هر فایل ۱ MiB و ۴۰۰ فایل.
- GitHub Pages در این مخزن عمومی است؛ رمز داشبورد API را محافظت می‌کند، نه سورس HTML/CSS/JS را.
- Backupها به‌صورت Git Branch در همان ریپو ذخیره می‌شوند؛ برای اطلاعات حیاتی، Backup مستقل خارج از ریپو نیز نگه دار.

## 13) Helper scripts

- `scripts/Deploy-Worker.ps1`: نصب وابستگی، check، test، deploy و health-check.
- `scripts/Set-TelegramWebhook.ps1`: ثبت Webhook با secret مشتق‌شده و نمایش وضعیت.
- `scripts/Test-RepoForge.ps1`: بررسی عمومی Worker و GitHub Pages.

نسخه: `2.1.0` · Storage: `Workers KV` · Runtime: `Cloudflare Workers Free`
