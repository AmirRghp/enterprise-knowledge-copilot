# راهبرد آزمون

## 1. هدف‌های آزمون

- اطمینان از مجوزدهی پیش از بازیابی و نبود نشت بین نقش‌ها.
- اطمینان از صحت چرخهٔ عمر سند، استناد به بخش و خودداری از پاسخ بی‌پشتوانه.
- سنجش بازیابی روی معیار ثابت ۴۰ نمونه‌ای و بازبینی معنایی انسانی.

## 2. گونه‌های آزمون

### آزمون واحد

- نرمال‌سازی فارسی، تقسیم بخش/قطعه، اعتبارسنجی نقل‌قول و استناد، و محاسبهٔ رتبه‌ها.
- مجوز سند براساس نقش، وضعیت فعال/آماده و نسخهٔ جاری.

### آزمون یکپارچه

- نشست و authorization واقعی از مسیر API و پایگاه اختصاصی پروژه.
- شکست/جایگزینی سند، خطای embedding و تعامل lease با worker.
- کنترل مبدأ، فیلتر provider، خروجی schema و حذف secret از خطاها.

### آزمون سرتاسری

- ورود کارمند و مدیر، پرسش و بازکردن منبع مجاز، و مدیریت سند توسط مدیر.
- پرسش ترکیبی، جعل نقش و پرسش دربارهٔ سند ممنوع باید محتوای مدیریتی یا وجود آن را افشا نکند.

## 3. ابزارهای آزمون

- دیتابیس آزمون جدا `enterprise_knowledge_copilot_test` در ۲۰۲۶-۱۰-۰۴ روی سرویس موجود ساخته شد. هیچ آزمونی روی DB قدیمی `rag_support` یا DB برنامه `enterprise_knowledge_copilot` اجرا نشود؛ fixtureهای `tests/test_database.py` نام پایگاه‌داده را به `enterprise_knowledge_copilot_test` قید می‌کنند و در صورت نبود دسترسی با ذکر دلیل skip می‌شوند.
- schema با Alembic زیر `apps/api/alembic/` نسخه‌بندی می‌شود. `alembic check` دروازهٔ همگامی مدل اعلانی و migration است و باید بدون اختلاف باشد؛ آزمون round-trip روی DB آزمون انجام می‌شود، نه روی DB برنامه.
- معیار داده‌ای: `eval/questions.jsonl` با ۴۰ نمونهٔ ثابت. تنظیم مکرر prompt یا رتبه‌بند روی این معیار انجام نشود.
- ارزیابی پشتیبانی معنایی استناد و پوشش حقایق نیازمند بازبینی دستی است.
- آزمون‌های معمول provider با fake/mock قطعی و بدون تماس سرویس اجرا شوند. بررسی اتصال و قرارداد واقعی Ollama/OpenRouter در مرحلهٔ اتصال اولیه، تغییر مرتبط یا milestone انجام شود؛ mock جای آزمون authorization واقعی API/DB نیست.
- benchmark ثابت و بازبینی انسانی پس از هر ویرایش تکرار نشوند؛ اجرای آن‌ها برای تغییر مرتبط با کیفیت پاسخ یا milestone است. تست جدید باید رفتار یا ریسک مشخص را بسنجد، نه ساختار داخلی کد را تکرار کند؛ هدف درصدی پوشش یا ابزار تازه برای تغییر کوچک تحمیل نشود.

## 4. ساختار فایل آزمون

ساختار آزمون API در Part 1 ایجاد شده است. آزمون‌های Part 5 مرز proxy را با درخواست HTTP واقعی بررسی می‌کنند؛ مرورگر production نیز جداگانه بررسی می‌شود.

```text
apps/api/
├── tests/
│   ├── test_scaffold.py    # Part 1: health، تنظیمات و اولویت متغیر محیط
│   ├── test_database.py    # Part 3: allowlist، پیش‌نیاز vector و schema پایگاه آزمون
│   ├── test_auth.py              # Part 4: احراز هویت و نشست
│   ├── test_auth_regressions.py  # بازتولید یافته‌های اصلاح‌شده
│   └── test_login_rate_limit.py  # پنجره، حدود و ظرفیت limiter
# documents و retrieval در پارت‌های آینده
apps/web/tests/e2e/   # Playwright browser flows
apps/web/tests/auth-proxy.mjs # Part 5: native HTTP boundary checks for the auth proxy
```

