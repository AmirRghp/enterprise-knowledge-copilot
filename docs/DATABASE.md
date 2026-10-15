# Database

> وضعیت: migrationهای `0001` تا `0010` تعریف شده‌اند؛ پذیرش هر پارت در [گزارش آزمون](TESTING.md) ثبت می‌شود. migration `0011` برای نام سازمان در پارت ۲۸ افزوده شده و پس از اعتبارسنجی فقط روی DB آزمون اعمال می‌شود.

Migration `0004` ستون nullable `provider_configs.temperature` را افزود: فقط اتصال‌های chat مقدار finite در بازهٔ ۰ تا ۲ دارند و مقدار پیش‌فرض/دادهٔ قبلی `0.7` است؛ برای purposeهای دیگر مقدار `NULL` می‌ماند. migration روی DB برنامه و آزمون اعمال شد.

## 1. Database Engine

**Database:** PostgreSQL 16 با افزونهٔ pgvector. اتصال embedding فعال بُعد را از آزمون اتصال می‌گیرد و index جاری را با همان بُعد یکنواخت نگه می‌دارد. در DB native برنامه، ۸۰ بردار جاری پس از بازسازی تأییدشده با Qwen بُعد ۱۰۲۴ دارند.

**Native hosting:** سرویس PostgreSQL موجود روی میزبان، پورت `5433`. برنامه به database اختصاصی `enterprise_knowledge_copilot` متصل می‌شود. در ۲۰۲۶-۱۰-۰۴ این database، database آزمون `enterprise_knowledge_copilot_test` و یک حساب محدود `enterprise_knowledge_copilot` روی همان سرویس موجود ساخته شدند؛ `pgvector 0.8.6` در هر دو فعال است. حساب کاربرد superuser، `CREATEDB` یا `CREATEROLE` ندارد و تنها مالک همین دو database است. اسکریپت idempotent آماده‌سازی در `apps/api/sql/provision.sql` است. تمام بررسی‌های مالکیت و مجوز پیش از هر تغییری اجرا می‌شوند و برخورد نام یا مالک غیرمنتظره، یا role با مجوز اضافی، با کد خروج غیرصفر و بدون هیچ تغییری متوقف می‌شود. رمز از بیرون از مخزن و از راه متغیر محیطی `EKC_DB_PASSWORD` داخل container به `psql` می‌رسد، نه از argv. پس از ایجاد role، اجرای پیش‌فرض هیچ تغییری نمی‌دهد و رمز را دست‌نخورده می‌گذارد؛ چرخش رمز فقط با `rotate_password=1` انجام می‌شود. اتصال native از `.env` ریشه با `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` خوانده می‌شود و `DATABASE_URL` قرارداد این پروژه نیست. در مسیر native همین دو نام استفاده می‌شوند؛ allowlist در `app/db/url.py` و `Settings.db_name` این نام‌ها و نام اختصاصی Compose را پیش از اتصال بررسی می‌کند.

**Docker Compose (نصب تازه):** سرویس PostgreSQL 16 با pgvector در volume مستقل Compose بالا می‌آید. پایگاه برنامه `enterprise-pgvector` و role برنامه همان `enterprise_knowledge_copilot` با دسترسی محدود است؛ رمز `POSTGRES_PASSWORD` برای bootstrap و `DB_PASSWORD` برای اتصال برنامه تنظیم می‌شود. درگاه میزبان از `POSTGRES_HOST_PORT` (پیش‌فرض `5434`) می‌آید و فقط روی loopback میزبان bind می‌شود؛ سرویس‌های Compose به `postgres:5432` وصل می‌شوند. پیکربندی Compose مقدارهای مؤثر DB را برای containerها override می‌کند و defaultهای native تغییر نمی‌کنند. bootstrap از همان `provision.sql` با نام پایگاه برنامهٔ جدید استفاده می‌کند؛ پایگاه مستقل `enterprise_knowledge_copilot_test` و افزونهٔ vector در هر دو نیز ساخته می‌شوند. allowlist تنظیمات و اتصال شامل هر سه نام است. Compose هیچ Ollama یا مدل embedding را bundle نمی‌کند؛ اتصال provider و API key در پنل مدیر و DB تنظیم می‌شوند. این volume جدید داده‌های سرویس native یا نصب قبلی را import نمی‌کند.

## 2. Naming Conventions

- **Tables:** نام انگلیسی و snake_case؛ جدول‌های دامنه با migrationهای افزایشی مدیریت می‌شوند. `organization_settings` تنظیم یکتای هر نصب را نگه می‌دارد.
- **Columns:** snake_case؛ نام‌های مفهومی `user_id`, `document_id`, `job_id`, `section_id`, `chunk_id`, `request_id`.
- **Primary Keys:** UUID برای موجودیت‌های داخلی؛ `document_id` از نوع text است تا شناسه‌های seed مانند `HR-001` حفظ شوند و شناسهٔ سند جدید می‌تواند UUID متنی سرور باشد؛ `section_id` شناسهٔ پایدار داخل سند است و کلید بخش با `document_id, revision, section_id` ترکیب می‌شود.
- **Foreign Keys:** نام ستون هم‌نام شناسهٔ مرجع؛ FKها صریح و با رفتار حذف محدود تعریف شوند. حذف/غیرفعال‌سازی دسترسی را فوری از query خارج می‌کند؛ cascade فقط برای دادهٔ مشتق و revision متعلق به همان سند قابل استفاده است.
- **Timestamps:** همهٔ زمان‌ها `timestamptz` به UTC: `created_at`, `updated_at`, `expires_at`, `lease_expires_at`, `started_at`, `finished_at`.
- **Revision:** مقدار opaque از نوع text؛ revisionهای seed موجود و SourceRef آن‌ها حفظ می‌شوند و revision تازه رشته‌ای است که سرور تولید می‌کند. target/current revision به همان سند تعلق دارند.
- **Enums/status:** مقادیر محدود با CHECK constraint یا enum migration-versioned؛ وضعیت‌ها در ادامه عیناً مشخص شده‌اند.
- **متن:** متن اصلی source برای نقل‌قول حفظ می‌شود؛ فیلد نرمال‌شدهٔ جست‌وجو مشتق است و جای متن اصلی را نمی‌گیرد.

## 3. Tables

### users

**Purpose:** حساب‌های محلی کارمند/مدیر و نقش جاری که در هر درخواست از DB خوانده می‌شود.

