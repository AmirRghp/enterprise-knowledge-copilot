# پیکربندی محیط

منبع مقدار/validation API، [Settings](../apps/api/app/settings.py)؛ وب [server-config.ts](../apps/web/src/lib/server-config.ts) و Compose فایل‌های [اصلی](../compose.yaml) و [relay لینوکس](../compose.ollama-linux.yaml) است. فایل .env واقعی خوانده یا در مستندات کپی نمی‌شود؛ نمونهٔ بدون secret در [.env.example](../.env.example) است.

## قواعد

API فایل .env ریشه را می‌خواند؛ متغیر فرایند بر آن اولویت دارد. مقدار provider در env وارد تنظیم فعال نمی‌شود و فقط از DB/پنل مدیر می‌آید. وب فقط locationهای API_BASE_URL و WEB_ORIGIN را server-side می‌خواند؛ credential هرگز NEXT_PUBLIC_* نشود. تغییر زیرساخت معمولاً restart می‌خواهد؛ provider و تنظیمات مدیر runtime از DB خوانده می‌شوند.

## تنظیمات مؤثر موجود

| نام | default کد یا Compose | مصرف/قید |
|---|---|---|
| APP_ENCRYPTION_KEY | خالی | secret Fernet برای credential provider؛ با credential رمزدار لازم، جدا backup شود و بی‌طرح rotate نشود. |
| DB_HOST | 127.0.0.1 | API native؛ Compose مقدار postgres را تحمیل می‌کند. |
| DB_PORT | 5433 | ۱–۶۵۵۳۵؛ Compose درون‌شبکه 5432. |
| DB_NAME | enterprise_knowledge_copilot | allowlist: همین نام، enterprise_knowledge_copilot_test یا enterprise-pgvector؛ تست فقط نام آزمون. |
| DB_USER | enterprise_knowledge_copilot | نقش محدود DB؛ Compose همان را تحمیل می‌کند. |
| DB_PASSWORD | خالی | secret؛ برای اتصال/provision مقدار امن لازم است. |
| POSTGRES_PASSWORD | بدون default؛ Compose اجباری | secret bootstrap؛ فقط volume تازه؛ تغییر env رمز volume موجود را عوض نمی‌کند. |
| POSTGRES_HOST_PORT | 5434 | فقط publish loopback Compose؛ ربطی به DB_PORT داخل container ندارد. |
| API_BIND_HOST | 127.0.0.1 | فقط همین یا 0.0.0.0؛ Compose داخلی 0.0.0.0. |
| API_BASE_URL | http://127.0.0.1:8000 | مبدا API برای سرور وب؛ Compose http://api:8000؛ بدون path/query/credential. |
| WEB_ORIGIN | http://localhost:3000 | مبدا معتبر وب و cookie policy؛ URL صرف با http/https. |
| GENERATION_MAX_TOKENS | 4096 | ۱–۳۲۷۶۸؛ سقف completion، نه حذف validation. |
| GENERATION_REQUEST_TIMEOUT | 30 | ثانیه، بزرگ‌تر از صفر تا ۱۲۰؛ deadline کلی answer همچنان ۶۰ ثانیه. |
| SESSION_TTL_SECONDS | 28800 | ثانیه، مثبت. |
| LOGIN_RATE_PAIR_LIMIT | 5 | ۱–۱۰۰۰ در پنجره؛ IP/login. |
| LOGIN_RATE_IP_LIMIT | 30 | ۱–۱۰۰۰ در پنجره؛ peer IP. |
| LOGIN_RATE_WINDOW_SECONDS | 60 | ۱–۳۶۰۰. |
| LOGIN_RATE_MAX_KEYS | 10000 | ۲–۱۰۰۰۰۰؛ در اشباع fail-closed. |
| UPLOAD_MAX_BYTES | 1048576 | ۱ تا ۱۰۴۸۵۷۶؛ hard ceiling فعلی ۱ MiB است و با env بیشتر نمی‌شود. |
| UPLOAD_MAX_ACTIVE_DOCUMENTS | 100 | ۱–۱۰۰۰۰۰؛ افزایش فقط پس از سنجش ظرفیت. |
| UPLOAD_MAX_CURRENT_CHUNKS | 2000 | ۱–۱۰۰۰۰۰۰؛ طرح فعلی برای corpus کوچک ارزیابی شده است. |
| INGESTION_LEASE_SECONDS | 120 | ۱۰–۳۶۰۰ ثانیه. |
| INGESTION_LEASE_RENEW_SECONDS | 30 | ۱–۱۸۰۰ و کمتر از lease. |
| INGESTION_MAX_ATTEMPTS | 3 | ۱–۳؛ سقف schema جاری. |
| OLLAMA_RELAY_SOCKET | unset | فقط env فرایند/Compose اختیاری؛ سوکت private برای همان host.docker.internal:11434. |

POSTGRES_USER/POSTGRES_DB و EKC_DB_PASSWORD را bootstrap Compose به image/script می‌دهد؛ EKC_DB_PASSWORD نسخهٔ گذرای DB_PASSWORD برای provision است و تنظیم provider نیست. NODE_ENV، NEXT_TELEMETRY_DISABLED، HOSTNAME و PORT در Dockerfile وب برای فرایند container تعیین شده‌اند؛ تغییر عمومی آن‌ها جزو API Settings نیست.

## فیلدهای legacy که env آن‌ها فعال نیست

OPENROUTER_API_KEY، OPENROUTER_BASE_URL، OPENROUTER_MODEL، EMBEDDING_PROVIDER، OLLAMA_BASE_URL، OLLAMA_EMBED_MODEL، EMBEDDING_DIMENSION، EMBEDDING_MAX_TOKENS، EMBEDDING_TRUNCATE، OLLAMA_EMBED_DIGEST، RERANK_ENABLED، RERANK_PROVIDER و OPENROUTER_RERANK_MODEL در Settings برای قراردادهای داخلی/آزمون دیده می‌شوند؛ settings_customise_sources ورود آن‌ها از env/dotenv/secret-source را حذف می‌کند. استفاده از نام قدیمی در .env اتصال فعال نمی‌سازد. SEED_* و DATABASE_URL نیز قرارداد راه‌اندازی جاری نیستند.

## متغیرهای آینده

در برنامهٔ جدید هیچ flag OCR، OIDC، local-source یا telemetry به‌عنوان موجود وارد .env.example نمی‌شود. هر کارت تنظیم تازه باید نام، default، سقف، secret بودن، مصرف در native/Compose، اولویت و اثر restart را هم‌زمان ثبت کند. مقدار secret در پاسخ startup، command argv، shell history، artifact یا log چاپ نشود.