Part 5 proxy-boundary checks run as `npm run test:proxy` from `apps/web/`; they require the web app and API to be running. They exercise the Route Handler over HTTP rather than importing implementation internals.

## 5. جریان‌های حیاتی

**مجوز و بازیابی:** کارمند را با نشست معتبر اجرا کنید؛ پرسش مستقیم، پرسش غیرمستقیم و پرسش دربارهٔ وجود سند مدیریتی بفرستید. انتظار: هیچ سند مدیریتی در نتیجهٔ retrieval، زمینهٔ مدل، منبع، پاسخ یا endpoint آشکار نشود.

**فنس lease:** دو worker را روی یک job رقابتی اجرا کنید؛ lease را به worker دوم منتقل و commit worker اول را امتحان کنید. انتظار: فقط مالک فعلی lease می‌تواند نسخه را فعال کند.

**استناد:** ادعای بی‌ارجاع، شناسهٔ ساختگی، نقل‌قول نامنطبق و منبعی که در زمان پاسخ غیرمجاز/منسوخ شده را بررسی کنید. انتظار: پاسخ نامعتبر یا امتناع خنثی برگردد.

**حد توکن:** ورودی و زمینهٔ بزرگ‌تر از حد پیکربندی را بررسی کنید. انتظار: پیش از ارسال به provider محدود یا رد شود و دادهٔ خارج از حد بی‌صدا حذف نشود.

**چرخهٔ سند:** پردازش موفق، شکست، جایگزینی و حذف را بررسی کنید. انتظار: فقط نسخهٔ فعال، جاری، آماده و مجاز قابل بازیابی است؛ شکست جایگزینی نسخهٔ قبلی مجاز را ناخواسته از کار نمی‌اندازد.

**تغییر دسترسی:** سند مدیریتی را با نسخهٔ عمومی جایگزین کنید؛ پیش از ready کارمند به نسخهٔ قدیمی دسترسی نگیرد. در مسیر معکوس کاهش مجوز فوری باشد.

**محدودسازی login:** با ساعت ساختگی پنجرهٔ لغزان، حد جفت IP/شناسه، حد IP، retry-after، پرشدن ظرفیت کلیدها و fail-closed را بررسی کنید. IP از peer واقعی اتصال گرفته شود؛ هدر forwarding دلخواه نباید کلید را تغییر دهد. این limiter تک‌فرایندی است و در restart حافظه‌اش از نو آغاز می‌شود.

## 6. پوشش

هنوز هدف درصدی تعیین نشده است. اولویت پوشش با مجوز، تغییر داده، ingestion/lease، استناد و جریان‌های اصلی کاربر است. معیار ثابت ۴۰ نمونه‌ای شامل ۱۴ مستقیم، ۱۰ چندسندی، ۸ بدون پاسخ و ۸ دسترسی/حمله است؛ نتایج را مطابق `docs/evaluation-guide.md` جداگانه گزارش کنید.

## 7. فرمان‌های scaffold فعلی

فرمان‌های Part 1 در حال حاضر از پوشهٔ `apps/api/` و با Python 3.12 قابل اجرا هستند. وابستگی‌های مستقیم و توسعه در `pyproject.toml` تعریف و در `uv.lock` قفل شده‌اند:

```bash
# ترمینال سیستم؛ پوشه apps/api
uv sync --locked
uv run --locked python -m app
uv run --locked pytest -q tests/test_scaffold.py
uv run --locked pytest -q tests/test_database.py
uv run --locked pytest -q tests/test_auth.py
uv run --locked pytest -q tests/test_embedding.py
uv run --locked pytest -q tests/test_provision_sql.py
DB_NAME=enterprise_knowledge_copilot_test uv run --locked python -m app.cli.seed_accounts
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked mypy app
uv run --locked python -m app.cli.preflight_embedding
```

فرمان‌های schema که با Part 3 اضافه شدند و از همان پوشه اجرا می‌شوند:

