# راه‌اندازی کامل RepoForge — راهنمای فارسی ویندوز

این راهنما برای اولین Deploy پروژه نوشته شده است. پیشنهاد می‌کنم راه‌اندازی را دقیقاً به ترتیب زیر انجام بدهی و اولین تست را روی یک ریپوی آزمایشی انجام بدهی، نه روی پروژه‌ی اصلی.

## ۰. پیش‌نیازها

- یک حساب GitHub و دسترسی به ریپوهایی که می‌خواهی مدیریت کنی.
- یک حساب Cloudflare با Workers، KV و R2.
- Node.js نسخه LTS و npm.
- Wrangler CLI از طریق `npx wrangler`.
- یک ربات تلگرام ساخته‌شده با BotFather.
- یک ریپوی GitHub به نام `repoforge` برای نگه‌داری سورس این پروژه.

> نکته مهم: برای پردازش ZIP و انتشار چندفایلی، Workers Paid با CPU limit مناسب توصیه می‌شود. پلن Free فقط ۱۰ میلی‌ثانیه CPU برای هر درخواست دارد و ممکن است برای استخراج ZIP یا انتشار واقعی کافی نباشد. مقدار `cpu_ms = 30000` در فایل Wrangler برای پلنی است که این حد را پشتیبانی کند.

## ۱. ساخت ریپوی پروژه در GitHub

1. در GitHub یک Repository با نام `repoforge` بساز.
2. پیشنهاد می‌کنم ریپو Public باشد تا GitHub Pages بدون محدودیت پلن قابل استفاده باشد؛ سورس داشبورد شامل هیچ کلید محرمانه‌ای نیست.
3. فایل‌های این پروژه را در شاخه `main` قرار بده.
4. مطمئن شو فایل `.github/workflows/pages.yml` هم آپلود شده است.

## ۲. ساخت PAT محدود برای GitHub

از مسیر GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens یک توکن بساز.

تنظیمات پیشنهادی:

- **Token name:** `RepoForge Worker`
- **Expiration:** مطابق سیاست چرخش کلید خودت؛ توکن بدون تاریخ انقضا پیشنهاد نمی‌شود.
- **Resource owner:** حساب مالک ریپوها.
- **Repository access:** فقط ریپوهای مورد نیاز؛ گزینه‌ی All repositories را انتخاب نکن.
- **Repository permissions:**
  - `Metadata`: Read-only
  - `Contents`: Read and write
  - `Workflows`: Read and write فقط اگر قرار است فایل‌های داخل `.github/workflows/` را هم از ZIP جایگزین کنی.

برای عملیات اصلی RepoForge یعنی خواندن درخت فایل، ساخت Blob، ساخت Tree و Commit و جابه‌جایی Ref، مجوز `Contents: Read and write` لازم است. نیازی به مجوزهای Account administration یا حذف ریپوها نیست.

پس از ساخت، توکن را کپی کن. GitHub معمولاً مقدار کامل آن را فقط یک بار نشان می‌دهد.

## ۳. ساخت KV و R2 در Cloudflare

در PowerShell یا CMD وارد پوشه پروژه شو:

```powershell
cd path\to\repoforge\worker
```

نصب وابستگی‌ها:

```powershell
npm install
```

ساخت فضای KV:

```powershell
npx wrangler kv namespace create STATE
```

خروجی دستور یک `id` شبیه شناسه‌ی namespace نشان می‌دهد. آن را کپی کن و در فایل `worker/wrangler.toml` مقدار زیر را جایگزین کن:

```toml
[[kv_namespaces]]
binding = "STATE"
id = "PASTE_YOUR_KV_NAMESPACE_ID_HERE"
```

ساخت باکت R2:

```powershell
npx wrangler r2 bucket create repoforge-archives
```

نام باکت باید دقیقاً با `bucket_name = "repoforge-archives"` در `wrangler.toml` یکسان باشد.

در پنل Cloudflare برای باکت R2 یک Lifecycle Rule بساز تا Objectهای زیر مسیر `uploads/` پس از ۱۴ روز حذف شوند. ZIPهای آپلودشده در R2 قرار می‌گیرند و متادیتای Job در KV ذخیره می‌شود.

## ۴. تنظیم Origin داشبورد

پس از فعال‌کردن Pages، آدرس داشبورد معمولاً به یکی از این شکل‌هاست:

```text
https://YOUR_USERNAME.github.io
https://YOUR_USERNAME.github.io/repoforge/
```

در Worker فقط Origin را تنظیم کن؛ مسیر `/repoforge/` نباید وارد شود. برای مثال:

```toml
[vars]
SITE_ORIGIN = "https://YOUR_USERNAME.github.io"
```

اگر از چند دامنه برای داشبورد استفاده می‌کنی، Originها را با کاما از هم جدا کن:

```toml
SITE_ORIGIN = "https://YOUR_USERNAME.github.io,https://dashboard.example.com"
```

