# Database

> وضعیت: schema نسخهٔ اول در ۲۰۲۶-۱۰-۰۴ به‌صورت migration `0001` روی پایگاه اختصاصی `enterprise_knowledge_copilot` پیاده‌سازی و اجرا شد؛ هفت جدول این سند در آن پایگاه وجود دارند. این فایل همراه با [معماری](ARCHITECTURE.md) قرارداد دادهٔ پروژه است؛ این دو سند مرجع قرارداد جاری‌اند. پایگاه‌داده باید مستقل از database دیگر باشد. Part 4 احراز هویت سروری را در محیط محلی اضافه کرده است؛ بنابراین وضعیت دادهٔ کاربر/نشست ممکن است پس از اجرای seed و auth تغییر کند. قابلیت‌های ingestion و RAG هنوز پیاده نشده‌اند.

## 1. Database Engine

**Database:** PostgreSQL 16.15 با افزونهٔ pgvector 0.8.6 برای بردارهای embedding با بُعد 768.

**Hosting:** سرویس PostgreSQL موجود روی میزبان، پورت `5433`. برنامه به database اختصاصی `enterprise_knowledge_copilot` متصل می‌شود. در ۲۰۲۶-۱۰-۰۴ این database، database آزمون `enterprise_knowledge_copilot_test` و یک حساب محدود `enterprise_knowledge_copilot` روی همان سرویس موجود ساخته شدند؛ `pgvector 0.8.6` در هر دو فعال است. حساب کاربرد superuser، `CREATEDB` یا `CREATEROLE` ندارد و تنها مالک همین دو database است. اسکریپت idempotent آماده‌سازی در `apps/api/sql/provision.sql` است. تمام بررسی‌های مالکیت و مجوز پیش از هر تغییری اجرا می‌شوند و برخورد نام یا مالک غیرمنتظره، یا role با مجوز اضافی، با کد خروج غیرصفر و بدون هیچ تغییری متوقف می‌شود. رمز از بیرون از مخزن و از راه متغیر محیطی `EKC_DB_PASSWORD` داخل container به `psql` می‌رسد، نه از argv. پس از ایجاد role، اجرای پیش‌فرض هیچ تغییری نمی‌دهد و رمز را دست‌نخورده می‌گذارد؛ چرخش رمز فقط با `rotate_password=1` انجام می‌شود. اتصال native از `.env` ریشه با `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` خوانده می‌شود و `DATABASE_URL` قرارداد این پروژه نیست. سرویس DB تازه در Compose نسازید. مقصد اتصال در کد با allowlist روی همین دو نام محدود است: `app/db/url.py` پیش از ساخت URL نام پایگاه‌داده را بررسی می‌کند و `Settings.db_name` فقط همین دو مقدار را می‌پذیرد. هیچ database دیگری را تغییر ندهید.

## 2. Naming Conventions

- **Tables:** نام انگلیسی، snake_case و جمع؛ هفت جدول این سند تنها جداول دامنهٔ نسخهٔ اول‌اند.
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
| `login` | text | NOT NULL، UNIQUE، شناسهٔ ورود نرمال‌شده |
| `password_hash` | text | NOT NULL؛ hash گذرواژه با Argon2id، نه گذرواژهٔ خام |
| `role` | text | NOT NULL، CHECK در `employee`, `manager` |
| `is_active` | boolean | NOT NULL، پیش‌فرض true |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

حساب نمونه فقط با seed/CLI محلی و ورودی امن ایجاد می‌شود؛ ثبت‌نام عمومی و ارتقای نقش از UI وجود ندارد.

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

فقط نشست revokeنشده و منقضی‌نشده پذیرفته می‌شود. نقش از `users` خوانده می‌شود و در session کپی نمی‌شود.

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
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

فرمت، حجم و سقف سند در ورودی کنترل می‌شوند. `access_role` فقط از metadata بازبینی‌شدهٔ مدیر می‌آید؛ front matter سند مجوز را تعیین نمی‌کند.

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

