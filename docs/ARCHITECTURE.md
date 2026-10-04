# Architecture

> وضعیت: طرح پیشنهادی برای پیاده‌سازی نسخهٔ اول؛ در مخزن فعلی برنامه یا API اجراشده‌ای وجود ندارد. این سند مرجع معماری جاری در کنار PRD، DATABASE و SECURITY است. [راهنمای ارزیابی](evaluation-guide.md) سند تکمیلی سنجش کیفیت است؛ نسخه‌های قدیمی مشخصات و طرح فنی در archive فقط برای سابقه نگهداری می‌شوند. هرجا این اسناد هنوز تصمیم محصولی نداده‌اند، انتخاب زیر پیش‌فرض فنی پیشنهادی است و نتیجهٔ تست یا تضمین عملیاتی محسوب نمی‌شود.

## 1. System Overview

دستیار دانش سازمانی سپهر داده یک برنامهٔ وب فارسی و راست‌به‌چپ برای پرسش از اسناد داخلی است. رابط Next.js از مسیر same-origin درخواست‌ها را به API در FastAPI می‌فرستد. FastAPI هویت و مجوز را بررسی می‌کند، اسناد را در PostgreSQL می‌خواند، بازیابی واژگانی و معنایی را اجرا می‌کند و برای تولید پاسخ مستند از OpenRouter استفاده می‌کند. PostgreSQL 16.15 موجود روی میزبان با pgvector 0.8.6 از طریق پورت 5433 در دسترس است؛ برنامه باید به پایگاه‌دادهٔ مستقل `enterprise_knowledge_copilot` متصل شود.

Embedding محلی با Ollama روی `localhost:11434` و مدل `nomic-embed-text-v2-moe:latest` انجام می‌شود. این مدل بردار 768بعدی تولید می‌کند؛ digest live-check تأییدشدهٔ مدل `ff9c2f10ef5e` در پیکربندی ثبت می‌شود؛ پرسش با پیشوند `search_query:` و متن سند با `search_document:` ارسال می‌شود. OpenRouter rerank اختیاری و به‌طور پیش‌فرض غیرفعال است (`RERANK_ENABLED=false`) و مدل نمونهٔ آن `nvidia/llama-nemotron-rerank-vl-1b-v2:free` است.

## 2. Architecture Pattern

**Pattern:** یکپارچهٔ ماژولار (modular monolith)، با Next.js و FastAPI به‌عنوان دو فرایند برنامه و یک پایگاه‌دادهٔ PostgreSQL. worker ورود سند در همان برنامهٔ API اجرا می‌شود؛ صف یا سرویس مجزای Redis/Celery در نسخهٔ اول وجود ندارد.

**Reason:** مرزهای ماژولی هویت، اسناد، بازیابی و پاسخ روشن می‌مانند، در حالی که اجرای محلی و تراکنش فعال‌سازی نسخه پیچیدگی سرویس‌های توزیع‌شده را ندارد. frontend و API مرز شبکهٔ مشخصی دارند و اتصال به مدل‌ها پشت adapter قرار می‌گیرد.

## 3. Technology Stack