```bash
# ترمینال سیستم؛ پوشه apps/api
uv run --locked alembic upgrade head
uv run --locked alembic current
uv run --locked alembic check
DB_NAME=enterprise_knowledge_copilot_test uv run --locked alembic upgrade head
DB_NAME=enterprise_knowledge_copilot_test uv run --locked alembic downgrade base
```

آماده‌سازی DBها و حساب محدود فرمان جداست و فقط توسط superuser سرویس موجود اجرا می‌شود؛ به متغیر محیطی `EKC_DB_PASSWORD` داخل container نیاز دارد و در صورت نبود یا خالی بودن با کد خروج غیرصفر و بدون تغییر متوقف می‌شود. هیچ credentialی در argv یا مخزن ثبت نمی‌شود. دستور کامل در [DATABASE](DATABASE.md) بخش ۱۱ و اسکریپت `apps/api/sql/provision.sql` است.

سرور محلی روی `127.0.0.1:8000` اجرا می‌شود؛ `GET /api/health` باید `{"status":"ok"}` بدهد. آزمون scaffold نبود credential را برای health، اولویت متغیر محیط بر `.env` ریشه، اعتبارسنجی تنظیمات و نشت‌نکردن مقدار حساس در خطای startup را بررسی می‌کند. health صرفاً liveness است و database یا provider را ping نمی‌کند؛ با Part 3 این رفتار عمداً تغییر نکرد و بررسی schema از مسیر `alembic current` و آزمون پایگاه آزمون انجام می‌شود. فرمان‌های بالا ابزارهای قابل اجرا هستند، نه گزارشی از عبور بررسی‌ها؛ نتیجه فقط پس از اجرای واقعی ثبت شود.

**نتیجهٔ Part 3 در 2026-10-04:** `alembic check` بدون اختلاف گزارش شد؛ `alembic upgrade head` روی `enterprise_knowledge_copilot` هفت جدول و ستون `vector(768)` ساخت و downgrade/upgrade روی `enterprise_knowledge_copilot_test` بدون خطا رفت‌وبرگشت کرد. `pytest -q tests/test_database.py` با ۸ آزمون موفق و بدون skip اجرا شد و `pytest -q tests/test_scaffold.py` با ۱۲ آزمون موفق باقی ماند؛ Ruff lint، Ruff format check و `mypy app` هم موفق شدند. اجرای واقعی `python -m app` و درخواست `GET http://127.0.0.1:8000/api/health` همچنان `200 {"status":"ok"}` داد. `rag_support` با ۸۲ relation و همان افزونه‌ها دست‌نخورده ماند و container بدون ری‌استارت کار کرد. این نتیجه فقط همین schema و همین زمان اجرا را پوشش می‌دهد؛ مجوز، ingestion، retrieval، generation و رفتار کاربر در پارت‌های بعدی هستند و اینجا بررسی نشده‌اند.

**نتیجهٔ اصلاحات بازبینی Part 3 در 2026-10-04:** `pytest -q tests/test_database.py` با ۱۱ آزمون موفق و بدون skip. سیاست skip به `is_connection_failure` محدود شد که فقط خطای اتصال را می‌پذیرد؛ `test_connection_failure_classifier_treats_query_fault_as_failure` و `test_query_fault_fails_instead_of_skipping` ثابت می‌کنند خطای query به‌جای skip باعث شکست تست می‌شود. گاردهای `provision.sql` جداگانه آزموده شدند: رمز خالی، فقط-فاصله و غایب هر سه exit 3 با snapshot بدون تغییر؛ برخورد مالکیت (target_db_app=postgres) exit 3 بدون تغییر؛ `dry_run=1` بدون تغییر. مسیر mutation در یک namespace ایزوله با نام‌های `ekc_ci_*` آزموده شد: ساخت role با مجوز محدود، ساخت دو DB با owner درست و نصب extension؛ اجرای دوباره رمز را تغییر نداد و `rotate_password=1` آن را چرخاند؛ همهٔ objectهای آزمون بعداً drop شدند. بررسی argv نشان داد روش قدیمی `-v app_password=…` رمز را در argv فرایند آشکار می‌کند و روش `--env-file` این کار را نمی‌کند. این نتیجه فقط همین schema و همین زمان اجرا را پوشش می‌دهد.