قیود: UNIQUE (`document_id`, `target_revision`)، و CHECK که lease فقط با job در حال `indexing` معتبر باشد. parsing نامعتبر خطای دائمی است؛ خطاهای موقت حداکثر سه تلاش. تنها worker دارندهٔ lease می‌تواند ready/فعال‌سازی را commit کند. در `0001` این قاعده با دو CHECK مکمل اعمال شد: در وضعیت `indexing` هر سه ستون lease باید پر باشند و در هر وضعیت دیگری هر سه باید NULL باشند؛ بنابراین worker هنگام commit کردن `ready` یا `failed` باید lease را پاک کند و دادهٔ fencing کهنه باقی نمی‌ماند.

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
| `embedding` | vector(768) | nullable فقط تا تکمیل staging؛ بردار Nomic 768بعدی |
| `embedding_provider` | text | NOT NULL؛ نسخهٔ اول `ollama` |
| `embedding_model` | text | NOT NULL؛ مدل/tag دقیق |
| `embedding_digest` | text | NOT NULL؛ digest ثبت‌شدهٔ مدل Ollama؛ مقدار live-check فعلی `ff9c2f10ef5e` |
| `embedding_dimension` | smallint | NOT NULL، CHECK برابر 768 |
| `created_at` | timestamptz | NOT NULL |

**Foreign key:** (`document_id`, `revision`, `section_id`) → `sections` با حذف مشتق‌ها همراه revision. **Unique:** (`document_id`, `revision`, `section_id`, `ordinal`). هر chunk حداکثر ۱۲۰۰ نویسه، حداکثر ۴۰۰ token و هم‌پوشانی ۱۵۰ نویسه فقط با chunk قبلی همان section دارد. embedding سند با `search_document:` و embedding پرسش با `search_query:` ساخته می‌شود؛ درخواست Ollama باید `truncate:false` داشته باشد تا truncation بی‌صدا رخ ندهد؛ chunking با tokenizer منطبق بر مدل انجام می‌شود، نه تخمین نویسه‌ای. فقط revision جاریِ آماده با embedding غیرnull قابل جست‌وجو است. سقف ۱۲۰۰ نویسه علاوه بر توکن‌آگاه بودن chunker با CHECK `ck_chunks_chunk_text_char_limit` نیز در `0001` اعمال شد تا قطعهٔ بیش‌ازحد بلند هرگز قابل جست‌وجو نشود؛ بُعد بردار هم با `ck_chunks_embedding_dimension_768` روی ۷۶۸ تثبیت شده است.

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
| `provider_usage` | jsonb | NOT NULL، پیش‌فرض `[]`؛ مصرف/واحد/تعرفه/ارز nullable برای همهٔ تلاش‌ها، بدون prompt و secret |

متن پرسش، پاسخ، prompt، متن سند، نقل‌قول و secret در این جدول ذخیره نمی‌شوند. artifact تفصیلی ارزیابی آفلاین جدا و با دسترسی محدود نگهداری می‌شود.

## 4. Relationships

- `users` → `sessions`: یک کاربر چند نشست دارد؛ هر نشست دقیقاً به یک کاربر تعلق دارد.
- `documents` → `ingestion_jobs`: هر سند چند job برای ایجاد/جایگزینی revision می‌تواند داشته باشد.
- `documents` → `sections`: هر سند در هر revision چند بخش دارد؛ کلید بخش شامل شناسهٔ سند و revision است.
- `sections` → `chunks`: هر بخش در یک revision چند chunk دارد؛ هر chunk دقیقاً یک بخش را مرجع می‌گیرد.
- `users` → `request_runs`: کاربر می‌تواند اجراهای متعدد داشته باشد؛ اجرای anonymous در صورت مجاز بودن `user_id=NULL` دارد.
- `documents.current_revision` به revision آماده‌ای اشاره می‌کند که در جداول `sections` و `chunks` همان `document_id` موجود است. این قید cross-table با تراکنش service/activation تضمین می‌شود و هنگام migration باید با FK مرکب/trigger یا منطق transactional صریح پیاده شود.

## 5. Constraints

**Required:** شناسه‌ها، login و hash گذرواژه، نقش/status، فرادادهٔ ضروری، متن اصلی بخش و متن chunk، شناسه/مدل embedding، timestamps و ارتباط‌های FK.

**Unique:** `users.login`، `sessions.token_hash`، (`document_id`, `target_revision`) در job، (`document_id`, `revision`, `section_id`) در section، و ordinal قطعه در بخش/نسخه.

**Foreign Keys:** session به user؛ job به document؛ section به document؛ chunk به composite key section؛ request run اختیاری به user. حذف user نشست‌ها را حذف می‌کند؛ حذف فیزیکی سند تا زمان تعیین سیاست پاک‌سازی ترجیح داده نمی‌شود.