| حوزه | انتخاب پیشنهادی | پیکربندی/مرز |
|---|---|---|
| Frontend | Next.js و TypeScript | رابط فارسی RTL؛ درخواست مرورگر فقط به پراکسی same-origin در Route Handler |
| Backend | FastAPI و Python 3.12 | API و worker ingestion در یک سرویس؛ یک فرایند و یک کار هم‌زمان ingestion در نسخهٔ اول |
| Database | PostgreSQL 16.15 موجود روی میزبان با pgvector | میزبان از پورت 5433؛ پایگاه‌دادهٔ جدید `enterprise_knowledge_copilot` |
| Authentication | نشست تصادفی در کوکی و گذرواژهٔ Argon2id | hash نشست در DB؛ عمر پیشنهادی ۸ ساعت؛ نقش از رکورد کاربر خوانده می‌شود |
| Storage | متن UTF-8 و دادهٔ مشتق‌شده در PostgreSQL | فایل خام پس از parsing نگهداری نمی‌شود؛ فایل‌های DB و محیط محلی وارد Git نمی‌شوند |
| Hosting | اجرای native روی میزبان توسعه | Next.js و FastAPI؛ این طرح برای DB سرویس جدید Compose تعریف نمی‌کند |
| Generation | OpenRouter با مدل قابل تنظیم | مقدار آغازین پیشنهادی `OPENROUTER_MODEL=google/gemini-2.5-flash`؛ نیازمند smoke test پیش از اتکا |
| Embeddings | Ollama محلی | `EMBEDDING_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://localhost:11434`, `OLLAMA_EMBED_MODEL=nomic-embed-text-v2-moe:latest`, `EMBEDDING_DIMENSION=768`, `EMBEDDING_MAX_TOKENS=512`, `EMBEDDING_TRUNCATE=false` |
| Reranking | OpenRouter اختیاری | مدل `nvidia/llama-nemotron-rerank-vl-1b-v2:free`؛ خاموش به‌صورت پیش‌فرض؛ تنها نامزدهای مجاز را می‌گیرد و همان کلید generation را مصرف می‌کند |
| Payments / Email / Analytics | ندارد | خارج از محدودهٔ نسخهٔ اول |

تنظیمات اتصال native از `.env` در ریشهٔ مخزن با نام‌های `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` خوانده می‌شود؛ `DATABASE_URL` قرارداد این پروژه نیست. تنظیم generation با `OPENROUTER_API_KEY` و `OPENROUTER_MODEL`، embedding با `EMBEDDING_PROVIDER`, `OLLAMA_BASE_URL`, `OLLAMA_EMBED_MODEL`, `EMBEDDING_DIMENSION`, `EMBEDDING_MAX_TOKENS`, `EMBEDDING_TRUNCATE` و rerank با `RERANK_ENABLED`, `RERANK_PROVIDER=openrouter` و `OPENROUTER_RERANK_MODEL` انجام می‌شود؛ rerank از همان `OPENROUTER_BASE_URL` و `OPENROUTER_API_KEY` استفاده می‌کند. مقادیر secret در `.env` محلی یا مدیر اسرار محیط اجرا می‌مانند و فقط نام متغیرهای جایگزین‌شونده در `.env.example` درج می‌شود. ساخت پایگاه‌داده و کاربر/مجوز اتصال هنوز انجام نشده است؛ تا آن زمان مقادیر اتصال باید placeholder باشند. مقصد اتصال باید به‌صورت allowlist روی `enterprise_knowledge_copilot` محدود شود؛ نام/دادهٔ پایگاه‌های دیگر را تغییر ندهید.

## 4. System Components

### Frontend

مسئولیت‌ها:

- ارائهٔ ورود، گفتگو، نمایش پاسخ و منابع تا سطح بخش، و صفحات فهرست/وضعیت اسناد مدیر.
- نگه‌داشتن تجربهٔ فارسی و RTL و نمایش خطای عمومی قابل اقدام بدون افشای جزئیات داخلی.
- عبور درخواست از Route Handler هم‌مبدأ؛ حذف هدرهای نقش/هویت ساخته‌شده توسط کاربر و کنترل Origin برای درخواست‌های تغییردهنده.
- نمایش فقط پاسخ ساخته‌شده از claims اعتبارسنجی‌شده و امتناع‌های ثابت سمت سرور؛ متن آزاد مدل مستقیماً نمایش داده نمی‌شود.

### Backend

مسئولیت‌ها:

- احراز نشست، بارگذاری نقش جاری، اعمال مجوز در لایهٔ route و service و تولید دامنهٔ اسناد مجاز سمت سرور.
- اعتبارسنجی بارگذاری، ساخت job، پردازش بخش‌ها و قطعه‌ها، embedding، staging و فعال‌سازی اتمی نسخهٔ آماده.
- اجرای BM25 و جست‌وجوی برداری فقط روی مجموعهٔ مجاز همان درخواست، ادغام رتبه با RRF و rerank اختیاری.
- تولید JSON مقید، اعتبارسنجی دقیق ارجاع/نقل‌قول، بررسی دوبارهٔ مجوز و revision پیش از تحویل کامل پاسخ؛ پاسخ stream نمی‌شود.
- ثبت فرادادهٔ اجرای غیرحساس، خطاهای سیاستی و زمان‌ها؛ عدم ثبت متن خام پرسش، پاسخ، prompt یا سند در `request_runs`.

