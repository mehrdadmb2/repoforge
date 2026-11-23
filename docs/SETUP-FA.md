# راه‌اندازی RepoForge v2.0 روی پلن رایگان Cloudflare

این نسخه مخصوص معماری GitHub Pages + Cloudflare Workers Free + Workers KV + Telegram Bot طراحی شده است. **به R2، D1، Durable Objects یا Workers Paid نیاز ندارد.**

آدرس‌های این پروژه:

- Repository: `https://github.com/mehrdadmb2/repoforge`
- GitHub Pages: `https://mehrdadmb2.github.io/repoforge/`
- Telegram bot: `https://t.me/RepoForgeManagerBot`
- Worker: پس از Deploy از حساب Cloudflare تو مشخص می‌شود؛ فعلاً در `config.js` جایگزین دارد.

> نکته بسیار مهم: سایت از فایل `index.html` در ریشه ریپو شروع می‌شود. Workflow انتشار نیز فقط `index.html`، `config.js` و `assets/` را از ریشه در پوشه موقت `dist/` جمع می‌کند. پوشه‌های `worker/` و `docs/` وارد Artifact عمومی Pages نمی‌شوند.

## ۰. پیش‌نیازها

- Node.js نسخه LTS و npm
- GitHub account و دسترسی به ریپوهایی که می‌خواهی مدیریت کنی
- Cloudflare account با Workers Free و Workers KV فعال
- رباتی که قبلاً در BotFather ساخته‌ای: `@RepoForgeManagerBot`
- PowerShell ویندوز

در Worker Free سقف CPU هر درخواست ۱۰ میلی‌ثانیه است؛ به همین دلیل استخراج ZIP در مرورگر و ارسال هر فایل/Blob در درخواست جدا انجام می‌شود. Workers KV پلن Free شامل ۱ namespace تا ۱ GB storage، حداکثر ۲۵ MiB برای هر value، ۱۰۰ هزار read و ۱۰۰۰ write در روز است. Telegram `getFile` نیز فعلاً دانلود حداکثر ۲۰ MB را پشتیبانی می‌کند. محدودیت ZIP پروژه روی ۱۹ MiB قرار داده شده است.

منابع رسمی:

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers KV limits: https://developers.cloudflare.com/kv/platform/limits/
- Workers KV pricing: https://developers.cloudflare.com/kv/platform/pricing/
- Telegram Bot API: https://core.telegram.org/bots/api#getfile
- GitHub Pages 404 troubleshooting: https://docs.github.com/en/pages/getting-started-with-github-pages/troubleshooting-404-errors

## ۱. جایگزین‌کردن فایل‌های ریپو

1. از ریپوی فعلی یک Backup یا ZIP محلی بگیر.
2. فایل ZIP نسخه جدید را Extract کن.
3. محتویات پوشه `repoforge-v2` را در ریشه ریپوی `mehrdadmb2/repoforge` قرار بده و فایل‌های قدیمی را Replace کن.
4. پوشه قدیمی `site/` را از ریپو حذف کن؛ نسخه جدید سایت را از ریشه منتشر می‌کند و دیگر از `site/` استفاده نمی‌شود.
5. بررسی کن این مسیرها دقیقاً وجود داشته باشند:

```text
repoforge/
├── index.html
├── config.js
├── .nojekyll
├── assets/
│   ├── app.js
│   ├── zip.js
│   ├── styles.css
│   └── repoforge.svg
├── .github/workflows/pages.yml
└── worker/
    ├── wrangler.toml
    └── src/
```

6. تغییرات را روی شاخه `main` Push کن.

## ۲. تنظیم GitHub Pages

در GitHub:

1. وارد `mehrdadmb2/repoforge` شو.
2. Settings → Pages را باز کن.
3. در Build and deployment، گزینه **GitHub Actions** را انتخاب کن.
4. به تب Actions برو و Workflow با نام `Deploy RepoForge dashboard to GitHub Pages` را اجرا/بررسی کن.
5. وقتی Workflow سبز شد، سایت را باز کن:

```text
https://mehrdadmb2.github.io/repoforge/
```

Workflow یک پوشه `dist` می‌سازد و فقط فایل‌های عمومی سایت را در سطح بالای Artifact قرار می‌دهد. بنابراین `index.html` در ریشه Artifact وجود دارد و هم‌زمان سورس Worker عمومی نمی‌شود.