**نتیجهٔ اولیهٔ پارت ۴ در 2026-10-04 (پیش از اصلاحات بازبینی):** احراز هویت سمت سرور با `POST /api/auth/login`، `POST /api/auth/logout` و `GET /api/auth/me` اضافه شد. `tests/test_auth.py` با ۴۴ آزمون موفق و بدون skip اجرا شد؛ کل مجموعه ۷۵ آزمون پاس شد و Ruff lint، format check و `mypy app` نیز موفق بودند. seed هر دو حساب را روی DB آزمون ساخت و `user_id` در اجرای دوباره ثابت ماند. سناریوهای مثبت و منفی روی سرور واقعی `127.0.0.1:8000` بررسی شدند: ورود کارمند و مدیر ۲۰۰؛ کوکی `HttpOnly; SameSite=lax; Path=/` با عمر ۲۸۸۰۰ ثانیه؛ رمز غلط، login ناشناس، کوکی جعلی و حساب غیرفعال همگی ۴۰۱ با پیام یکسان؛ Origin غایب، `null` و خارجی ۴۰۳؛ نقش جعلی در query/header نادیده گرفته شد؛ تغییر نقش در DB در درخواست بعدی اعمال شد؛ logout بلافاصله نشست را باطل کرد و توکن باطل‌شده پذیرفته نشد. بررسی ذخیره‌سازی نشان داد فقط hash باینری ۳۲ بایتی ذخیره می‌شود و sha256 توکن خام با آن در پایگاه‌داده هم‌خوان است؛ رمز seed و هش در log سرور دیده نشدند. `rag_support` با ۸۲ relation دست‌نخورده ماند. این نتیجه پیش از اصلاح یافته‌های این گزارش است و برای وضعیت فعلی مرجع نیست.

**نتیجهٔ اصلاحات Part 4 در 2026-10-04:** فرمان `uv run --locked pytest -q --tb=short -rs` از `apps/api/` با ۹۲ آزمون موفق و بدون skip تمام شد: ۴۷ auth، ۹ regression، ۵ limiter، ۱۲ scaffold، ۱۱ database و ۸ provisioning. چهار regression تازه پیش از اصلاح شکست مورد انتظار را نشان دادند و پس از اصلاح موفق شدند. `uv run --locked ruff check app tests`، `uv run --locked ruff format --check app tests` (۲۷ فایل) و `uv run --locked mypy app` (۲۱ منبع) نیز موفق شدند. آزمون‌ها از DB آزمون استفاده کردند؛ seed و پاک‌سازی جدول‌های auth فقط در `enterprise_knowledge_copilot_test` انجام شد و DB اصلی تغییر نکرد. هیچ migration، سرور HTTP واقعی، مرورگر یا تماس provider خارجی در این بررسی نبود. CORS، رابط ورود و proxy هم‌مبدأ خارج از دامنهٔ Part 4 بودند؛ نتیجهٔ Part 5 در ادامه ثبت شده است.

**نتیجهٔ اصلاح guardهای provisioning در 2026-10-04:** guardهای `provision.sql` پیش‌تر مقدار `count(*)` را مستقیم به `\if` می‌دادند. `\if` در psql فقط `0` و `1` را boolean می‌پذیرد و برای مقدار دیگر پیام خطای boolean صادر می‌کند، اما شرط را شاخهٔ FALSE می‌گیرد؛ بنابراین برخوردی که هر دو DB هدف را درگیر کند مقدار `2` می‌ساخت و می‌توانست guard را دور بزند. بازتولید قبلی فقط‌خواندنی بود و ادعای اجرای `CREATE EXTENSION` روی DB بیگانه ندارد. guardها با `EXISTS` اصلاح شدند. ماتریس فقط‌خواندنی نهایی: بدون برخورد، exit 0 و `success=True`؛ یک مالکیت بیگانه، دو مالکیت بیگانه، و دو مالکیت اضافی، هرکدام exit 3 و `success=False`. همهٔ برخوردها پیش از mutation متوقف شدند و پیام موفقیت چاپ نشد. `postgres` و `rag_support` بدون `vector` باقی ماندند. هشت آزمون ایستا در `tests/test_provision_sql.py` اضافه شد؛ بازگرداندن عمدی `count(*)` به guard اول سه آزمون را fail کرد و پس از بازگردانی اصلاح، همه pass شدند.