## ۵. ساخت ربات تلگرام

1. در تلگرام وارد `@BotFather` شو.
2. دستور `/newbot` را ارسال کن.
3. نام نمایشی `RepoForge Manager` را وارد کن.
4. نام کاربری پیشنهادی `RepoForgeManagerBot` را امتحان کن. آزاد بودن این نام تضمین‌شده نیست.
5. توکن ربات را در جایی امن نگه دار.
6. برای دریافت شناسه عددی اکانت، از یک ربات معتبر نمایش User ID استفاده کن و عدد مربوط به حساب خودت را بردار. این مقدار با Username یا شماره تلفن فرق دارد.

### ثبت دستورات در BotFather

در BotFather دستور `/setcommands` را اجرا کن و ربات را انتخاب کن. سپس محتوای فایل `BOT_COMMANDS.txt` را کپی کن. در BotFather هر خط باید دقیقاً با الگوی `command - description` باشد؛ `/` ابتدای command را ننویس.

## ۶. ثبت Secretهای Worker

در پوشه `worker` و در PowerShell دستورات زیر را اجرا کن. هر دستور مقدار را به‌صورت تعاملی می‌گیرد:

```powershell
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ALLOWED_REPOS
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_ADMIN_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put SESSION_SECRET
```

مقدار هر Secret:

| Secret | مقداری که باید وارد کنی |
|---|---|
| `GITHUB_TOKEN` | توکن Fine-grained ساخته‌شده در مرحله ۲ |
| `ALLOWED_REPOS` | لیست دقیق ریپوها با فرمت `owner/repo,owner/another-repo` |
| `TELEGRAM_BOT_TOKEN` | توکن BotFather |
| `TELEGRAM_ADMIN_ID` | شناسه عددی شخصی که تنها مدیر ربات است |
| `TELEGRAM_WEBHOOK_SECRET` | یک رشته تصادفی طولانی شامل حروف انگلیسی، عدد، `_` یا `-` |
| `DASHBOARD_PASSWORD` | رمز عبور مستقل و قوی برای داشبورد وب؛ حداقل ۱۲ کاراکتر |
| `SESSION_SECRET` | کلید تصادفی حداقل ۳۲ کاراکتر برای امضای نشست‌ها |

برای ساخت یک Session Secret تصادفی در PowerShell:

```powershell
$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$SessionSecret = [Convert]::ToHexString($bytes)
$SessionSecret
```

خروجی را به دستور `npx wrangler secret put SESSION_SECRET` بده. برای `TELEGRAM_WEBHOOK_SECRET` هم از یک مقدار تصادفی جداگانه با حداقل ۲۴ کاراکتر استفاده کن. شناسه ادمین تلگرام باید یک عدد خالص باشد. هرگز یک رمز را برای چند Secret تکرار نکن.

نمونه مقدار `ALLOWED_REPOS`:

```text
YOUR_USERNAME/repoforge,YOUR_USERNAME/project-alpha,YOUR_USERNAME/project-beta
```

هر ریپویی که در allowlist نباشد، حتی با داشتن PAT، توسط RepoForge پذیرفته نمی‌شود.

## ۷. انتشار Worker با Wrangler

ابتدا `wrangler.toml` را بررسی کن:

- `name = "repoforge-worker"`
- شناسه واقعی KV در `id` قرار گرفته باشد.
- نام R2 درست باشد.
- `SITE_ORIGIN` با Origin دقیق سایت یکسان باشد.
- `MAX_CHANGED_FILES` فعلاً روی ۲۵ باقی بماند و `MAX_REMOTE_FILES` را مطابق اندازه ریپوها تنظیم کن.

سپس:

```powershell
npm run check
npx wrangler deploy
```

خروجی Deploy آدرس Worker را نمایش می‌دهد، مثلاً:

```text
https://repoforge-worker.YOUR-SUBDOMAIN.workers.dev
```

سلامت Worker را بررسی کن:

```text
https://YOUR-WORKER-URL.workers.dev/api/health
```

باید JSON با `"ok": true` دریافت کنی.

## ۸. اتصال GitHub Pages به Worker

فایل `site/config.js` را باز کن و آدرس Worker را جایگزین کن:

```javascript
window.REPOFORGE_CONFIG = {
  apiBase: "https://repoforge-worker.YOUR-SUBDOMAIN.workers.dev"
};
```

هیچ Token، Password یا Secret دیگری نباید در این فایل قرار بگیرد.

سپس در GitHub وارد ریپوی `repoforge` شو:

1. Settings → Pages
2. در بخش Build and deployment گزینه **GitHub Actions** را انتخاب کن.
3. مطمئن شو Workflow با نام `Deploy RepoForge dashboard to GitHub Pages` اجرا شده است.
4. پس از پایان موفق، آدرس Pages را باز کن.
5. رمز داشبورد را وارد کن و اتصال را آزمایش کن.