## ۳. ساخت Workers KV (فقط یک‌بار)

در Cloudflare Dashboard:

1. Workers & Pages → KV را باز کن.
2. یک Namespace با نام `STATE` بساز.

یا از PowerShell:

```powershell
cd path\to\repoforge\worker
npx wrangler kv namespace create STATE
```

خروجی دارای یک `id` است. فایل `worker/wrangler.toml` را باز کن و مقدار زیر را جایگزین کن:

```toml
[[kv_namespaces]]
binding = "STATE"
id = "PASTE_REAL_KV_NAMESPACE_ID"
```

**هیچ دستور R2 اجرا نکن.** در این نسخه هیچ binding یا dependency مربوط به R2 وجود ندارد.

## ۴. ساخت Fine-grained GitHub token

از GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens یک توکن بساز.

پیشنهاد:

- Token name: `RepoForge Worker`
- Resource owner: مالک ریپوهای هدف
- Repository access: فقط ریپوهای موردنیاز؛ از All repositories استفاده نکن مگر واقعاً لازم باشد.
- `Metadata`: Read-only
- `Contents`: Read and write
- `Workflows`: فقط اگر می‌خواهی فایل‌های `.github/workflows/*` را ویرایش کنی، Read and write

برای مدیریت فایل‌ها، Tree، Blob، Commit، Branch و Backup معمولاً `Contents: Read and write` کافی است. این پروژه برای عملیات معمول فایل‌ها به Full Account Access نیاز ندارد.

## ۵. تنظیم آدرس‌های عمومی

### `worker/wrangler.toml`

متغیرها از قبل برای آدرس Pages این ریپو تنظیم شده‌اند:

```toml
SITE_ORIGIN = "https://mehrdadmb2.github.io"
DASHBOARD_URL = "https://mehrdadmb2.github.io/repoforge/"
```

مهم: `SITE_ORIGIN` فقط Origin است و نباید مسیر `/repoforge/` داشته باشد. `DASHBOARD_URL` آدرس کامل صفحه است و باید مسیر ریپو را داشته باشد.

### `config.js`

این فایل در ریشه ریپو است. پس از ساخت Worker، مقدار `apiBase` را به آدرس واقعی آن تغییر بده:

```javascript
window.REPOFORGE_CONFIG = Object.freeze({
  apiBase: "https://repoforge-worker.YOUR-SUBDOMAIN.workers.dev",
  dashboardUrl: "https://mehrdadmb2.github.io/repoforge/",
  botUrl: "https://t.me/RepoForgeManagerBot",
  limits: Object.freeze({
    maxArchiveBytes: 19 * 1024 * 1024,
    maxExpandedBytes: 16 * 1024 * 1024,
    maxFileBytes: 1 * 1024 * 1024,
    maxFiles: 400
  })
});
```

`apiBase` باید فقط آدرس ریشه Worker باشد، بدون `/api` و بدون اسلش انتهایی.

## ۶. آماده‌سازی Worker در ویندوز

```powershell
cd path\to\repoforge\worker
npm install
npm run check
npm test
```

اگر دو مرحله بررسی موفق بود، Secretها را ثبت کن. هر دستور مقدار را در حالت تعاملی می‌گیرد:

```powershell
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ALLOWED_REPOS
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_ADMIN_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put SESSION_SECRET
```

مقدار هر مورد:

| Secret | مقدار |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT ساخته‌شده در مرحله ۴ |
| `ALLOWED_REPOS` | فهرست ریپوها با فرمت `owner/repo,owner/repo2` |
| `TELEGRAM_BOT_TOKEN` | توکن BotFather برای `@RepoForgeManagerBot` |
| `TELEGRAM_ADMIN_ID` | شناسه عددی اکانت تلگرام خودت؛ نه Username و نه شماره تلفن |
| `TELEGRAM_WEBHOOK_SECRET` | حداقل ۲۴ کاراکتر تصادفی، حروف/عدد و `_` یا `-` |
| `DASHBOARD_PASSWORD` | رمز مستقل داشبورد، حداقل ۱۲ کاراکتر |
| `SESSION_SECRET` | مقدار تصادفی قوی، حداقل ۳۲ کاراکتر |