**بازبینی نهایی پیش از انتشار Part 3 در 2026-10-04:** `uv run --locked pytest -q tests/test_database.py tests/test_scaffold.py tests/test_provision_sql.py` با ۳۱ تست موفق (۱۱ دیتابیس، ۱۲ scaffold و ۸ ایستای provisioning)، بدون skip. `uv run --locked ruff check app/db alembic tests/test_database.py tests/test_provision_sql.py`، `uv run --locked ruff format --check app/db alembic tests/test_database.py tests/test_provision_sql.py` (۱۰ فایل) و `uv run --locked mypy app` (۱۲ منبع) موفق شدند. ماتریس dry-run در بالا فقط‌خواندنی و با credential جعلی بود؛ مقدار credential چاپ یا ثبت نشد. اجرای mutation در این بازبینی انجام نشده است. این نتایج پیش از انتشار ثبت شده‌اند؛ پس از push موفق، checkboxهای پارت ۳ و SHA پیاده‌سازی در برنامه ثبت شدند.

**نتیجهٔ اجرای Part 1 در 2026-10-04:** `uv sync --locked` موفق؛ `uv run --locked pytest -q tests/test_scaffold.py` با ۱۲ آزمون موفق؛ Ruff lint و format check و mypy همگی موفق. سرور محلی نیز پاسخ `200 {"status":"ok"}` برای health برگرداند. این نتیجه فقط همان scaffold و زمان اجرا را پوشش می‌دهد.

فرمان‌های رابط از پوشهٔ `apps/web/` با Node.js 22 یا بالاتر اجرا می‌شوند:

```bash
# ترمینال سیستم؛ پوشه apps/web
npm ci
npm run dev
npm run lint
npm run typecheck
npm run format:check
npm run build
npm run start
```

سرور توسعه و production به `127.0.0.1:3000` bind می‌شوند. برای Part 2 مرورگر را روی `http://localhost:3000` باز کنید و محتوای فارسی/RTL، نمایش دسکتاپ و موبایل، رسیدن با صفحه‌کلید به skip link و مقصد آن، نبود سرریز افقی، و شکل‌دهی فارسی/نیم‌فاصله با Vazirmatn را بررسی کنید. فایل محلی Vazirmatn 33.003 از طریق `next/font/local` بارگذاری می‌شود؛ فایل Notion Sans در برنامه bundle نشده و نباید ادعای تطابق دقیق قلم مطرح شود. Part 2 آزمون E2E یا درخواست API ندارد.

**نتیجهٔ Part 2 پس از تغییر قلم و آیکون:** `npm ci`، `npm run lint`، `npm run typecheck`، `npm run format:check` و `npm run build` موفق شدند. اجرای production با `npm run start` روی `http://localhost:3000` موفق بود؛ صفحه و دارایی‌های قلم و آیکون با پاسخ 200 و بدون درخواست شبکهٔ خارجی بارگذاری شدند و کنسول هیچ خطا یا هشداری نداشت. بازبینی تصویری فارسی/RTL در عرض‌های 320، 375، 768، 1024 و 1440 پیکسل هیچ سرریز افقی نشان نداد؛ Vazirmatn محلی با وزن‌های متغیر 100 تا 900 بارگذاری شد. با صفحه‌کلید، Tab و Enter، skip link به محتوای اصلی رسید و تمرکز روی مقصدهای guide و preview نیز بررسی شد. این پارت آزمون E2E خودکار ندارد. ESLint به 9.39.5 pin شده چون ESLint 10.12.0 با `eslint-plugin-react` موردنیاز پیکربندی Next خطای `contextOrFilename.getFilename is not a function` می‌دهد؛ npm هشدار می‌دهد ESLint 9.39.5 دیگر پشتیبانی نمی‌شود.