**Domain checks:** role فقط `employee|manager`؛ document status فقط `active|inactive`؛ job operation فقط `create|replace`؛ job status فقط `pending|indexing|ready|failed`؛ revision متنی غیرخالی؛ ordinal و duration غیرمنفی؛ attempt بین صفر و سه. در `0001` این موارد افزوده شدند و باید به‌عنوان تصمیم پذیرفته‌شده مرور شوند: `request_runs.status` فقط `answered|abstained|rejected|error`؛ `title` و `content_version` سند پس از trim خالی نباشند؛ `target_revision` خالی نباشد؛ `chunks.chunk_text` حداکثر ۱۲۰۰ نویسه و `chunks.embedding_dimension` برابر ۷۶۸ باشد؛ و قید lease در `ingestion_jobs`. مجموع CHECKهای فعال در schema فعلی ۲۰ است.

**Activation invariant:** revision تازه با شناسهٔ opaque تولیدشده در سرور تا وقتی همهٔ section/chunkها و بردارها آماده و worker هنوز صاحب lease است فعال نمی‌شود؛ fencing token و `expected_current_revision` باید هنگام فعال‌سازی اتمی کنترل شوند. اگر current revision از زمان آغاز job تغییر کرده باشد، فعال‌سازی رد می‌شود. جایگزینی ناموفق current revision را تغییر نمی‌دهد. سند غیرفعال، نسخهٔ staging یا دادهٔ فاقد embedding هرگز به retrieval وارد نمی‌شود. شناسهٔ revision محتوایی/seed مستقل از شمار ترتیبی revision است و شناسه‌های موجود seed در import حفظ می‌شوند.

**Index consistency invariant:** هر chunk provider، مدل/tag، digest و بعد بردار خود را نگه می‌دارد. پیش از query، mixed/stale digest یا dimension در index موجب fail-closed می‌شود. تغییر digest مدل `:latest` نیازمند بازتولید کل index همین پروژه در staging و تعویض اتمی است؛ هیچ بردار با دو digest در یک index فعال مخلوط نمی‌شود.

**Access invariant:** تمام queryها ابتدا با دامنهٔ مجاز role/current status ساخته می‌شوند و این دامنه بدون گسترش به BM25، vector search، rerank، prompt و منابع پاسخ منتقل می‌شود. مجوز و revision پیش از ارائهٔ منبع/پاسخ دوباره بررسی می‌شوند.

## 6. Indexes

حداقل indexهای پیشنهادی، پس از بررسی queryهای واقعی:

- `users(login)` از نوع unique برای ورود.
- `sessions(token_hash)` unique و `sessions(user_id, expires_at)` برای نشست فعال؛ پاک‌سازی نشست منقضی سیاست جداگانه دارد.
- `documents(status, access_role, current_revision)` برای ساخت دامنهٔ مجاز.
- `ingestion_jobs(status, lease_expires_at, created_at)` برای یافتن job قابل claim و بازیابی lease منقضی.
- unique keyها و FKهای `sections` و `chunks` برای join بر document/revision/section و ترتیب chunk.
- اسکن برداری دقیق با pgvector در اندازهٔ corpus فعلی؛ ANN تا زمان رشد و اندازه‌گیری نیاز اضافه نشود.
- هیچ BM25 index سراسری یا cache مشترک میان نقش‌ها ساخته نمی‌شود؛ BM25 هر درخواست روی متن قطعه‌های مجاز همان درخواست محاسبه می‌شود.

## 7. Data Validation

- شناسهٔ سند جدید در سرور تولید می‌شود؛ کارمند شناسه یا نقش دسترسی را تعیین نمی‌کند.
- بارگذاری MVP فقط Markdown/متن UTF-8 و سقف پیشنهادی 1 MiB؛ پسوند و محتوای خواندنی هر دو بررسی می‌شوند. فایل خام پس از parsing باقی نمی‌ماند.
- سقف آغازین ۱۰۰ سند فعال و ۲۰۰۰ chunk جاری در کل؛ chunking پس از parsing و پیش از provider call اندازه‌گیری می‌شود. هنگام جایگزینی، chunkهای revision جاری همان سند از سهمیه کم می‌شوند.
- پرسش حداکثر ۲۰۰۰ نویسه است و باید در سقف token مدل نیز باشد؛ پرسش بیش‌ازحد بلند با درخواست کوتاه‌سازی رد می‌شود، truncate یا به چند query تقسیم نمی‌شود. برای بخش سند، سقف chunk برابر ۱۲۰۰ نویسه با overlap ۱۵۰ نویسه فقط در همان section است؛ افزون بر آن، tokenizer منطبق با مدل باید chunk را به حداکثر ۴۰۰ token محدود کند؛ تخمین تقریبی قابل قبول نیست.
- مدل `nomic-embed-text-v2-moe:latest` سقف ۵۱۲ token دارد؛ ورودی embedding با `truncate:false` ارسال می‌شود تا ورودی بلند خطا دهد، نه اینکه متن پنهانی بریده شود. هر chunk سند prefix `search_document:` و پرسش prefix `search_query:` می‌گیرد.
- خروجی embedding باید دقیقاً ۷۶۸ مقدار عددی finite داشته باشد؛ مقدار خالی، NaN/Infinity، مدل/بُعد ناسازگار یا بردار ناقص رد می‌شود.
- متن اصلی section/chunk برای نمایش و quote حفظ می‌شود؛ نرمال‌سازی ی/ي، ک/ك، رقم‌ها، فاصله/نیم‌فاصله و نویسه‌های کنترلی فقط روی `search_text` اعمال می‌شود.
- پاسخ مدل به schema محدود است؛ هر claim باید SourceRef مجاز داشته باشد و quote دقیقاً در chunkهای فرستاده‌شده به مدل وجود داشته باشد. ادعای نامعتبر کل پاسخ را رد می‌کند؛ پس از حداکثر یک اصلاح در سقف دو تلاش، امتناع ثابت سمت سرور برمی‌گردد.