نمونه ALLOWED_REPOS:

```text
mehrdadmb2/repoforge,mehrdadmb2/your-next-repository
```

فقط ریپوهایی را وارد کن که واقعاً می‌خواهی از طریق ربات و داشبورد مدیریت شوند.

### تولید Secret تصادفی در PowerShell

```powershell
$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$secret = [Convert]::ToHexString($bytes)
$secret
```

برای `SESSION_SECRET` یک مقدار جداگانه تولید کن. برای `TELEGRAM_WEBHOOK_SECRET` هم مقدار جداگانه‌ای با حداقل ۲۴ کاراکتر بساز. رمز داشبورد را خودت انتخاب کن و از تکرار آن برای Secretهای دیگر خودداری کن.

### فایل `.dev.vars`

برای اجرای محلی می‌توانی فایل `worker/.dev.vars.example` را کپی کنی و نام آن را `.dev.vars` بگذاری. این فایل نباید Commit شود.

## ۷. Deploy کردن Worker

از پوشه `worker`:

```powershell
npx wrangler deploy
```

خروجی یک آدرس مشابه زیر می‌دهد:

```text
https://repoforge-worker.YOUR-SUBDOMAIN.workers.dev
```

آن را باز کن:

```text
https://YOUR-WORKER-URL.workers.dev/api/health
```

پاسخ صحیح باید شامل این مقادیر باشد:

```json
{
  "ok": true,
  "name": "RepoForge",
  "version": "2.0.0",
  "storage": "Cloudflare Workers KV",
  "r2Required": false,
  "planProfile": "workers-free"
}
```

اگر `STATE` یا Secretها تنظیم نشده باشند، در بخش‌های مرتبط خطای پیکربندی می‌بینی.

## ۸. اتصال URL نهایی Worker به Pages

بعد از Deploy:

1. آدرس Worker را در `config.js` در مقدار `apiBase` قرار بده.
2. Push کن.
3. صبر کن GitHub Actions، Pages را دوباره Deploy کند.
4. سایت را باز کن و با رمز `DASHBOARD_PASSWORD` وارد شو.

برای اطمینان از اتصال، Overview باید تعداد ریپوهای Allowlist، تعداد Jobها و Backupها را نشان دهد.

## ۹. ثبت Webhook ربات تلگرام

در PowerShell این دستورات را اجرا کن:

```powershell
$BotToken = Read-Host "Telegram bot token"
$WorkerUrl = Read-Host "Worker URL, without trailing slash"
$WebhookSecret = Read-Host "TELEGRAM_WEBHOOK_SECRET"

$body = @{
  url = "$WorkerUrl/telegram"
  secret_token = $WebhookSecret
  allowed_updates = @("message", "callback_query")
} | ConvertTo-Json -Depth 4

Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot$BotToken/setWebhook" `
  -ContentType "application/json" `
  -Body $body
```

بررسی Webhook:

```powershell
Invoke-RestMethod -Uri "https://api.telegram.org/bot$BotToken/getWebhookInfo"
```

URL باید با آدرس Worker و مسیر `/telegram` یکسان باشد. `last_error_message` نباید خطای جاری داشته باشد.

### ثبت دستورات BotFather

1. وارد `@BotFather` شو.
2. دستور `/setcommands` را ارسال کن.
3. ربات را انتخاب کن.
4. محتوای `BOT_COMMANDS.txt` را Paste کن؛ اسلش ابتدای command را وارد نکن.

## ۱۰. سناریوی تست اجباری

ابتدا یک ریپوی آزمایشی بساز و در `ALLOWED_REPOS` قرار بده. روی ریپوی مهم تست اول را انجام نده.

ساختار فعلی تست:

```text
README.md
keep-me.txt
remove-me.txt
```

ZIP تست:

```text
release-test/
├── README.md
├── new-file.txt
└── keep-me.txt
```

در داشبورد:

1. رمز را وارد کن.
2. ریپوی آزمایشی و branch موردنظر را انتخاب کن.
3. ZIP را انتخاب و Inspect کن.
4. `README.md` را Update، `keep-me.txt` را Keep و `remove-me.txt` را Delete انتخاب کن.
5. مطمئن شو `new-file.txt` به‌صورت New/Add نمایش داده می‌شود.
6. Save choices را بزن.
7. Deploy را بزن.
8. ابتدا Backup branch ساخته می‌شود؛ سپس Blobها جداگانه Upload می‌شوند و در آخر یک Commit منتشر می‌شود.
9. GitHub branch را بررسی کن.
10. از Backups، نسخه قبل از انتشار را Restore کن و commit بازگشت را بررسی کن.