| Column | Type | Constraints / meaning |
|---|---|---|
| `user_id` | uuid | PK، تولید سرور |
| `login` | text | NOT NULL؛ login؛ ورودی تازه پس از trim/lowercase ذخیره می‌شود، مقادیر موجود حفظ می‌شوند |
| `first_name` | text | nullable؛ Part 22 migration `0006`؛ نام خالی/بیش از ۱۰۰ نویسه رد می‌شود |
| `last_name` | text | nullable؛ Part 22 migration `0006`؛ نام خالی/بیش از ۱۰۰ نویسه رد می‌شود |
| `password_hash` | text | NOT NULL؛ hash گذرواژه با Argon2id، نه گذرواژهٔ خام |
| `role` | text | NOT NULL، CHECK در `employee`, `manager` |
| `is_active` | boolean | NOT NULL، پیش‌فرض true |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

Migration `0005` unique expression index روی `lower(trim(login))` را اعمال کرد؛ loginهای کاربران موجود عیناً حفظ شدند و ورود تازه trim/lowercase می‌شود. Migration `0006` دو ستون nullable متنی `first_name` و `last_name` و قیدهای nullable-or-nonblank با سقف ۱۰۰ نویسه می‌افزاید؛ برای legacyها نام نمی‌سازد یا backfill نمی‌کند. فرم setup و ساخت مدیر نام‌های trimشدهٔ غیرخالی تا ۱۰۰ نویسه می‌گیرند. مسیر setup فقط وقتی هیچ ردیفی در `users` نیست مدیر نخست را می‌سازد و قفل تراکنشی از ساخت دو مدیر هم‌زمان جلوگیری می‌کند. مدیرهای بعدی از UI حساب می‌سازند. گذرواژهٔ تازه بین ۱۲ و ۵۱۲ نویسه است.

### sessions

**Purpose:** نشست‌های قابل ابطال؛ مقدار خام cookie در DB ذخیره نمی‌شود.

| Column | Type | Constraints / meaning |
|---|---|---|
| `session_id` | uuid | PK داخلی |
| `user_id` | uuid | NOT NULL، FK → `users.user_id`، ON DELETE CASCADE |
| `token_hash` | bytea | NOT NULL، UNIQUE؛ hash شناسهٔ تصادفی نشست |
| `created_at` | timestamptz | NOT NULL |
| `expires_at` | timestamptz | NOT NULL؛ مقدار پیشنهادی حداکثر ۸ ساعت پس از ایجاد |
| `revoked_at` | timestamptz | nullable؛ زمان خروج/ابطال |

فقط نشست revokeنشده و منقضی‌نشدهٔ کاربر فعال پذیرفته می‌شود. نقش و فعال‌بودن از `users` در هر درخواست خوانده می‌شوند و در session کپی نمی‌شوند. تغییر ایمیل، نقش، غیرفعال‌سازی یا گذرواژه همهٔ نشست‌های همان user را revoke می‌کند؛ تغییر نام نشست‌ها را حفظ می‌کند.

### organization_settings

Migration `0011` یک ردیف singleton برای نام سازمان همان نصب می‌سازد. نام trim‌شده بین ۱ تا ۱۰۰ نویسه است؛ نصب‌های قدیمی مقدار عمومی «فضای دانش سازمانی» می‌گیرند تا مدیر نام واقعی را در تنظیمات ثبت کند. downgrade فقط وقتی مقدار هنوز پیش‌فرض است مجاز است. این جدول مستقل از اسناد است و migration هیچ سند موجودی را تغییر یا حذف نمی‌کند.

### documents

**Purpose:** هویت سند، سیاست دسترسی، وضعیت محتوایی و اشاره‌گر revision جاری.

| Column | Type | Constraints / meaning |
|---|---|---|
| `document_id` | text | PK؛ seed IDهای فعلی حفظ می‌شوند؛ بارگذاری UI شناسهٔ UUID متنی تازه از سرور می‌گیرد |
| `title` | text | NOT NULL، غیرخالی پس از trim |
| `content_version` | text | NOT NULL؛ نسخهٔ اعلامی سند مثل `1.0`، جدا از revision سروری |
| `access_role` | text | NOT NULL، CHECK در `employee`, `manager`؛ حداقل نقش مجاز برای مشاهده |
| `current_revision` | text | nullable تا آماده‌شدن اولین نسخه؛ شناسهٔ revision opaque |
| `status` | text | NOT NULL، CHECK در `active`, `inactive`; فقط active می‌تواند وارد retrieval شود |
| `staged_access_role` | text | nullable، CHECK در `employee`, `manager`؛ سیاست revision در حال پردازش |
| `staged_title` | text | nullable؛ عنوان revision در حال پردازش، پس از trim خالی نباشد |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

فرمت، حجم و سقف سند در ورودی کنترل می‌شود. `access_role` فقط از metadata بازبینی‌شدهٔ مدیر می‌آید؛ front matter سند مجوز را تعیین نمی‌کند.
تا زمانی که `current_revision` NULL است، `content_version` مقدار ثابت `unpublished` است چون ستون NOT NULL است؛ در فعال‌سازی نخستین revision با نسخهٔ اعلامی همان سند (`version` در front matter یا `1.0`) جایگزین می‌شود. پارت ۸ این مسیر را در `apps/api/app/ingestion/store.py` پیاده کرد و با آزمون `test_upload_stages_a_document_with_no_current_revision` ثابت می‌کند که سند تا پیش از فعال‌سازی قابل بازیابی نیست.

پارت ۱۰ دو ستون `staged_access_role` و `staged_title` را با migration افزایشی `0002` افزود. هر دو nullable هستند و NULL یعنی «هیچ جایگزینی در جریان نیست»، پس سطرهای موجود و مصرف‌کننده‌های موجود معتبر می‌مانند. `access_role` و `title` مقادیر *مؤثر* revision جاری‌اند و هرگز نباید مقداری از revision فعال‌نشده را نگه دارند؛ به همین دلیل سیاست و عنوان در حال پردازس در ستون‌های جدا می‌نشینند. تفکیک دقیق این است: **باریک‌تر کردن دسترسی همین حالا روی `access_role` اعمال می‌شود** (چون withdrew کردن دسترسی نباید منتظر پردازش بماند) و **گسترش دسترسی و عنوان فقط در فعال‌سازی**، در همان تراکنشی که متن را منتشر می‌کند. باریک‌تر کردن در شکست جایگزینی برنمی‌گردد؛ این بده‌بستان آگاهانه است و در [امنیت](SECURITY.md) هم توضیح داده شده.