### Database

مسئولیت‌ها:

- نگهداری کاربران، نشست‌ها، سند و revision جاری، jobهای ingestion، بخش‌ها، قطعه‌ها و بردارهای 768بعدی.
- اعمال کلیدهای خارجی، یکتایی و قیود سازگاری revision/section/chunk؛ نگهداری فرادادهٔ مجاز اجرا بدون متن محتوایی.
- اتصال فقط به پایگاه‌دادهٔ allowlistشدهٔ `enterprise_knowledge_copilot` روی PostgreSQL میزبان.

### Provider adapters

Embedding، generation و reranking از رابط‌های مجزا فراخوانی می‌شوند. مدل/endpoint از محیط تنظیم می‌شود؛ خطا یا timeout باعث انتخاب پنهانی provider جایگزین نمی‌شود. adapter embedding باید پیشوندهای جست‌وجوی Nomic را اعمال کند و ابعاد خروجی را 768 اعتبارسنجی کند.

قرارداد API پیشنهادی (همه پشت پراکسی same-origin):

| مسیر | دسترسی و نتیجه |
|---|---|
| `POST /api/auth/login` | عمومی با Origin معتبر؛ ایجاد نشست |
| `POST /api/auth/logout` | ابطال نشست |
| `GET /api/auth/me` | هویت و نقش جاری سروری |
| `POST /api/answers` | کارمند/مدیر؛ پاسخ کامل مستند یا امتناع |
| `GET /api/documents` | فقط فهرست اسناد آماده و مجاز |
| `GET /api/sources/{document_id}/sections/{section_id}?revision=...` | بررسی مجوز و revision جاری؛ 404 عمومی برای ناموجود/غیرمجاز |
| `GET, POST /api/manager/documents` | مدیر؛ فهرست پردازش یا بارگذاری |
| `PUT, DELETE /api/manager/documents/{document_id}` | مدیر؛ جایگزینی یا حذف منطقی فوری |
| `GET /api/manager/jobs/{job_id}` | مدیر؛ وضعیت پردازش غیرحساس |
| `GET /api/health` | وضعیت سلامت عمومی بدون credential یا اطلاعات DB |

خروجی عمومی پاسخ فقط `answer, claims, sources, abstained, request_id` است؛ retrieval hits و usage داخلی به client نروند. قرارداد استناد `SourceRef(document_id: str, section_id: str, revision: str)` است.


## 5. Architecture Diagram

```text
مرورگر فارسی (Next.js / RTL)
        │ same-origin /api/*، کوکی نشست
        ▼
Next.js Route Handler ──► FastAPI modular monolith
                              ├── Auth / authorization
                              ├── Documents / ingestion worker
                              ├── Hybrid retrieval / answer validation
                              ├── Ollama localhost:11434 (embedding 768d)
                              ├── OpenRouter (generation; model configurable)
                              └── OpenRouter rerank (اختیاری، پیش‌فرض خاموش)
                                        │
                                        ▼
                          PostgreSQL 16 host:5433
                         DB: enterprise_knowledge_copilot
```

این دیاگرام معماری پیشنهادی است. پیاده‌سازی DB در Compose ایجاد نمی‌کند؛ API و web به سرویس‌های native میزبان متصل می‌شوند.

## 6. Data Flow

### پرسش و پاسخ