## 8. معیار اتمام

- در هر تغییر، آزمون متناسب با دامنه اجرا شود: ویرایش مستندات با بازبینی لینک‌ها و diff؛ تغییر کوچک منطق با آزمون واحد هدفمند؛ UI با lint/typecheck و حالت‌های مرورگری متأثر؛ و auth، RAG، provider، ingestion یا migration با آزمون‌های مرزی و منفی روی محیط/DB جداگانه. کنترل‌های بحرانی مجوز و امنیت حذف‌شدنی نیستند.
- فهرست کامل بررسی‌های این بخش gate milestone معنادار یا انتشار است، نه الزام برای هر تغییر کوچک. آن‌ها را پس از تغییر مرزهای مشترک یا در milestone اجرا کنید؛ می‌توان به نتیجهٔ قبلی اتکا کرد اگر کد، پیکربندی و وابستگی مرتبط از آن زمان تغییر نکرده باشد.
- هیچ نتیجهٔ retrieval، منبع یا endpoint غیرمجاز به کارمند نرسد.
- استنادها از نظر ساختاری معتبر و از نظر معنا توسط بازبین با سند مقابله شوند.
- گزارش معیار ثابت تعداد موفق/ناموفق، تنظیم مدل و retrieval و محدودیت‌ها را ثبت کند.
- در gate کامل، lint، typecheck، build و جریان‌های مرورگر فارسی در عرض‌های 320/375/768/1280 موفق باشند.
- شکست‌ها و commandهای اجراشده صادقانه مستند شوند؛ طرح آزمون به‌تنهایی مدرک عبور نیست.
- گزارش هر اجرا خلاصه و شامل فرمان، pass/fail/skip و دلیل skip باشد؛ خروجی حجیم یا داده/secret چاپ نشود. پس از شکست، علت را بررسی کنید و فقط پس از تغییر مرتبط آزمون را تکرار کنید؛ زمان دلخواه برای قطع آزمون لازم تعیین نکنید.

## 9. نتیجهٔ Part 5 در 2026-10-05

از `apps/web/`، `npm run lint`، `npm run typecheck`، `npm run format:check` و `npm run build` پس از آخرین تغییرات موفق شدند. `npm audit --omit=dev` برای وابستگی‌های runtime صفر آسیب‌پذیری گزارش کرد؛ وابستگی‌های توسعه در این audit نبودند. مجموعهٔ کامل API تکرار نشد چون کد API تغییر نکرد.

`npm run test:proxy` با ۱۱ آزمون HTTP روی مرز native Route Handler در کمتر از یک ثانیه موفق شد. این آزمون‌ها به web و API در حال اجرا نیاز دارند. بررسی API واقعی به Uvicorn روی `127.0.0.1:8001` و فقط DB آزمون `enterprise_knowledge_copilot_test` متصل بود؛ دو حساب و نشست‌های آزمون فقط در همین DB seed/استفاده شدند. API اصلی روی `127.0.0.1:8000` صرفاً برای اجرا بالا آمد. آزمون‌ها روی DB برنامه داده یا seed ننوشته‌اند، migration/schema را تغییر نداده‌اند، `.env` ریشه را تغییر نداده‌اند و provider خارجی را فراخوانی نکرده‌اند.