### ingestion_jobs

**Purpose:** وضعیت پردازش، retry و lease برای افزودن یا جایگزینی revision.

| Column | Type | Constraints / meaning |
|---|---|---|
| `job_id` | uuid | PK |
| `document_id` | text | NOT NULL، FK → `documents.document_id` |
| `target_revision` | text | NOT NULL، شناسهٔ opaque revision و یکتا به‌همراه سند |
| `operation` | text | NOT NULL، CHECK در `create`, `replace` |
| `status` | text | NOT NULL، CHECK در `pending`, `indexing`, `ready`, `failed` |
| `attempt_count` | smallint | NOT NULL، پیش‌فرض 0، CHECK در 0..3 |
| `source_text` | text | NOT NULL؛ متن بارگذاری‌شدهٔ staging برای resume/retry تا تکمیل job |
| `expected_current_revision` | text | nullable؛ revision جاری مورد انتظار هنگام شروع جایگزینی، برای compare-and-swap فعال‌سازی |
| `lease_owner` | text | nullable؛ شناسهٔ worker صاحب lease |
| `lease_token` | uuid | nullable؛ fencing token تازه برای هر claim/reclaim |
| `lease_expires_at` | timestamptz | nullable؛ lease پیشنهادی ۱۲۰ ثانیه، تمدید هر ۳۰ ثانیه |
| `safe_error` | text | nullable؛ توضیح قابل اقدام و غیرحساس |
| `created_at` | timestamptz | NOT NULL |
| `started_at` | timestamptz | nullable |
| `finished_at` | timestamptz | nullable |

قیود: UNIQUE (`document_id`, `target_revision`)، و CHECK که lease فقط با job در حال `indexing` معتبر باشد. parsing نامعتبر خطای دائمی است؛ خطاهای موقت حداکثر سه تلاش. تنها worker دارندهٔ lease می‌تواند ready/فعال‌سازی را commit کند. پارت ۸ این صف را در `apps/api/app/ingestion/store.py` ساخت: ادعا با `SELECT ... FOR UPDATE SKIP LOCKED` انجام می‌شود، هر ادعا و هر بازپس‌گیری یک `lease_token` تازه می‌سازد، و هر نوشتنِ staging و هر فعال‌سازی پیش از کار، همان سطر job را با `FOR UPDATE` دوباره می‌خواند و **هم توکن و هم انقضای lease را روی ساعت زندهٔ پایگاه‌داده** می‌سنجد (`lease_expires_at > clock_timestamp()`)، و پس از گرفتن قفل زمان را دوباره می‌خواند و انقضا را دوباره می‌سنجد؛ چون شرطِ ارزیابی‌شده پیش از انتظار روی قفل کافی نیست و `now()` در PostgreSQL زمان آغاز تراکنش است، نه زمان جاری. فعال‌سازی سه قفل را به‌ترتیب می‌گیرد (قفل مشورتی ناشر، ردیف job، ردیف `documents`)، بنابراین انقضا یک بار دیگر درست پیش از نخستین تغییر و پس از آخرین انتظار سنجیده می‌شود؛ ناهماهنگی باعث `LeaseLostError` و rollback بدون نوشتن می‌شود. فعال‌سازی در یک تراکنش، `expected_current_revision` را با compare-and-swap می‌سنجد، سه ستون lease را پاک می‌کند، و **سهمیهٔ قطعهٔ جاری را همان‌جا و زیر همان قفل مشورتیِ همهٔ ناشرها رزرو می‌کند**؛ بنابراین دو انتشار هم‌زمان نمی‌توانند هر دو زیر سقف پذیرفته شوند و رد شدن رزرو کل تراکنش را rollback می‌کند. در `0001` این قاعده با دو CHECK مکمل اعمال شد: در وضعیت `indexing` هر سه ستون lease باید پر باشند و در هر وضعیت دیگری هر سه باید NULL باشند؛ بنابراین worker هنگام commit کردن `ready` یا `failed` باید lease را پاک کند و دادهٔ fencing کهنه باقی نمی‌ماند.

### sections

**Purpose:** بخش‌های پاسخ‌پذیر سند در یک revision؛ section ID تا حد امکان میان جایگزینی‌ها پایدار می‌ماند.

| Column | Type | Constraints / meaning |
|---|---|---|
| `document_id` | text | NOT NULL، FK → `documents.document_id` |
| `revision` | text | NOT NULL، شناسهٔ opaque revision |
| `section_id` | text | NOT NULL؛ شناسهٔ پایدار در محدودهٔ سند |
| `ordinal` | integer | NOT NULL، CHECK `ordinal >= 0` |
| `title` | text | NOT NULL |
| `heading_path` | text[] | NOT NULL؛ مسیر عنوان‌ها |
| `source_text` | text | NOT NULL؛ متن اصلی قابل استناد |
| `search_text` | text | NOT NULL؛ متن مشتق و نرمال‌شده برای جست‌وجو |

**Primary key:** (`document_id`, `revision`, `section_id`). **Unique:** (`document_id`, `revision`, `ordinal`). هیچ section مرز قطعهٔ بین‌بخشی ندارد.

### chunks

**Purpose:** متن‌های retrieval و embedding متعلق به یک بخش/revision.

| Column | Type | Constraints / meaning |
|---|---|---|
| `chunk_id` | uuid | PK؛ با هر پردازش/نسخه chunk تازه |
| `document_id` | text | NOT NULL |
| `revision` | text | NOT NULL، شناسهٔ opaque revision |
| `section_id` | text | NOT NULL |
| `ordinal` | integer | NOT NULL، ترتیب داخل section، CHECK `ordinal >= 0` |
| `chunk_text` | text | NOT NULL؛ متن واقعی قابل بازیابی/استناد |
| `search_text` | text | NOT NULL؛ متن نرمال‌شدهٔ جست‌وجو |
| `embedding` | vector | nullable فقط تا تکمیل staging؛ dimension از provider فعال اندازه‌گیری می‌شود |
| `embedding_provider` | text | NOT NULL؛ نوع provider استفاده‌شده |
| `embedding_model` | text | NOT NULL؛ مدل/tag دقیق |
| `embedding_digest` | text | NOT NULL؛ برای Ollama digest pin‌شده؛ برای provider ابری خالی |
| `embedding_dimension` | smallint | NOT NULL، بین ۱ و ۱۶۰۰۰ و برابر dimension واقعی vector |
| `created_at` | timestamptz | NOT NULL |