اگر ریپوی پروژه نام `repoforge` دارد، آدرس معمولاً `https://YOUR_USERNAME.github.io/repoforge/` است؛ ولی `SITE_ORIGIN` همچنان فقط `https://YOUR_USERNAME.github.io` خواهد بود.

## ۹. اتصال Webhook تلگرام

پس از Deploy شدن Worker، در PowerShell:

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

برای بررسی Webhook:

```powershell
Invoke-RestMethod -Uri "https://api.telegram.org/bot$BotToken/getWebhookInfo"
```

در پاسخ، URL باید با آدرس Worker و مسیر `/telegram` یکسان باشد و `last_error_message` نباید خطای فعال داشته باشد.

## ۱۰. اولین تست عملی — حتماً روی ریپوی آزمایشی

یک ریپوی آزمایشی بساز که این فایل‌ها را داشته باشد:

```text
README.md
keep-me.txt
remove-me.txt
```

حالا یک ZIP آزمایشی بساز:

```text
release-test/
├── README.md
├── new-file.txt
└── keep-me.txt
```

در ZIP متن `README.md` را تغییر بده و `new-file.txt` را اضافه کن. فایل `remove-me.txt` را داخل ZIP قرار نده.

در داشبورد:

1. ریپو و شاخه را انتخاب کن.
2. ZIP را آپلود کن.
3. `README.md` باید `Update` باشد.
4. `new-file.txt` باید `Update` باشد.
5. `keep-me.txt` را روی `Keep` بگذار.
6. `remove-me.txt` باید به‌عنوان Repository-only نمایش داده شود؛ آن را روی `Delete` بگذار.
7. گزینه Save choices و سپس Deploy را بزن.
8. در GitHub باید یک Commit واحد و یک شاخه‌ی `repoforge-backup-*` ببینی.
9. از بخش Backups همان نسخه را Restore کن و نتیجه را بررسی کن.

## ۱۱. رفع ایرادهای رایج

**خطای 401 در داشبورد:** نشست منقضی شده یا Origin در `SITE_ORIGIN` درست نیست. از داشبورد خارج شو و دوباره وارد شو.

**خطای CORS:** مقدار `SITE_ORIGIN` باید دقیقاً Origin سایت باشد؛ `https://` لازم است و نباید مسیر `/repoforge/` در آن قرار بگیرد. بعد از تغییر Vars دوباره Worker را Deploy کن.

**ریپو در فهرست نیست:** نام `owner/repo` باید داخل `ALLOWED_REPOS` باشد و PAT نیز باید به همان ریپو دسترسی داشته باشد. Permission مربوط به Metadata را بررسی کن.

**خطای GitHub 403:** مجوز Contents: Read and write، دسترسی PAT به ریپو و انقضای توکن را بررسی کن. برای فایل‌های Workflow، مجوز Workflows هم ممکن است لازم باشد.

**خطای Branch protection:** شاخه مقصد اجازه‌ی Push مستقیم نمی‌دهد. RepoForge عمداً Force Push نمی‌کند. برای آن شاخه باید سیاست Branch protection را متناسب با این روش تغییر بده یا در نسخه بعدی مسیر Pull Request را پیاده‌سازی کنی.

**خطای Worker CPU یا 1102:** حجم ZIP، تعداد فایل‌ها و مقدار `MAX_CHANGED_FILES` را کاهش بده یا از Workers Paid با CPU limit بالاتر استفاده کن. محدودیت RAM ایزوله همچنان ۱۲۸ MB است.

**خطای Telegram در دریافت فایل:** فایل باید ZIP باشد و از سقف تنظیم‌شده‌ی RepoForge بیشتر نباشد. Telegram Bot API برای دانلود فایل محدودیت ۲۰ MB دارد؛ مقدار پیش‌فرض RepoForge پایین‌تر از آن است.

**Webhook کار نمی‌کند:** Secret Header را بررسی کن، خروجی `getWebhookInfo` را بخوان و اطمینان بگیر `TELEGRAM_WEBHOOK_SECRET` در Cloudflare با مقداری که هنگام `setWebhook` استفاده شده، یکسان است.

## ۱۲. نکات مهم قبل از استفاده روی پروژه‌های اصلی

- هر بار قبل از انتشار، فایل‌های حساس مثل `.env`، کلیدهای خصوصی، فایل‌های تنظیمات محیطی و داده‌های شخصی را بررسی کن.
- هیچ ZIP ناشناخته‌ای را بدون بررسی روی ریپوهای مهم Deploy نکن.
- برای اولین بار قابلیت Restore را روی یک شاخه آزمایشی تست کن.
- شاخه‌های `repoforge-backup-*` را پاک نکن مگر اینکه از حذف آن Snapshot مطمئن باشی.
- Public بودن GitHub Pages یعنی سورس داشبورد قابل مشاهده است؛ امنیت عملیات از Worker و Secretها می‌آید، نه مخفی بودن JavaScript.