## 8. Soft Delete

**آیا حذف نرم استفاده می‌شود؟** برای سند بله: `documents.status='inactive'` دسترسی را فوراً از دامنهٔ retrieval خارج می‌کند. نسخه‌ها و chunkهای قبلی می‌توانند برای استناد به revision تا زمان تعیین سیاست نگهداری بمانند، اما مجوز جاری بر دسترسی به آن‌ها مقدم است. حذف فیزیکی/retention هنوز تصمیم عملیاتی ندارد و در نسخهٔ اول خودکار فرض نمی‌شود.

برای session از `revoked_at` استفاده می‌شود تا خروج قابل بازرسی باشد؛ رکوردهای منقضی/باطل بعداً طبق سیاست پاک‌سازی حذف می‌شوند. برای user، `is_active=false` حساب را از ورود و نشست‌های بعدی خارج می‌کند؛ اثر نشست‌های فعال در resolve_actor باید بررسی شود.

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
2. روی DB اختصاصی `enterprise_knowledge_copilot` و محیط توسعهٔ ایزوله بررسی شود؛ connection string و نام database پیش از اجرای migration کنترل شوند.
3. با ترتیب سازگار (expand/migrate/contract در تغییرات ناسازگار) انجام شود و دادهٔ موجود را بی‌دلیل حذف یا بازنویسی نکند.
4. سازگاری dimension/model embedding را حفظ کند؛ تغییر مدل ابتدا index تازه را می‌سازد و فقط پس از آماده‌شدن همهٔ بردارها به‌صورت اتمی فعال می‌کند.
5. هرگز schema یا دادهٔ پایگاه‌داده‌ای جز `enterprise_knowledge_copilot` را تغییر ندهد؛ هیچ دستور drop/reset عمومی برای اتصال نامشخص اجرا نشود.

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

مدل‌های اعلانی در `apps/api/app/db/` هستند: `base.py` (MetaData و قرارداد نام‌گذاری قیدها)، `models.py` (هفت جدول)، `url.py` (ساخت URL و allowlist)، `engine.py` (engine و session factory) و `preflight.py` (بررسی پیش‌نیاز `vector`). `alembic check` دروازهٔ همگامی model و migration است؛ در ۲۰۲۶-۱۰-۰۴ روی پایگاه اختصاصی بدون اختلاف گزارش شد.

## 12. Seed Data

دادهٔ corpus ساختگی موجود در پوشهٔ `corpus/` برای import آزمایشی/دمو است. ورود اولیه فقط از CLI مدیریتی مجزا انجام می‌شود، شناسه‌های seed را حفظ می‌کند و schema/متن ورودی را اعتبارسنجی می‌کند. UI بارگذاری سند تازه شناسه را از سرور می‌گیرد؛ کارمند نمی‌تواند سند یا نقش بسازد.

دو حساب نمونهٔ `employee` و `manager` فقط در محیط محلی از seed/CLI و ورودی امن محیطی ساخته می‌شوند؛ مقدار گذرواژه در فایل seed، مخزن یا log قرار نمی‌گیرد. CLI فقط دو مقصد مستقل `enterprise_knowledge_copilot` و `enterprise_knowledge_copilot_test` را می‌پذیرد؛ مقصد باید جداگانه و صریح با `DB_NAME` انتخاب شود و پیش از اتصال اعتبارسنجی می‌شود. این مسیر CLI راهکار seed محیط production نیست. ساخت خود databaseها و حساب محدود پیش از این seed و جدا از آن با `apps/api/sql/provision.sql` انجام می‌شود. وضعیت یا مقدار credential محلی را در مستندات ثبت نکنید.