در مرورگر production واقعی، ورود و reload کارمند و مدیر، عنوان مدیریتی مخصوص نقش، خروج و هدایت صفحهٔ محافظت‌شده با API متصل به DB آزمون بررسی شد. صفحه در عرض‌های 320، 768، 1024 و 1440 پیکسل سرریز افقی نداشت و خطای JavaScript در مرورگر رخ نداد؛ خطاهای شبکهٔ مورد انتظار در سناریوهای منفی جدا هستند. با صفحه‌کلید، تمرکز روی skip/login/password و خطای ورود بررسی شد؛ رمز نادرست پیام عمومی داد. headerهای پاسخ امنیتی Next و `no-store` بودن HTML ورود نیز تأیید شدند. آزمون‌های HTTP ویژگی‌های کوکی host-only، `HttpOnly` و `SameSite=Lax`، بی‌اثر بودن role در body/header، نبود `user_id` در DTO عمومی، خروج `204` با کوکی پاک‌شده و `Max-Age=0` و رد نشست پس از خروج، پاسخ `429` با `Retry-After` و بی‌اثر بودن `Forwarded` جعلی را پوشش دادند. مرورگر واقعی با پاسخ‌های شبکهٔ fake/intercepted، 429 با ۱۲ ثانیه انتظار، غیرفعال‌شدن دکمه هنگام بارگذاری و خطای شبکهٔ قابل retry را نیز بررسی کرد. پس از توقف API آزمون، پاسخ عمومی 502 از proxy و پیام «ارتباط برقرار نشد» در صفحهٔ محافظت‌شده بررسی شد. API آزمون متوقف و preview عادی با تنظیمات `.env` ریشه، API پورت 8000 و DB برنامه بازیابی شد. کاربر بررسی و انتشار پارت را تأیید کرد؛ پیاده‌سازی با SHA `f55f30ba79158048ec31b7a23cf544a871dfc6f5` روی `origin/main` منتشر شد و remote تمیز تأیید شد.

برای تکرار بررسی HTTP واقعی، از `apps/api/` حساب‌های نمونه را در DB آزمون seed کنید و API آزمون را اجرا کنید؛ گذرواژه‌ها از `.env` محلی خوانده می‌شوند و مقدارشان را در دستور یا گزارش ننویسید:

```bash
# ترمینال سیستم؛ پوشه apps/api
DB_NAME=enterprise_knowledge_copilot_test uv run --locked python -m app.cli.seed_accounts
DB_NAME=enterprise_knowledge_copilot_test uv run --locked uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8001 --no-proxy-headers
```

در ترمینال دوم، از `apps/web/` رابط را به API آزمون وصل و proxy tests را اجرا کنید:

```bash
# ترمینال سیستم؛ پوشه apps/web
API_BASE_URL=http://127.0.0.1:8001 npm run dev
# ترمینال جداگانه، پس از آماده‌شدن web و API
npm run test:proxy
```

برای بازبینی دستی، preview عادی روی `http://localhost:3000/login` قرار دارد و از API پورت 8000 و DB برنامه استفاده می‌کند. حساب‌های `employee` و `manager` را با گذرواژه‌های محلی موجود در `.env` امتحان کنید؛ مقدار گذرواژه‌ها را در مستندات یا گزارش وارد نکنید. `WEB_ORIGIN` و `API_BASE_URL` فقط در server استفاده می‌شوند؛ environment سیستم بر `.env` ریشه اولویت دارد و credential با پیشوند `NEXT_PUBLIC_` به مرورگر داده نمی‌شود.

در این milestone، Q&A و endpointهای مدیریت سند هنوز وجود ندارند و گزینه‌های مدیریتی shell placeholder هستند؛ مجوز واقعی همچنان در API اعمال می‌شود. مجموعهٔ کامل API تکرار نشد چون کد API تغییر نکرد. بررسی و انتشار پارت از سوی کاربر تأیید شد؛ پیاده‌سازی با SHA `f55f30ba79158048ec31b7a23cf544a871dfc6f5` منتشر شد و checkboxها در برنامه ثبت شدند.


**پیگیری نهایی ظاهری Part 5:** حاشیهٔ رنگی کناری از پیام خطای فرم حذف شد؛ متن خطا و `role="alert"` باقی ماندند. بررسی محدود Prettier و `npm run build` پس از این تغییر موفق شدند. منطق احراز هویت تغییر نکرد؛ آزمون‌های auth پیشین به‌دلیل این تغییر ظاهری دوباره اجرا نشدند. این نتیجهٔ محدود به معنی اجرای مجدد همهٔ بررسی‌های قبلی پس از CSS نیست.