1. کاربر پرسش را در UI می‌فرستد و Route Handler آن را از مسیر same-origin به FastAPI می‌رساند.
2. API نشست را با hash موجود در DB حل می‌کند و نقش جاری را از کاربر می‌خواند؛ هیچ role ارسالی از مرورگر معتبر نیست.
3. سرویس، دامنهٔ اسناد فعال، جاری، آماده و مجاز را در همان درخواست می‌سازد.
4. نسخهٔ نرمال‌شدهٔ پرسش به BM25 همان دامنه و Ollama با پیشوند `search_query:` می‌رود. هر مسیر حداکثر ۲۰ candidate می‌دهد؛ اجتماع حداکثر ۴۰ نامزد با RRF و `k=60` ادغام می‌شود.
5. در صورت تنظیم صریح rerank، حداکثر ۲۰ candidate مجاز به آن فرستاده می‌شود؛ پیش‌فرض خاموش است. حداکثر پنج قطعه/بخش برتر برای زمینه انتخاب می‌شود.
6. OpenRouter با مدل تنظیم‌شده JSON محدودشده به schema ادعا/نقل‌قول/SourceRef تولید می‌کند. backend ارجاع‌ها و نقل‌قول دقیق را با متن chunkهای واقعاً ارسال‌شده تطبیق می‌دهد.
7. backend مجوز جاری و revision را دوباره بررسی می‌کند. تغییر مجوز/نسخه باعث عدم تحویل پاسخ می‌شود. UI پاسخ اعتبارسنجی‌شده یا امتناع ثابت را نمایش می‌دهد.

قرارداد generation: `response_format` با JSON Schema و `provider.require_parameters=true`؛ پشتیبانی واقعی مدل منتخب بعد از درج کلید با smoke test بررسی شود. هر claim باید quote دقیق و SourceRef از قطعه‌های واقعاً ارسال‌شده داشته باشد. متن نهایی سمت سرور از claimهای معتبر و پیام‌های ثابت ساخته می‌شود؛ متن آزاد مدل یا missing_parts آزاد نمایش داده نشود. هر ادعای نامعتبر کل payload را رد می‌کند؛ حداکثر یک repair در سقف مشترک دو تلاش generation و deadline 60 ثانیه، سپس امتناع خنثی. timeout/خطای شبکه خطای عملیاتی است. تطبیق quote و schema صحت معنایی ادعا را ثابت نمی‌کند؛ ارزیابی انسانی لازم است.


### ورود یا جایگزینی سند

1. مدیر فایل Markdown یا متن UTF-8 را بارگذاری می‌کند؛ backend اعتبار، فراداده، حجم، سند/قطعه و سقف‌های محصول را پیش از فراخوانی provider بررسی می‌کند.
2. job با وضعیت `pending` ثبت می‌شود. یک worker می‌گیرد و lease ۱۲۰ثانیه‌ای را هر ۳۰ ثانیه تمدید می‌کند؛ حداکثر سه تلاش دارد.
3. متن و مرز عنوان‌ها حفظ می‌شود. هر chunk حداکثر ۱۲۰۰ نویسه و هم‌پوشانی ۱۵۰ نویسه دارد و هرگز از section عبور نمی‌کند. علاوه بر این سقف نویسه، chunker باید با tokenizer منطبق بر مدل، متن هر قطعه را به حداکثر ۴۰۰ token محدود کند؛ تخمین تقریبی پذیرفته نیست.
4. embedding برای هر قطعه با `search_document:` درخواست می‌شود. چون سقف token مدل Nomic برابر ۵۱۲ است، ارسال متن خام بلند با `truncate:false` انجام می‌شود تا ورودی بلند بی‌صدا بریده نشود؛ برش به‌وسیلهٔ chunker توکن‌آگاه در حد ۴۰۰ token انجام می‌شود.
5. محتوا و بردارهای revision جدید در staging نوشته می‌شوند. فقط پس از تکمیل همهٔ قطعه‌ها، یک تراکنش revision تازه را جاری می‌کند و revision قبلی را از جست‌وجو خارج می‌سازد.
6. شکست جایگزینی revision جاری قبلی را حفظ می‌کند. حذف/کاهش مجوز، سند را فوراً از دامنهٔ مجاز query خارج می‌کند. jobهای منقضی‌شده بعد از restart قابل بازیابی‌اند؛ fencing token و revision جاری مورد انتظار پیش از commit اتمی دوباره بررسی می‌شوند.