**Foreign key:** (`document_id`, `revision`, `section_id`) → `sections` با حذف مشتق‌ها همراه revision. **Unique:** (`document_id`, `revision`, `section_id`, `ordinal`). هر chunk حداکثر ۱۲۰۰ نویسه و هم‌پوشانی ۱۵۰ نویسه فقط با chunk قبلی همان section دارد. Nomic با tokenizer خود و مدل‌های دیگر با بودجهٔ محافظه‌کارانهٔ ۴۰۰ بایت UTF-8 محدود می‌شوند؛ provider در صورت طول بیش‌ازحد خطا می‌دهد. Nomic همچنان `search_document:`/`search_query:` می‌گیرد؛ قالب query مدل‌های Qwen نیز فقط برای همان مدل اعمال می‌شود و ورودی providerهای ابری به‌صورت معمول ارسال می‌شود. فقط revision جاریِ آماده با embedding غیرnull قابل جست‌وجو است. CHECK سقف ۱۲۰۰ نویسهٔ chunk حفظ می‌شود؛ migration `0007` CHECK dimension را به بازهٔ ۱ تا ۱۶۰۰۰ تغییر می‌دهد و نوع vector دیگر روی ۷۶۸ ثابت نیست؛ migration `0008` برابری dimension ثبت‌شده با طول واقعی vector را در DB الزام می‌کند.

### request_runs

**Purpose:** telemetry کمینه و غیرمحتوایی برای خطا، زمان و بازتولید تنظیم retrieval.

| Column | Type | Constraints / meaning |
|---|---|---|
| `request_id` | uuid | PK |
| `user_id` | uuid | nullable، FK → `users.user_id`؛ برای اجرای بی‌نشست nullable |
| `status` | text | NOT NULL، CHECK در `answered`, `abstained`, `rejected`, `error`؛ مقادیر در migration `0001` تثبیت شدند |
| `started_at` | timestamptz | NOT NULL |
| `duration_ms` | integer | nullable، CHECK >= 0 |
| `config` | jsonb | NOT NULL؛ نسخهٔ کد/corpus/prompt، مدل‌ها، top-k، RRF و فیلتر مجوز؛ بدون secret |
| `candidate_refs` | jsonb | NOT NULL، پیش‌فرض `[]`؛ فقط شناسه/رتبهٔ candidateهای مجاز |
| `retry_count` | smallint | NOT NULL، پیش‌فرض 0، CHECK >= 0 |
| `error_code` | text | nullable؛ کد عمومی/غیرحساس |
| `input_tokens` | integer | nullable؛ null به معنی داده‌نداشتن است، نه صفر |
| `output_tokens` | integer | nullable |
| `cost` | numeric | nullable؛ null در نبود تعرفه یا مصرف ثبت‌شده |
| `provider_usage` | jsonb | NOT NULL، پیش‌فرض `[]`؛ رکوردهای مصرف provider برای همهٔ تلاش‌ها، بدون prompt و secret |

هر رکورد مصرف provider نام provider و مدل، تعداد تلاش، tokenهای ورودی/خروجی و هزینه را نگه می‌دارد؛ مقدارهای گزارش‌نشده `null` می‌مانند. پاسخ‌های شکست‌خورده نیز اگر provider پیش از خطا مصرفی گزارش کند در همین فهرست ثبت می‌شوند. واحد پولی providerهای مختلف با هم جمع نمی‌شود؛ هزینهٔ نامعلوم نیز null می‌ماند. artifactهای قدیمی ارزیابی بدون فیلدهای افزوده‌شده همچنان قابل خواندن و امتیازدهی مجدد هستند. متن پرسش، پاسخ، prompt، متن سند، نقل‌قول و secret ذخیره نمی‌شوند؛ artifact تفصیلی ارزیابی آفلاین جدا و با دسترسی محدود نگهداری می‌شود.

### provider_chains و provider_configs

`provider_chains` یک ردیف برای هر purpose از `chat`، `rerank` و `embedding` نگه می‌دارد؛ `version` برای compare-and-swap تغییرات، `enabled` وضعیت زنجیره، `active_provider_id` اتصال فعال embedding و `embedding_digest` digest Ollama جاری را نگه می‌دارند. برای provider ابری، fingerprint با provider/model/dimension ساخته می‌شود چون digest مدل ارائه نشده است.

`provider_configs` اتصال‌ها را با `provider_id`، purpose، نام نمایشی ۱ تا ۱۰۰ نویسه، نوع، مدل، URL، `expected_digest`، dimension آزموده‌شده، نسخهٔ اتصال، ترتیب و وضعیت آزمون ذخیره می‌کند. برای embedding نوع `openai`، `openrouter` یا `ollama` قابل انتخاب است و مدل identifier آزادانه وارد می‌شود؛ هر اتصال باید probe موفق داشته باشد و دقیقاً یک اتصال در زنجیره فعال است. ستون `temperature` فقط برای chat مقدار دارد: عدد finite در بازهٔ ۰ تا ۲؛ پیش‌فرض اتصال chat تازه و مقدار backfill اتصال‌های قبلی `0.7` است. برای purposeهای دیگر مقدار `NULL` نگهداری می‌شود. کلید API فقط به‌صورت `api_key_encrypted` رمز‌شده نگهداری می‌شود؛ migration هیچ اتصال providerی seed نمی‌کند. قفل ردیف زنجیره و `version` تغییر هم‌زمان را کنترل می‌کنند و قید یکتای deferred روی purpose/priority امکان جابه‌جایی اتمیک ترتیب را می‌دهد.

Migration `0007` برای index جدید `embedding_reindex_jobs` را با وضعیت‌های `pending/running/completed/failed` و شمار `completed/total` نگه می‌دارد؛ بردارهای مقصد تا پایان در `embedding_reindex_vectors` جدا از index فعال ذخیره می‌شوند. این جدول‌ها، provider فعال و بُعد آزموده‌شدهٔ آن، انتقال را پس از refresh/restart قابل بازیابی می‌کنند. تغییر مدل روی index موجود فقط پس از probe، نمایش تعداد chunkها و هشدار egress/هزینه، و تأیید صریح مدیر شروع می‌شود. cutover پس از آماده‌شدن همهٔ بردارهای باقی‌مانده اتمی است؛ خطا بردارهای جاری را نگه می‌دارد.