## 10. نتیجهٔ Part 6 در 2026-10-04
**نتیجهٔ پارت ۶ در 2026-10-04 (پس از دو نوبت اصلاح بازبینی):** `HF_HUB_OFFLINE=1 uv run --locked pytest -q tests/test_documents.py --tb=short -rs` با ۵۳ آزمون موفق و بدون skip تمام شد؛ `ruff check` و `ruff format --check` روی ۷ فایل محدوده و `mypy app` روی ۲۷ منبع نیز موفق شدند و مجموعهٔ کامل با ۱۴۵ آزمون پاس شد. tokenizer واقعی از cache موجود خوانده شد و هیچ تماس شبکه‌ای برقرار نشد. نوبت اول پنج یافته را برطرف کرد: شرط پایان chunker به انتهای واقعی متن منتقل شد؛ پاک‌سازی Markdown از متن قابل استناد حذف و فقط روی `search_text` مشتق اعمال شد؛ مقدمهٔ پیش از نخستین `##` بخش `S0` شد؛ متن سادهٔ بدون heading بخش پایدار `S1` گرفت؛ heading داخل code fence بخش نساخت؛ و `TokenizerUnavailableError` و `ChunkingError` در CLI پیام کوتاه و exit 1 دادند بدون traceback. نوبت دوم دو یافتهٔ لبه را برطرف کرد: محدودهٔ مقدمه از خط صفر شروع می‌شود و خط‌های heading از آن فیلتر می‌شوند، بنابراین مقدمهٔ پیش از `H2` بدون `H1`، مقدمهٔ پیش از `H1` و حالت `H1` سپس مقدمه سپس `H2` هر سه حفظ می‌شوند و عنوان سند در بدنهٔ بخش تکرار نمی‌شود؛ و بستن fence اکنون نوع marker، طول برابر یا بیشتر، و نبود متن پس از marker را می‌سنجد، مطابق CommonMark 0.31.2، پس fence چهارتایی با سه‌تایی بسته نمی‌شود و خط دارای suffix هم بسته‌کننده نیست. برای هر اصلاح، بازگرداندن عمدی آن اجرا شد و آزمون مربوطه شکست خورد. scanner کل corpus: ۲۰ فایل، ۸۰ بخش، ۸۰ قطعه، بیشینهٔ ۴۶۳ نویسه و ۱۲۲ توکن، بدون نقض سقف. **محدودیت اثبات‌شده:** اجرای کاملاً آفلاین روی ماشین با cache خالی هنوز اثبات نشده است؛ اجرای فعلی فقط به‌دلیل cache موجود همین میزبان کار می‌کند. tokenizer در نخستین اجرا به Hugging Face نیاز دارد و بسته‌بندی آن به‌عنوان asset محلی تصمیمی جداگانه و تأییدنشده است. DB و provider در این پارت لمس نشدند.



## 11. نتیجهٔ Part 7 در 2026-10-06
هفت یافتهٔ بازبینی برطرف شدند: digest زنده پیش از هر embedding بررسی می‌شود؛ digest اجباری و hex معتبر است؛ هر تلاش deadline واقعی دارد؛ تطبیق تگ مدل دقیق است؛ پروتکل provider ناهمگام است؛ timeout preflight به retry می‌رسد؛ و jitter پیش‌فرض فعال است. بازتولید پیش از اصلاح با بودجهٔ ۰٫۰۱ ثانیه، ۰٫۰۸ ثانیه طول کشید؛ پس از اصلاح، آزمون‌های deadline واقعی موفق شدند.

**بررسی مستقل نهایی:** `uv run --locked pytest -q tests/test_embedding.py --tb=short -rs` با ۵۸ آزمون موفق، بدون skip، در ۰٫۷۶ ثانیه تمام شد. Ruff روی فایل‌های مرتبط، format روی فایل‌های مرتبط (۷ فایل محدوده) و `mypy app` (۳۲ منبع) موفق شدند. preflight واقعی Ollama نیز digest هم‌خوان، بُعد ۷۶۸ برای هر دو پیشوند و `truncate=False` را تأیید کرد؛ متن نمونه یا مقادیر بردار چاپ نشدند.

مجموعهٔ کامل، `alembic check` و بررسی‌های mutation از گزارش عامل پیاده‌ساز هستند و در این بازبینی مستقلاً تکرار نشدند. DB و schema تغییر نکردند. کاربر در 2026-10-06 انتشار Part 7 را تأیید کرد؛ checkboxهای برنامه تا push موفق خالی می‌مانند.