قرارداد تکمیلی ورود سند: فایل فاقد شناسهٔ بخش، از سرور section_id ترتیبی پایدار می‌گیرد؛ در جایگزینی، نگاشت بخش‌های حفظ‌شده باقی می‌ماند و بخش تازه شناسهٔ آزاد بعدی می‌گیرد. تغییر سیاست دسترسی نباید نسخهٔ قبلی را برای کاربران تازه‌مجازشده قابل مشاهده کند؛ کاهش دسترسی فوری است، اما گسترش دسترسی فقط پس از ready و فعال‌سازی revision تازه اعمال می‌شود. مجوز مؤثر revision جاری باید از سیاست staging جدا بماند.

قرارداد retry: embedding و rerank هرکدام حداکثر دو تلاش 10ثانیه‌ای دارند؛ generation حداکثر دو تلاش 30ثانیه‌ای دارد و network retry و JSON repair همین سهمیه را مشترک مصرف می‌کنند. deadline مشترک درخواست 60 ثانیه است. فقط خطای شبکه و 429/502/503/504 با backoff نمایی و jitter در زمان باقی‌مانده retry شوند؛ خطای قطعی parsing یا ابعاد نامعتبر retry بی‌حد نگیرد. اثر خارجی قبل از crash می‌تواند دوباره اجرا شود؛ تضمین exactly-once برای فراخوانی provider داده نمی‌شود.

## 7. Project Structure

پارت ۲ پایهٔ `apps/web/` را با Next.js App Router، TypeScript و صفحهٔ معرفی فارسی RTL اضافه می‌کند. این صفحهٔ static به API وصل نیست و `.env` ریشه را نمی‌خواند؛ هیچ ورود، پرسش‌وپاسخ یا فهرست سند واقعی ندارد. tokenهای CSS در `src/app/tokens.css` از سند طراحی می‌آیند؛ Vazirmatn محلی با تأیید کاربر تطبیق فارسی است. نمای اولیه و shell فعلی بر پایهٔ نقش نیستند؛ پوستهٔ متصل به نقش سروری در پارت ۵ ساخته می‌شود.

در پارت ۱، `apps/api/app/` (factory برنامه، تنظیمات و route سلامت)، `apps/api/tests/` و manifest/lockfile ساخته شدند. ساختار زیر مقصد مراحل بعدی است؛ دیگر ماژول‌ها، رابط وب و migration هنوز ایجاد نشده‌اند. `GET /api/health` فقط liveness را با `{"status":"ok"}` گزارش می‌کند و اتصال DB یا provider را بررسی نمی‌کند. تنظیمات از `.env` ریشه با تقدم متغیرهای محیط فرایند خوانده می‌شوند؛ credential خالی تا پارت اتصال مربوط مجاز است. خطای تنظیمات نامعتبر هنگام شروع، فقط نام فیلد و نوع خطا را نشان می‌دهد. logging دسترسی خام در فرمان اجرای محلی خاموش است تا query string ثبت نشود.

```text
apps/
├── web/                         # Next.js، رابط RTL و Route Handler پراکسی
└── api/
    ├── app/
    │   ├── api/                 # auth, answers, sources, manager
    │   ├── auth/                # حل نشست و مجوز
    │   ├── documents/            # بارگذاری، revision و ingestion
    │   ├── retrieval/            # BM25، برداری و ادغام رتبه
    │   ├── answer/               # generation و اعتبارسنجی استناد
    │   ├── providers/            # embedding, generation, reranking adapters
    │   ├── domain/               # مدل‌ها و قراردادهای دامنه
    │   ├── cli/                  # seed مدیریتی محدود
    │   └── evaluation/           # ارزیابی آفلاین
    └── alembic/                  # migrationهای schema
docs/
├── ARCHITECTURE.md
└── DATABASE.md
.env.example                     # فقط نام متغیر و placeholder
```

## 8. Dependency Rules

