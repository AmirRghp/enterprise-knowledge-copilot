# Enterprise Knowledge Copilot — طراحی و داده‌های نمونه

دستیار پیشنهادی اسناد منابع انسانی و عملیات شرکت فرضی «سپهر داده»، برای نمونه‌کار مسیر AI Engineer.

**وضعیت فعلی: Part 1 تا Part 5 با تأیید کاربر منتشر شده‌اند؛ Part 5 پس از بررسی‌های هدفمند با موفقیت منتشر شد.** Part 1 یک scaffold محلی FastAPI در `apps/api/` با تنظیمات محیطی و `GET /api/health` است. Part 2 یک رابط فارسی و RTL در `apps/web/` با Next.js، توکن‌های CSS در `src/app/tokens.css` و نمای workspace اضافه می‌کند. قلم فارسی Vazirmatn نسخهٔ 33.003 به‌صورت محلی بارگذاری می‌شود؛ این تطبیق فارسی در کنار رنگ‌ها و ساختار Notion است و ادعای استفاده از Notion Sans یا تطابق دقیق قلم Notion نیست. Part 3 پایگاه‌دادهٔ اختصاصی پروژه، مدل‌های ORM، migration نسخه‌بندی‌شده و اسکریپت آماده‌سازی را اضافه می‌کند؛ این بخش پس از بررسی محلی با تأیید کاربر منتشر شده است. Part 4 احراز هویت سروری، محدودسازی تلاش login، Argon2id، نشست opaque و کنترل Origin را پیاده و منتشر کرده است. Part 5 صفحهٔ `/login`، پوستهٔ نقش‌محور و proxy محدود هم‌مبدأ برای `login/logout/me` را اضافه می‌کند؛ جزئیات بررسی در [راهبرد آزمون](docs/TESTING.md) آمده‌اند. پرسش‌وپاسخ، فهرست منابع و اتصال provider هنوز پیاده نشده‌اند. همهٔ اسناد و سیاست‌ها ساختگی‌اند و برای استفاده در یک شرکت واقعی یا مشاورهٔ حقوقی تهیه نشده‌اند.

## اجرای پیش‌نمایش رابط

به Node.js 22 یا بالاتر و npm نیاز است. از پوشهٔ `apps/web/` اجرا کنید:

```bash
npm ci
npm run dev
```

صفحه در `http://localhost:3000` باز می‌شود. برای جریان ورود Part 5، API و DB اختصاصی پروژه باید اجرا باشند و حساب‌های محلی seed شده باشند. `API_BASE_URL` و `WEB_ORIGIN` در server خوانده می‌شوند؛ متغیرهای محیط سیستم بر مقادیر `.env` ریشه اولویت دارند. Route Handler فقط مسیرهای auth را عبور می‌دهد؛ جزئیات وضعیت بررسی Part 5 در [برنامهٔ اجرا](docs/plans/plans.md) ثبت می‌شود. وضعیت فرمان‌های lint، typecheck، قالب‌بندی و build در [راهبرد آزمون](docs/TESTING.md) آمده است.

## اجرای scaffold محلی API

به Python 3.12 و `uv` نیاز است. از پوشهٔ `apps/api/` فرمان‌ها را اجرا کنید؛ وابستگی‌ها از `uv.lock` قفل‌شده نصب می‌شوند:

```bash
uv sync --locked
uv run --locked python -m app
```

سرور روی `127.0.0.1:8000` در دسترس است و `GET http://127.0.0.1:8000/api/health` پاسخ `{"status":"ok"}` می‌دهد. health فقط زنده‌بودن API را می‌سنجد و اتصال database یا provider را بررسی نمی‌کند. تنظیمات از `.env` ریشهٔ مخزن به‌صورت صریح خوانده می‌شوند؛ متغیرهای محیط سیستم بر مقادیر فایل اولویت دارند. خالی‌بودن credentialهای آینده مانع health نمی‌شود. جزئیات فرمان‌های بررسی در [راهبرد آزمون](docs/TESTING.md) آمده است.