### system_prompts و system_prompt_settings

Migration `0009` متن prompt پایهٔ فعلی را در `system_prompts` ثبت می‌کند و آن را برای نصب فعال می‌گذارد. این ردیف `is_default=true`، مالک `NULL` و فقط‌خواندنی است. promptهای سفارشی `name` و `prompt_text` غیرخالی دارند؛ متن حداکثر ۱۶٬۰۰۰ نویسه است و `created_by` به مدیر سازنده اشاره می‌کند. `revision` برای تشخیص ویرایش کهنه است. `system_prompt_settings` دقیقاً یک ردیف دارد و `active_prompt_id` و `version` سراسری نصب را ثبت می‌کند. قفل این ردیف، ویرایش و جابه‌جایی prompt فعال را با compare-and-swap سریال می‌کند. downgrade اگر prompt سفارشی وجود داشته باشد عمداً متوقف می‌شود.

### rate_limit_settings

Migration `0010` یک ردیف با `singleton=true` می‌سازد. `requests_per_user_per_minute` بازهٔ ۱ تا ۱۰۰۰، `ollama_concurrency` و `cloud_concurrency` هرکدام بازهٔ ۱ تا ۱۰۰، و `version` حداقل ۱ دارند. پیش‌فرض به‌ترتیب ۶، ۱ و ۶ است. API با `UPDATE ... WHERE version = expected_version` و افزایش نسخه در یک statement تعارض ویرایش مدیرها را اتمیک به `409` تبدیل می‌کند. صف ۵۰ منتظر برای هر گروه ثابت کد است و در جدول ذخیره نمی‌شود. downgrade اگر مقادیر مدیر یا نسخهٔ تنظیمات تغییر کرده باشد متوقف می‌شود.

## 4. Relationships

- `users` → `sessions`: یک کاربر چند نشست دارد؛ هر نشست دقیقاً به یک کاربر تعلق دارد.
- `documents` → `ingestion_jobs`: هر سند چند job برای ایجاد/جایگزینی revision می‌تواند داشته باشد.
- `documents` → `sections`: هر سند در هر revision چند بخش دارد؛ کلید بخش شامل شناسهٔ سند و revision است.
- `sections` → `chunks`: هر بخش در یک revision چند chunk دارد؛ هر chunk دقیقاً یک بخش را مرجع می‌گیرد.
- `users` → `request_runs`: کاربر می‌تواند اجراهای متعدد داشته باشد؛ اجرای anonymous در صورت مجاز بودن `user_id=NULL` دارد.
- `users` → `system_prompts`: هر prompt سفارشی یک سازنده دارد؛ prompt پیش‌فرض مالک ندارد.
- `system_prompts` → `system_prompt_settings`: ردیف تنظیم شناسهٔ تنها prompt فعال را نگه می‌دارد.
- `documents.current_revision` به revision آماده‌ای اشاره می‌کند که در جداول `sections` و `chunks` همان `document_id` موجود است. این قید cross-table با تراکنش service/activation تضمین می‌شود و هنگام migration باید با FK مرکب/trigger یا منطق transactional صریح پیاده شود.

## 5. Constraints

**Required:** شناسه‌ها، login و hash گذرواژه، نقش/status، فرادادهٔ ضروری، متن اصلی بخش و متن chunk، شناسه/مدل embedding، timestamps و ارتباط‌های FK.

**Unique:** `users.login`، `sessions.token_hash`، (`document_id`, `target_revision`) در job، (`document_id`, `revision`, `section_id`) در section، و ordinal قطعه در بخش/نسخه.

**Foreign Keys:** session به user؛ job به document؛ section به document؛ chunk به composite key section؛ request run اختیاری به user. حذف user نشست‌ها را حذف می‌کند؛ حذف فیزیکی سند تا زمان تعیین سیاست پاک‌سازی ترجیح داده نمی‌شود.

**Domain checks:** role فقط `employee|manager`؛ document status فقط `active|inactive`؛ job operation فقط `create|replace`؛ job status فقط `pending|indexing|ready|failed`؛ revision متنی غیرخالی؛ ordinal و duration غیرمنفی؛ attempt بین صفر و سه. Migration `0007` قید بُعد ثابت ۷۶۸ را به بازهٔ ۱ تا ۱۶۰۰۰ تغییر داد و برای وضعیت و پیشرفت `embedding_reindex_jobs` قید افزود. Migration `0008` برابری `chunks.embedding_dimension` با بُعد واقعی بردار را کنترل می‌کند. هر دو روی DB برنامه و آزمون اعمال شدند؛ `alembic check` بدون اختلاف بود.

**Activation invariant:** revision تازه با شناسهٔ opaque تولیدشده در سرور تا وقتی همهٔ section/chunkها و بردارها آماده و worker هنوز صاحب lease است فعال نمی‌شود؛ fencing token و `expected_current_revision` باید هنگام فعال‌سازی اتمی کنترل شوند. اگر current revision از زمان آغاز job تغییر کرده باشد، فعال‌سازی رد می‌شود. جایگزینی ناموفق current revision را تغییر نمی‌دهد. سند غیرفعال، نسخهٔ staging یا دادهٔ فاقد embedding هرگز به retrieval وارد نمی‌شود. شناسهٔ revision محتوایی/seed مستقل از شمار ترتیبی revision است و شناسه‌های موجود seed در import حفظ می‌شوند.

پارت ۱۰ سه قاعدهٔ تازه به این invariant افزود و هرکدام آزمون دارد: فعال‌سازی سند `inactive` را رد می‌کند (delete هر job باز را ناموفق و lease آن را پاک می‌کند، پس این رد عمداً لایهٔ دوم است و قاعده در همین‌جا نگه داشته شده نه اینکه از سه تابع دیگر استنتاج شود)؛ در همان تراکنش فعال‌سازی، `staged_title` و `staged_access_role` به مقادیر مؤثر منتقل و سپس NULL می‌شوند؛ و `expected_current_revision` زیر قفل سطر `documents` خوانده می‌شود تا compare-and-swap دقیقاً همان مبنایی را بسنجد که جایگزینی بر پایهٔ آن ساخته شده.