- UI فقط با API هم‌مبدأ حرف می‌زند؛ UI و Route Handler مستقیماً DB یا provider را صدا نمی‌زنند.
- routeها transport و schema را مدیریت می‌کنند؛ مجوز و قواعد دامنه در service نیز دوباره بررسی می‌شوند.
- ماژول سند مالک ساخت revision و ingestion است؛ بازیابی فقط از دادهٔ فعال/جاری/آماده استفاده می‌کند.
- retrieval به adapter embedding وابسته است، نه به SDK یک vendor. generation و reranking نیز پشت قرارداد adapter می‌مانند.
- همهٔ مسیرهای بازیابی، rerank، زمینهٔ مدل و پاسخ از یک دامنهٔ مجاز ساخته‌شده سمت سرور استفاده می‌کنند؛ هیچ مرحله‌ای مجاز به گسترش آن نیست.
- مدل embedding و بُعد بردار در یک نمایه باید یکسان باشند؛ تغییر مدل نیازمند نمایهٔ تازه و جابه‌جایی اتمی است.
- secrets فقط در محیط سرویس می‌مانند؛ مقدار secret، متن خام پرسش، prompt و محتوای سند وارد لاگ عادی نمی‌شوند.

## 9. Key Technical Decisions

| تصمیم | زمینه و دلیل | وضعیت |
|---|---|---|
| Modular monolith و worker درون API | نسخهٔ اول کوچک است؛ تراکنش فعال‌سازی اتمی و اجرای محلی بدون صف بیرونی ساده‌تر است | پیشنهادی |
| PostgreSQL 16.15 موجود روی میزبان و DB تازه | پروژه باید دادهٔ مستقل داشته باشد و مقصد اتصال صریحاً محدود باشد | پیشنهاد اتصال؛ DB/user هنوز ساخته نشده |
| Ollama و `nomic-embed-text-v2-moe:latest`، بردار 768بعدی | embedding محلی؛ قرارداد جست‌وجو نیازمند `search_query:` و `search_document:` است | انتخاب مدل پیشنهادی؛ در محیط باید موجودی و خروجی را بررسی کرد |
| سقف ورودی embedding: ۴۰۰ token و ۱۲۰۰ نویسه | مدل سقف ۵۱۲ token دارد؛ طول نویسه به‌تنهایی سقف token را تضمین نمی‌کند | قاعدهٔ chunking پیشنهادی؛ `truncate:false` |
| OpenRouter برای generation، مدل قابل تنظیم | انتخاب کاربر برای تولید پاسخ و امکان تغییر مدل بدون دست‌کاری دامنه | endpoint و structured output هنوز باید smoke-test شوند |
| OpenRouter rerank اختیاری و خاموش | همان کلید generation؛ endpoint رایگان فقط برای corpus ساختگی، غیرشخصی و غیرمحرمانه | preflight و بررسی کیفیت فارسی هنوز لازم است |
| متن پاسخ از claims اعتبارسنجی‌شده | ارجاع باید به chunk ارسالی تعلق داشته باشد و نقل‌قول عیناً در آن بیاید | الزام طراحی |
| بدون پاسخ stream | امکان بررسی مجدد مجوز و revision پیش از تحویل کل پاسخ | الزام طراحی |

## 10. Performance Considerations

- در هر درخواست، ۲۰ نتیجهٔ واژگانی و ۲۰ نتیجهٔ برداری حداکثر، ادغام با RRF `k=60`، حداکثر ۲۰ ورودی rerank اختیاری و حداکثر پنج قطعه برای زمینه در نظر گرفته می‌شود.
- دو مسیر lexical/vector روی دامنهٔ مجاز همان درخواست به‌صورت موازی اجرا می‌شوند؛ BM25 از `rank_bm25` استفاده می‌کند و متن منبع برای quote دست‌نخورده می‌ماند.
- ابتدا اسکن دقیق pgvector برای اندازهٔ کوچک داده کافی است؛ ANN تنها پس از اندازه‌گیری latency و رشد واقعی داده بررسی می‌شود.
- سقف آغازین بارگذاری ۱ MiB، ۱۰۰ سند فعال و ۲۰۰۰ قطعهٔ جاری در طرح فنی آمده است؛ پس از parsing سهمیه پیش از هر provider call سنجیده می‌شود.
- chunking هم سقف ۱۲۰۰ نویسه با ۱۵۰ نویسه overlap در همان section و هم سقف ۴۰۰ token دارد؛ مرز section حفظ می‌شود.
- timeout کل پاسخ ۶۰ ثانیه است؛ سقف تلاش generation برابر ۳۰ ثانیه، embedding پرسش ۱۰ ثانیه و rerank ۱۰ ثانیه، همگی در همان deadline کلی قرار می‌گیرند.
- زمان p50/p95، retry، خطا و هزینه بر اساس دادهٔ ثبت‌شده گزارش می‌شوند؛ پیش از اندازه‌گیری ادعای عملکرد نمی‌شود.