مرجع پیاده‌سازی: [FastAPI routers](https://fastapi.tiangolo.com/tutorial/bigger-applications/)، [Pydantic Settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/) و [uv locked sync](https://docs.astral.sh/uv/concepts/projects/sync/).

## ساخت حساب‌های نمونه و آزمودن ورود

احراز هویت به حساب‌های seedشده نیاز دارد. این کار فقط از راه CLI انجام می‌شود؛ ثبت‌نام عمومی یا ارتقای نقش از API وجود ندارد. `SEED_EMPLOYEE_PASSWORD` و `SEED_MANAGER_PASSWORD` باید پیش از اجرا هرکدام دست‌کم ۱۲ نویسه باشند؛ CLI مقدار انتخاب‌شده را خودکار تغییر نمی‌دهد. مقصد seed را صریحاً با `DB_NAME` انتخاب کنید؛ فقط `enterprise_knowledge_copilot` و `enterprise_knowledge_copilot_test` مجازند. این CLI برای محیط محلی است و راهکار seed محیط production نیست. ساخت پایگاه‌داده و حساب محدود، در صورت نیاز، جداگانه و با اسکریپت `apps/api/sql/provision.sql` انجام می‌شود.

```bash
# از پوشه apps/api
# مقصد را آگاهانه انتخاب کنید؛ برای پایگاه آزمون هم همین مقدار را صریح تغییر دهید.
DB_NAME=enterprise_knowledge_copilot uv run --locked python -m app.cli.seed_accounts
uv run --locked python -m app
```

درخواست‌های تغییردهنده باید هدر `Origin` هم‌مبدأ داشته باشند:

```bash
# گذرواژه با prompt خصوصی خوانده می‌شود؛ در argv یا history قرار نمی‌گیرد.
python3 - <<'PY'
import getpass
import json
from urllib.request import Request, urlopen

payload = json.dumps({"login": "employee", "password": getpass.getpass("Password: ")}).encode()
request = Request("http://127.0.0.1:8000/api/auth/login", data=payload, headers={
    "Content-Type": "application/json", "Origin": "http://localhost:3000",
})
with urlopen(request) as response:
    print(response.status, response.read().decode())  # نقش و login؛ بدون کوکی یا token
PY
```

پاسخ موفق `200` با نقش است و کوکی `ekc_session` با `HttpOnly` و `SameSite=lax` می‌فرستد. `GET /api/auth/me` با همان کوکی هویت و نقش جاری را برمی‌گرداند و نقش همیشه از رکورد کاربر در پایگاه‌داده خوانده می‌شود، نه از ادعای کلاینت. `POST /api/auth/logout` نشست را باطل می‌کند. پاسخ خطا هیچ‌گاه فرق بین حساب ناموجود، رمز غلط و حساب غیرفعال را آشکار نمی‌کند.

## سه خروجی این مرحله

1. [مشخصات محصول](docs/PRD.md): مسئله، کاربران، قابلیت‌ها، معماری پیشنهادی و معیارهای پذیرش.
2. [فهرست اسناد](docs/corpus-index.md) و پوشهٔ [corpus](corpus/): بیست سند اولیه با نقش و بخش‌های قابل استناد.
3. [چهل سؤال و پاسخ برای مرور](docs/evaluation-questions.md)، [راهنمای ارزیابی](docs/evaluation-guide.md) و [فایل دادهٔ ارزیابی](eval/questions.jsonl): سؤال‌ها، رفتار و پاسخ مورد انتظار، منابع و ممنوعیت‌های دسترسی.

[قرارداد مشترک داده‌های فرضی](docs/fictional-company-contract.md) مرجع یکسان‌سازی قوانین این مجموعه است. تمام خروجی‌ها باید با آن سازگار باشند.

## مستندات اصلی پیاده‌سازی

ساختار و ترتیب بخش‌ها مطابق Part 2 [مرجع مستندسازی کاربر](https://docs.google.com/document/d/14GR5EhXGuyX7xRea52ZP3h5vQEP2Egcwvx_SusGWkCc/edit) است:

| سند | موضوع |
|---|---|
| [PRD](docs/PRD.md) | محصول، دامنه و معیار پذیرش |
| [DESIGN_SYSTEM](docs/DESIGN_SYSTEM.md) | قواعد دقیق طراحی Notion و تطبیق فارسی RTL |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | اجزا، جریان داده و تصمیم‌های فنی |
| [DATABASE](docs/DATABASE.md) | جدول‌ها، ارتباط‌ها و migration امن |
| [SECURITY](docs/SECURITY.md) | هویت، مجوز، رازها و محافظت داده |
| [CODE_STYLE](docs/CODE_STYLE.md) | قراردادهای کدنویسی |
| [TESTING](docs/TESTING.md) | بررسی رفتار، امنیت و کیفیت پاسخ |
| [AGENTS](docs/AGENTS.md) | قواعد کار عامل‌های پیاده‌سازی |

[برنامهٔ اجرای ۱۹ پارت](docs/plans/plans.md) مرجع یگانهٔ ترتیب و وضعیت است؛ [مرجع فنی قراردادها و مثال‌ها](docs/plans/technical-details.md) جزئیات طراحی را به پارت‌های مرتبط نگاشت می‌کند. هشت سند اصلی مرجع تصمیم‌های جاری‌اند. اسناد قدیمی در [آرشیو مستندات](docs/archive/README.md) صرفاً برای سابقه نگهداری می‌شوند و مرجع اجرای کار نیستند. نسخهٔ کامل فایل طراحی در [مرجع Notion](docs/references/notion-DESIGN.md) و متن Part 2 در [مرجع مستندسازی](docs/references/part2-documentation-reference.txt) نگهداری می‌شوند؛ مثال‌ها و دستورهای عمومی این منابع به‌تنهایی مجوز اجرای کار اضافی نیستند.

## سرویس‌ها و تنظیمات محلی

- تولید پاسخ: OpenRouter؛ مقدار `OPENROUTER_API_KEY=` را در فایل محلی `.env` پر کنید. کلید را در گفتگو یا فایل‌های قابل commit قرار ندهید.
- embedding: Ollama موجود در `127.0.0.1:11434`، مدل `nomic-embed-text-v2-moe:latest`، 768 بُعد. بررسی محلی 2026-10-04: digest برابر `ff9c2f10ef5e`، دو خروجی فارسی با ابعاد صحیح. پیشوندهای query/document و سقف 512 توکن مدل طبق [کارت رسمی Nomic](https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe)؛ بودجهٔ آغازین ورودی کامل 400 توکن و `truncate=false`.
- PostgreSQL موجود: کانتینر `rag-postgres`، پورت میزبان 5433؛ نسخهٔ 16.15 و pgvector 0.8.6 با بررسی خواندنی تأیید شدند. در ۲۰۲۶-۱۰-۰۴ پایگاه‌های `enterprise_knowledge_copilot` و `enterprise_knowledge_copilot_test` با حساب محدود `enterprise_knowledge_copilot` ساخته شد، `pgvector 0.8.6` در هر دو فعال است و schema با migration `0001` اجرا شد. `DB_PASSWORD` در `.env` محلی پر شده و ساخت DBها با اسکریپت idempotent در `apps/api/sql/provision.sql` انجام می‌شود. داده‌ها و volumeهای `rag_support` قبلی تغییر نکرده‌اند و هیچ DB container تازه‌ای ساخته نشده است.
- API FastAPI و رابط Next.js هر دو روی میزبان محلی اجرا می‌شوند. رابط ورود از proxy هم‌مبدأ به API و نشست DB متصل است؛ قابلیت‌های اسناد و پرسش‌وپاسخ و provider هنوز در پارت‌های آینده‌اند. هیچ DB container تازه لازم نیست.
- rerank اختیاری و پیش‌فرض خاموش است (`RERANK_ENABLED=false`). در صورت فعال‌سازی، `RERANK_PROVIDER=openrouter` و `OPENROUTER_RERANK_MODEL=nvidia/llama-nemotron-rerank-vl-1b-v2:free` از همان `OPENROUTER_API_KEY` و `OPENROUTER_BASE_URL` تولید استفاده می‌کنند؛ کلید جداگانهٔ rerank وجود ندارد. این endpoint رایگان داده‌ها را برای امنیت و بهبود محصول ثبت می‌کند؛ فقط corpus ساختگی و غیرشخصی پروژه مجاز است و دادهٔ محرمانه یا شخصی نباید ارسال شود. پشتیبانی/دسترسی واقعی و رفتار رتبه‌بندی فارسی هنوز باید با preflight و نمونهٔ کوچک بررسی شود.
- `.env.example` قالب بدون راز است؛ `.env` با دسترسی فایل 600 و قواعد ignore آماده شده است. backend باید فایل ریشه را صریحاً بارگذاری کند؛ Next فقط پیکربندی سروری لازم را می‌خواند و هیچ راز `NEXT_PUBLIC_` ندارد.

## محدودهٔ توافق‌شده

- دامنه: منابع انسانی و عملیات یک شرکت فرضی.
- هدف: محصولی محدود، کامل و قابل اندازه‌گیری برای رزومهٔ AI Engineer.
- نقش‌های اولیه: کارمند و مدیر؛ مدیر مدیریت اسناد را نیز انجام می‌دهد.
- هسته: دریافت سند، جست‌وجوی مجاز، پاسخ مستند، عدم پاسخ‌گویی در نبود شواهد، ارزیابی و نمایش منابع.
- قابلیت‌های تکمیلی مثل OCR، اتصال Drive، چند شرکت، حافظهٔ مکالمه، کش معنایی و معماری توزیع‌شده خارج از نسخهٔ اول‌اند.

جزئیات سیاست‌ها، تعداد اسناد و رفتارهای محصول در این بسته، پیشنهاد طراحی و دادهٔ ساختگی هستند؛ آمادهٔ بازبینی پیش از پیاده‌سازی.

## ساختار داده‌ها

هر سند Markdown شناسهٔ ثابت، عنوان، نقش دسترسی، نسخه و وضعیت دارد. هر بخش پاسخ‌پذیر یک section_id پایدار دارد. این شناسه‌ها مبنای پاسخ مرجع‌اند؛ شناسهٔ chunk در زمان پیاده‌سازی ایجاد می‌شود.

هر خط questions.jsonl یک نمونهٔ مستقل JSON است. منابع مرجع فقط از اسناد مجاز آن نمونه انتخاب می‌شوند؛ شناسهٔ سند محرمانه در forbidden_document_ids، دادهٔ داخلی ارزیابی است و نباید به کاربر یا مدل نامجاز فرستاده شود.

## ادامهٔ کار

پارت‌های ۱ تا ۴ منتشر شده‌اند؛ SHA پیاده‌سازی و بررسی‌های ثبت‌شدهٔ آن‌ها در [برنامهٔ اجرا](docs/plans/plans.md) آمده است. Part 5 منتشر و تکمیل شده است؛ پارت ۶ شروع نشده و فقط با درخواست مستقل کاربر آغاز می‌شود. وضعیت جاری و checkboxهای تأیید/انتشار فقط پس از بازبینی، تأیید کاربر و انتشار موفق به‌روزرسانی می‌شوند. اتصال واقعی مدل‌ها در پارت مربوط با ورودی کوچکِ توسعه بررسی خواهد شد. کلیدها در محیط محلی خارج از کنترل نسخه تنظیم می‌شوند و سقف هزینهٔ API پیش از ارزیابی پولی تعیین می‌شود. ارزیابی کیفیت پاسخ، هزینه و سرعت محصول هنوز انجام نشده است؛ داده‌های مرجع به معنای موفقیت سیستم نیستند.