**Identifier stability invariant:** `section_id` دستگیرهٔ استناد است، پس یک بخش که در جایگزینی باقی می‌ماند باید همان شناسه‌ای را نگه دارد که استنادهای موجود نام می‌برند. بخش‌های حفظ‌شده بر اساس **عنوان** تطبیق داده می‌شوند (اولین بخش ورودی با آن عنوان، شناسهٔ قبلی همان عنوان را می‌گیرد) و بخش تازه **بالاتر از بالاترین شناسه‌ای که آن سند تاکنون استفاده کرده** شناسه می‌گیرد. شناسهٔ آزادشده هرگز به بخش دیگری داده نمی‌شود، وگرنه استنادی که به بخش حذف‌شده اشاره می‌کرد بی‌صدا متن دیگری را نقل می‌کرد.

«بالاترین شناسه‌ای که تاکنون استفاده کرده» باید روی **همهٔ revisionهای آن سند** خوانده شود، نه فقط revision مبنا. سندی که زمانی `S1` و `S3` داشته و بعداً `S3` را از دست داده، مبنایی با بیشترین شناسهٔ `S1` دارد؛ خواندن mark از مبنا `S3` را دوباره به بخش تازه می‌دهد. `store.read_section_identity` هر دو پرسش را با هم می‌خواند و `stable_section_ids` در `apps/api/app/ingestion/sections.py` خالص و بدون I/O است. این قاعده به سیاست «ردیف‌های نسخهٔ منتشرشده حذف نمی‌شوند» وابسته است؛ اگر آن سیاست عوض شود، mark باید ذخیره شود نه اینکه بازمحاسبه شود.

**Logical delete invariant:** حذف سند فیزیکی نیست. `status` به `inactive` می‌رود و `current_revision` به آخرین revision منتشرشده اشاره می‌کند، پس متن و بردارهای نسخهٔ منتشرشده می‌مانند و تصمیم قابل بازگشت است. حذف idempotent است و برای شناسهٔ ناشناخته یا سند ازپیش حذف‌شده هم `204` می‌دهد. در یک تراکنش، هر job باز آن سند `failed` و lease آن پاک می‌شود (پس worker در حال اجرا در نوشتن بعدی‌اش متوقف می‌شود)، ستون‌های staging پاک می‌شوند، و ردیف‌های revisionهایی که هرگز منتشر نشدند حذف می‌شوند. **پیامد شناخته‌شده:** یک جایگزینی موفق، revision جایگزین‌شدهٔ قبلی را در جدول‌ها نگه می‌دارد، چون حذف آن با فلسفهٔ «نگه دار، حذف نکن» ناسازگار است؛ این ردیف‌ها در سهمیهٔ `count_current_chunks` حساب نمی‌شوند و بنابراین جدول‌ها با هر جایگزینی رشد می‌کنند. تعیین سیاست نگه‌داری این ردیف‌ها کار آینده است و در این پارت انجام نشده. مجموعهٔ jobها باید **زیر قفل سند** خوانده شود، وگرنه حذفی که هم‌زمان با staging اجرا می‌شود job تازه را نمی‌بیند و آن job روی سند حذف‌شده `pending` می‌ماند. ترتیب قفل در delete «قفل مشورتی ناشر، بعد سطر `documents`، بعد jobها» است: `activate_revision` قفل مشورتی را اول می‌گیرد، پس هرگز در حالی که این منتظر آن است سطر job را در اختیار ندارد، و ترتیب document-then-jobs اینجا با job-then-document آنجا چرخه نمی‌سازد. قفل مشورتی به‌تنهایی نکته نیست — `stage_replace` آن را نمی‌گیرد؛ چیزی که تصمیم staging را سریال می‌کند قفل سند است.

**Index consistency invariant:** هر chunk provider، مدل/tag، digest Ollama (در صورت کاربرد) و بُعد بردار خود را نگه می‌دارد. index فعال باید دقیقاً با provider/model/dimension جاری منطبق باشد؛ Ollama علاوه بر آن با digest pin می‌شود. providerهای ابری digest ندارند و با provider/model/dimension شناخته می‌شوند. مدل‌های مختلف در یک index فعال مخلوط نمی‌شوند. تغییر provider یا مدل روی index پُر، با job پایدار در جدول staging بازسازی می‌شود و فقط پس از آماده‌شدن همهٔ بردارها به‌صورت اتمی cutover می‌کند.

**Access invariant:** تمام queryها ابتدا با دامنهٔ مجاز role/current status ساخته می‌شوند و این دامنه بدون گسترش به BM25، vector search، rerank، prompt و منابع پاسخ منتقل می‌شود. مجوز و revision پیش از ارائهٔ منبع/پاسخ دوباره بررسی می‌شوند.

## 6. Indexes

حداقل indexهای پیشنهادی، پس از بررسی queryهای واقعی:

- unique expression index روی `lower(trim(users.login))` برای ایمیل ورود (Part 22 / migration `0005`).
- `sessions(token_hash)` unique و `sessions(user_id, expires_at)` برای نشست فعال؛ پاک‌سازی نشست منقضی سیاست جداگانه دارد.
- `documents(status, access_role, current_revision)` برای ساخت دامنهٔ مجاز.
- `ingestion_jobs(status, lease_expires_at, created_at)` برای یافتن job قابل claim و بازیابی lease منقضی.
- unique keyها و FKهای `sections` و `chunks` برای join بر document/revision/section و ترتیب chunk.
- اسکن برداری دقیق با pgvector در اندازهٔ corpus فعلی؛ ANN تا زمان رشد و اندازه‌گیری نیاز اضافه نشود.

پارت ۱۱ هیچ تغییری در schema نداد و از این فهرست چیزی نساخت: allowlist روی `documents.status`، `documents.access_role` و `documents.current_revision` و روی `chunks.revision` سوار است و وجود job `ready` با یک `EXISTS` فرعی روی `ingestion_jobs` سنجیده می‌شود، که با index بخش ۶ پوشش داده می‌شود. جست‌وجوی برداری exact scan است و از `chunks.embedding.cosine_distance` استفاده می‌کند. شرط `embedding IS NOT NULL` در **predicate مشترک** هر دو مسیر است، نه فقط در مسیر برداری؛ این invariant بخش ۵ می‌گوید دادهٔ فاقد embedding هرگز وارد retrieval نمی‌شود، و اگر شرط فقط در مسیر برداری باشد BM25 راه دور زدن آن است. ترتیب برداری با فاصله شروع می‌شود و `chunk_id` فقط شکست‌دهندهٔ تساوی است، چون `order_by` در SQLAlchemy به ترتیب قبلی اضافه می‌کند و یک `ORDER BY chunk_id` مشترک رتبه‌بندی را عملاً با UUID انجام می‌داد.