## 11. Scalability Considerations

- نسخهٔ اول یک نمونهٔ API و worker با یک کار ingestion هم‌زمان دارد؛ lease job برای بازیابی پس از restart و جلوگیری از commit worker قدیمی است.
- در بیش از ۱۰۰ سند یا ۲۰۰۰ chunk، یا در صورت latency نامناسب اندازه‌گیری‌شده، سقف‌ها و راهبرد index/صف بازبینی می‌شوند. ANN، صف بیرونی و worker موازی پیش‌فرض نیستند.
- provider، نام مدل، digest و بعد بردار در هر chunk ذخیره می‌شوند. اگر digest مدل `:latest` تغییر کند، query به‌صورت fail-closed متوقف و کل index پروژه در staging دوباره ساخته می‌شود؛ index جدید فقط پس از تکمیل همهٔ بردارها به‌صورت اتمی فعال می‌شود. بردارهای دو digest مخلوط نمی‌شوند.
- پاک‌سازی فیزیکی revisionهای قدیمی، backup/restore و نگهداری telemetry بلندمدت نیازمند طرح عملیاتی جداگانه پیش از استقرار است.

## 12. Failure Scenarios

| رخداد | رفتار مورد انتظار |
|---|---|
| PostgreSQL در دسترس نیست | درخواست ناموفق با خطای عمومی موقت؛ هیچ پاسخ سیاستی بدون مجوز/داده ساخته نمی‌شود. job تا بازیابی DB قابل پردازش نیست. |
| Ollama خاموش، مدل در دسترس نیست یا ابعاد نامعتبر است | embedding/search به‌عنوان خطای provider ثبت می‌شود؛ پاسخ حدسی و fallback پنهان نداریم. job موقت تا سقف retry می‌ماند. |
| ورودی از سقف 512 token عبور می‌کند | chunker باید پیش از provider آن را به حداکثر ۴۰۰ token برساند؛ با `truncate:false` ورودی بلند رد می‌شود و نباید silently truncate شود. |
| OpenRouter timeout، خطای 429/5xx یا JSON نامعتبر | retry محدود در deadline مشترک؛ حداکثر دو تلاش تولید، با حداکثر یک اصلاح JSON. شکست نهایی پاسخ سیاستی تولید نمی‌کند. |
| OpenRouter rerank غیرفعال است | مسیر ترکیبی پایه بدون فراخوانی اضافی rerank اجرا می‌شود. اگر صریحاً فعال و provider ناموفق باشد، شکست موقت ثبت می‌شود؛ fallback پنهانی نیست. |
| پردازش فایل شکست می‌خورد | revision در staging فعال نمی‌شود؛ در جایگزینی revision قبلی جاری باقی می‌ماند؛ خطای قابل اقدام و غیرحساس به مدیر نمایش داده می‌شود. |
| worker پس از lease منقضی‌شده برمی‌گردد | پیش از commit مالکیت lease بررسی می‌شود؛ worker قدیمی اجازهٔ فعال‌سازی revision ندارد. فراخوانی بیرونی قبلی ممکن است هزینهٔ تکراری داشته باشد. |
| نقش یا سند حین پاسخ تغییر می‌کند | مجوز و revision پیش از پاسخ/منبع دوباره بررسی می‌شوند؛ پاسخ مبتنی بر دادهٔ منسوخ تحویل نمی‌شود. داده‌ای که قبلاً به provider مجاز فرستاده شده قابل پس‌گرفتن نیست. |
| نشست نامعتبر یا منقضی است | درخواست احراز هویت رد می‌شود؛ هویت از پارامتر/هدر کاربر پذیرفته نمی‌شود. |