در تست تلگرام:

1. `/select` را بفرست و ریپو و branch را انتخاب کن.
2. ZIP را به‌صورت Document ارسال کن.
3. روی لینک داشبورد بزن و وارد شو.
4. باید ZIP مرحله‌بندی‌شده به‌صورت خودکار در داشبورد باز و Preview ساخته شود.
5. با `/jobs` و `/files` وضعیت و تصمیم‌های فایل را در بات بررسی کن.
6. با `/deploy` فرایند را آغاز و از لینک داشبورد انتشار را کامل کن.

## ۱۱. محدودیت‌ها و نکات اجرایی

- Telegram Bot API رسمی دانلود ZIP بیش از ۲۰ MB را پشتیبانی نمی‌کند؛ برنامه ۱۹ MiB سقف گذاشته است.
- هر فایل حداکثر ۱ MiB و مجموع فایل‌های استخراج‌شده حداکثر ۱۶ MiB است.
- تعداد فایل‌های ZIP حداکثر ۴۰۰ و تغییرات هر Commit حداکثر ۱۰۰ است.
- Workers Free روزانه ۱۰۰۰ KV write دارد؛ یک آپلود با ۴۰۰ فایل به بخشی از این سهمیه نیاز دارد. برای ZIPهای کوچک‌تر یا فقط فایل‌های تغییریافته اقدام کن.
- Payloadهای فایل ۱۴ روز و ZIPهای مرحله‌بندی‌شده تلگرام یک ساعت نگه‌داری می‌شوند.
- Git backup در همان GitHub repository ساخته می‌شود؛ اگر شاخه Backup را دستی حذف کنی، Restore آن ممکن نیست.
- Worker CPU-limit را نمی‌توان با تنظیم `cpu_ms = 30000` دور زد؛ چنین تنظیمی در این پروژه استفاده نشده است.
- این نسخه کاملاً بدون R2 است.

## ۱۲. رفع اشکال

**GitHub Pages خطای 404 می‌دهد:**

- مطمئن شو Pages روی GitHub Actions است.
- در Actions، مرحله Upload Pages artifact را باز کن و ببین `dist/index.html` وجود دارد.
- آدرس دقیق ریپو `/repoforge/` است.

**Dashboard می‌گوید Worker URL تنظیم نیست:**

- مقدار `apiBase` در فایل ریشه `config.js` را بررسی کن.
- بعد از تغییر config مطمئن شو Pages دوباره Deploy شده است.

**Login خطای Origin not allowed می‌دهد:**

- `SITE_ORIGIN` باید دقیقاً `https://mehrdadmb2.github.io` باشد.
- مسیر `/repoforge/` را در `SITE_ORIGIN` وارد نکن.

**Repo list خالی است یا خطای GitHub 401/403 می‌بینی:**

- `GITHUB_TOKEN`، Owner، Repository access و Contents permission را بررسی کن.
- نام ریپو در `ALLOWED_REPOS` باید دقیقاً `owner/repo` باشد.

**Telegram پاسخ نمی‌دهد:**

- `getWebhookInfo` را اجرا کن.
- Secret Header، توکن BotFather و عدد `TELEGRAM_ADMIN_ID` را بررسی کن.
- ربات فقط در Private chat ادمین را می‌پذیرد.

**Deploy نیمه‌کاره متوقف شده:**

- از داشبورد همان Job را باز کن.
- اگر وضعیت `deploying` است، `Resume deployment` را بزن. Blobهای قبلی دوباره ارسال نمی‌شوند.
- اگر `stale` است، Refresh preview را بزن و تصمیم‌های فایل را دوباره بررسی کن.
- اگر Branch محافظت‌شده اجازه Push نمی‌دهد، خطای GitHub را بررسی کن؛ به‌صورت خودکار Force Push انجام نمی‌شود.

---

نسخه: `2.0.0` · Storage: `Workers KV` · Runtime target: `Cloudflare Workers Free`