پارت ۱۲ هیچ تغییری در schema نداد. مصرف rerank در این جدول‌ها ثبت نمی‌شود؛ گزارش آن زنده از پاسخ provider خوانده می‌شود و در گزارش توسعه چاپ می‌شود. ثبت دائمی مصرف، کار پارت ۱۸ (ارزیابی) است که artifact اجرا را می‌سازد.

پارت ۱۱ همچنین invariant «سازگاری index» را در retrieval فعال کرد: پیش از هر رتبه‌بندی، متادیتای provider/مدل/digest/ابعاد دامنهٔ مجاز با provider فعال سنجیده می‌شود و هر ناسازگاری fail-closed است. این بررسی روی دامنهٔ مجاز محدود است، نه کل جدول، تا در دسترس‌بودن یک کاربر به ردیف‌هایی که حق ندارد بداند وجود دارند وابسته نشود.

**محدودیت طراحی که باید دانسته شود:** مسیر واژگانی BM25 در هر درخواست در حافظه اجرا می‌شود (قرارداد `technical-details.md`)، پس کل دامنهٔ مجاز را می‌خواند. `read_eligible_chunks` این کار را با سقف `MAX_LEXICAL_CHUNKS` (۵۰٬۰۰۰ قطعه) انجام می‌دهد و از آن عبور می‌کند **خطا می‌دهد**، نه اینکه بی‌صدا بریدد؛ بریدنِ بی‌صدا نتیجه‌ای برمی‌گرداند که کامل به نظر می‌رسد اما نیست. اگر corpus از این مرز بگذرد، تصمیم «ANN یا BM25 در پایگاه‌داده» یک تصمیم جداگانه و آگاهانه است، نه چیزی که در این پارت انجام شده باشد.
- هیچ BM25 index سراسری یا cache مشترک میان نقش‌ها ساخته نمی‌شود؛ BM25 هر درخواست روی متن قطعه‌های مجاز همان درخواست محاسبه می‌شود.

## 7. Data Validation

- شناسهٔ سند جدید در سرور تولید می‌شود؛ کارمند شناسه یا نقش دسترسی را تعیین نمی‌کند.
- بارگذاری MVP فقط Markdown/متن UTF-8 و سقف پیشنهادی 1 MiB؛ پسوند و محتوای خواندنی هر دو بررسی می‌شوند. فایل خام پس از parsing باقی نمی‌ماند.
- سقف آغازین ۱۰۰ سند فعال و ۲۰۰۰ chunk جاری در کل؛ chunking پس از parsing و پیش از provider call اندازه‌گیری می‌شود. هنگام جایگزینی، chunkهای revision جاری همان سند از سهمیه کم می‌شوند.
- پرسش حداکثر ۲۰۰۰ نویسه است؛ provider در صورت عبور از سقف خودش خطا می‌دهد و پرسش silently کوتاه نمی‌شود. برای بخش سند سقف chunk برابر ۱۲۰۰ نویسه با overlap ۱۵۰ نویسه فقط در همان section است؛ Nomic با tokenizer خود و مدل‌های دیگر با بودجهٔ محافظه‌کارانهٔ بایت سنجیده می‌شوند.
- prefix و قالب query فقط برای مدل‌هایی که نیاز دارند اعمال می‌شود: Nomic با `search_document:`/`search_query:` و مدل Qwen با قالب query مخصوص خودش؛ ورودی سایر مدل‌ها بدون قالب اختصاصی ارسال می‌شود.
- probe هر embedding provider بُعد خروجی را اندازه می‌گیرد و بردار باید دقیقاً همان تعداد مقدار finite داشته باشد. بُعد بین ۱ تا ۱۶۰۰۰ و با بردارهای تمام chunkهای index فعال یکسان است؛ mismatch یا NaN/Infinity رد می‌شود.
- متن اصلی section/chunk برای نمایش و quote حفظ می‌شود؛ نرمال‌سازی ی/ي، ک/ك، رقم‌ها، فاصله/نیم‌فاصله و نویسه‌های کنترلی فقط روی `search_text` اعمال می‌شود.
- پاسخ مدل به schema محدود است؛ هر claim باید SourceRef مجاز داشته باشد و quote دقیقاً در chunkهای فرستاده‌شده به مدل وجود داشته باشد. ادعای نامعتبر کل پاسخ را رد می‌کند؛ پس از حداکثر یک اصلاح در سقف دو تلاش، امتناع ثابت سمت سرور برمی‌گردد.

## 8. Soft Delete

**آیا حذف نرم استفاده می‌شود؟** برای سند بله: `documents.status='inactive'` دسترسی را فوراً از دامنهٔ retrieval خارج می‌کند. نسخه‌ها و chunkهای قبلی می‌توانند برای استناد به revision تا زمان تعیین سیاست نگهداری بمانند، اما مجوز جاری بر دسترسی به آن‌ها مقدم است. حذف فیزیکی/retention هنوز تصمیم عملیاتی ندارد و در نسخهٔ اول خودکار فرض نمی‌شود.

برای session از `revoked_at` استفاده می‌شود تا خروج قابل بازرسی باشد؛ رکوردهای منقضی/باطل بعداً طبق سیاست پاک‌سازی حذف می‌شوند. وضعیت `is_active=false` دسترسی را می‌بندد؛ Part 22 علاوه بر بررسی زنده در `resolve_actor`، همهٔ نشست‌های آن کاربر را هنگام غیرفعال‌سازی revoke می‌کند.

## 9. Auditing

- `created_at` و `updated_at` برای user/document و زمان‌های ایجاد، شروع و پایان برای job ثبت می‌شوند.
- `request_runs` اجرای عملیاتی را با status، زمان، تنظیمات غیرمحرمانه، رتبه/شناسهٔ candidate مجاز، retry و خطای عمومی ثبت می‌کند.
- تاریخچهٔ کامل تغییرات نقش، حذف‌کننده، متن درخواست/پاسخ یا activity log محصول در schema نسخهٔ اول وجود ندارد؛ افزودن آن تصمیم مجزا می‌خواهد.
- ثبت مصرف/هزینه nullable است؛ نبود داده null ثبت می‌شود، نه صفر. شناسهٔ secret هیچ‌گاه ثبت نمی‌شود.
- ارزیابی آفلاین ممکن است پاسخ/شواهد retrieval را در artifact محلی محدود نگه دارد؛ این داده در telemetry معمول DB ذخیره نمی‌شود.

## 10. Sensitive Data

**فیلدهای حساس:** `password_hash`, `sessions.token_hash`, متن اصلی سند، پرسش/پاسخ و quoteهای حاصل، `search_text`, `chunk_text`, بردارهای متن، تنظیمات اتصال DB و secretهای provider.

**حفاظت:** گذرواژه فقط Argon2id؛ cookie نشست `HttpOnly`, `Secure` در HTTPS و `SameSite=Lax`؛ فقط hash نشست در DB؛ secretها در محیط/مدیر اسرار و هرگز در Git، API response یا log. متن خام پرسش، prompt، پاسخ و سند وارد `request_runs` نمی‌شود. credential database با حداقل دسترسی و فقط برای `enterprise_knowledge_copilot` ساخته می‌شود. فایل‌های DB و `.env` محلی خارج از کنترل نسخه‌اند.

## 11. Migration Rules

تغییر schema باید:

1. در فایل versioned migration زیر `apps/api/alembic/versions/` ثبت و در `DATABASE.md` منعکس شود. prerequisiteهای cluster مانند افزونهٔ `vector` بخشی از migration نیستند و با `apps/api/sql/provision.sql` یک‌بار توسط superuser سرویس موجود ساخته می‌شوند؛ `alembic/env.py` پیش از اجرا وجود آن را بررسی و در صورت نبود با پیام روشن متوقف می‌شود.
2. روی DB اختصاصی native `enterprise_knowledge_copilot` یا DB اختصاصی Compose `enterprise-pgvector`، به‌علاوهٔ محیط توسعهٔ ایزوله، بررسی شود؛ connection string و نام database پیش از اجرای migration کنترل شوند.
3. با ترتیب سازگار (expand/migrate/contract در تغییرات ناسازگار) انجام شود و دادهٔ موجود را بی‌دلیل حذف یا بازنویسی نکند.
4. سازگاری dimension/model embedding را حفظ کند؛ تغییر مدل ابتدا index تازه را می‌سازد و فقط پس از آماده‌شدن همهٔ بردارها به‌صورت اتمی فعال می‌کند.
5. فقط پایگاه‌دادهٔ اختصاصی انتخاب‌شده برای همان حالت اجرا را تغییر دهد (`enterprise_knowledge_copilot` یا `enterprise-pgvector`)، نه `rag-postgres`/`rag_support` یا DB نامشخص؛ هیچ دستور drop/reset عمومی اجرا نشود.

فرمان‌های واقعی از پوشهٔ `apps/api`:

```bash
# آماده‌سازی یک‌باره؛ فقط objectهای جدید این پروژه را می‌سازد.
# رمز در فایل موقت 0600 می‌رود و با trap پاک می‌شود؛ هرگز در argv نیست.
umask 077
env_file="$(mktemp)"
trap 'rm -f "$env_file"' EXIT
printf 'EKC_DB_PASSWORD=%s\n' "$DB_PASSWORD" > "$env_file"
docker exec -i --env-file "$env_file" rag-postgres \
  psql -q -U rag -d postgres -v ON_ERROR_STOP=1 -f - < sql/provision.sql

# فقط بررسی، بدون هیچ تغییری
docker exec -i --env-file "$env_file" rag-postgres \
  psql -q -U rag -d postgres -v ON_ERROR_STOP=1 -v dry_run=1 -f - < sql/provision.sql

uv run --locked alembic upgrade head
uv run --locked alembic current
uv run --locked alembic check   # اختلاف model و migration باید خالی باشد
DB_NAME=enterprise_knowledge_copilot_test uv run --locked alembic upgrade head
```

پیش از هر migration، نام پایگاه‌داده با allowlist بررسی می‌شود؛ اجرای فرمان با `DB_NAME` دیگری با خطای پیکربندی متوقف می‌شود و هیچ اتصالی برقرار نمی‌شود. پیش از هر provisioning، مالکیت DBهای هدف و مجوزهای role نیز بررسی می‌شود؛ در صورت برخورد، اسکریپت بدون تغییر و با کد خروج غیرصفر متوقف می‌شود.

مدل‌های اعلانی در `apps/api/app/db/` هستند: `base.py` (MetaData و قرارداد نام‌گذاری قیدها)، `models.py` (مدل‌های schema)، `url.py` (ساخت URL و allowlist)، `engine.py` (engine و session factory) و `preflight.py` (بررسی پیش‌نیاز `vector`). `alembic check` دروازهٔ همگامی model و migration است؛ در ۲۰۲۶-۱۰-۰۴ روی پایگاه اختصاصی بدون اختلاف گزارش شد.

## 12. دادهٔ آغازین

در setup نخست، ایجاد مدیر، نشست و نام سازمان در یک تراکنش انجام می‌شود. migration `0011` جدول singleton `organization_settings` را با نام عمومی «فضای دانش سازمانی» می‌سازد تا ارتقای نصب موجود بدون تغییر اسناد و حساب‌ها انجام شود؛ مدیر می‌تواند نام واقعی را از تنظیمات تغییر دهد. نام سازمان ۱ تا ۱۰۰ نویسهٔ trim‌شده است.

نصب تازه هیچ سندی ندارد. مدیر اسناد سازمان را از `/manager/documents` بارگذاری می‌کند؛ شناسهٔ سند را سرور می‌سازد و metadata فایل مجوز ایجاد نمی‌کند. حساب‌ها با setup نخستین مدیر و سپس از پنل مدیر ساخته می‌شوند؛ فرمان قدیمی seed حساب بازنشسته است و `SEED_*` دیگر پیکربندی لازم نیست. مقصد CLIها فقط دو database مستقل `enterprise_knowledge_copilot` و `enterprise_knowledge_copilot_test` است و با `DB_NAME` صریح انتخاب می‌شود. ساخت databaseها و حساب محدود با `apps/api/sql/provision.sql` مستقل از setup حساب برنامه است.
