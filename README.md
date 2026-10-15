# Enterprise Knowledge Copilot

دستیار فارسی برای پرسیدن سؤال از اسناد سازمانی و دیدن پاسخ همراه با منبع. در نصب اولیه هیچ سند نمونه‌ای بارگذاری نمی‌شود؛ مدیر نام سازمان را ثبت می‌کند و اسناد خود سازمان را از پنل مدیریت اضافه می‌کند.

> **داده و حریم خصوصی:** محصول بدون سند نمونه آغاز می‌شود و مدیر باید فقط اسنادی را بارگذاری کند که سازمان مجاز به پردازش آن‌هاست. پیش از فعال‌کردن provider بیرونی، خروج پرسش و شواهد ارسالی برای تولید یا بازرتبه‌بندی را با سیاست حریم خصوصی سازمان تطبیق دهید.

## راه‌اندازی production

مسیر پیشنهادی Docker Compose است. سرویس‌های وب، API، worker و PostgreSQL را اجرا می‌کند و migration پایگاه‌داده را خودکار انجام می‌دهد.

### نیازمندی‌ها

- Docker با Docker Compose v2
- دسترسی اینترنت برای دریافت imageها و ساخت برنامه

### ۱. دریافت پروژه

```bash
git clone https://github.com/AmirRghp/enterprise-knowledge-copilot.git
cd enterprise-knowledge-copilot
cp .env.example .env
```

### ۲. تنظیم محیط

در فایل `.env` مقدارهای نمونه را با دو گذرواژهٔ جدا و قوی جایگزین کنید:

```dotenv
POSTGRES_PASSWORD=replace-with-a-strong-unique-password
DB_PASSWORD=replace-with-another-strong-unique-password
```

اگر در پنل از provider دارای API key استفاده می‌کنید، کلید رمزگذاری بسازید. خروجی فرمان را جای خالی `APP_ENCRYPTION_KEY=` در `.env` قرار دهید. برای Ollama بدون API key می‌توانید این مرحله را رد کنید.

```bash
docker compose run --build --rm --no-deps api python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

این کلید را امن نگه دارید و پس از ذخیرهٔ کلیدهای provider عوض نکنید؛ بدون آن برنامه نمی‌تواند کلیدهای ذخیره‌شده را بخواند.

### ۳. اجرای برنامه

```bash
docker compose up -d --build
docker compose ps
```

پس از آماده‌شدن سرویس‌ها، برنامه را باز کنید:

- برنامه: [http://localhost:3000](http://localhost:3000)
- راه‌اندازی مدیر نخست: [http://localhost:3000/setup](http://localhost:3000/setup)

در نصب تازه، نام شرکت/سازمان و حساب مدیر نخست را در صفحهٔ setup ثبت کنید. این صفحه پس از ساخت اولین حساب بسته می‌شود. مدیرهای بعدی را از `/manager/users` اضافه کنید.

### ۴. اتصال مدل‌ها

در `/manager/providers` دست‌کم یک اتصال **embedding** و یک اتصال **chat** اضافه، آزمایش و فعال کنید. نصب تازه اتصال provider ندارد. بازرتبه‌بندی اختیاری است و به‌صورت پیش‌فرض خاموش می‌ماند.

برای OpenAI یا OpenRouter، نوع اتصال، نام مدل و کلید API را وارد کنید. برای Ollama، سرور مدل را جداگانه اجرا کنید و مطمئن شوید از API قابل دسترسی است؛ Compose خود Ollama یا مدل را نصب نمی‌کند. [راهنمای اتصال Ollama](ollama-setup.md) تنظیمات میزبان و Docker را توضیح می‌دهد.

#### Linux با Docker Engine و Ollama محلی

اگر Ollama روی همین میزبان Linux اجرا می‌شود، به‌جای فرمان معمولی Compose در مرحلهٔ قبل، از فایل تکمیلی پروژه استفاده کنید تا API و worker بتوانند از راه امن relay به Ollama میزبان وصل شوند:

```bash
docker compose -f compose.yaml -f compose.ollama-linux.yaml up -d --build
```

خود Ollama و مدل‌هایش باید جداگانه روی میزبان نصب و اجرا شوند. برای دیدن گزارش یا توقف این سرویس‌ها، همین دو فایل را هم به فرمان Compose بدهید. جزئیات اتصال و عیب‌یابی در [راهنمای Ollama](ollama-setup.md) است.

### ۵. بارگذاری اسناد سازمان

در `/manager/documents` اسناد مجاز سازمان را بارگذاری کنید. پردازش در پس‌زمینه انجام می‌شود؛ پس از آماده‌شدن سندها، صفحهٔ پرسش را در [http://localhost:3000/ask](http://localhost:3000/ask) باز کنید. مخزن و image production اسناد نمونه ندارند.

## مدیریت اجرا

```bash
docker compose logs -f api worker web  # مشاهدهٔ گزارش سرویس‌ها
docker compose down                    # توقف؛ داده‌های پایگاه باقی می‌مانند
```

وب روی `localhost:3000` و PostgreSQL به‌طور پیش‌فرض روی `localhost:5434` در دسترس‌اند. برای تغییر درگاه PostgreSQL، مقدار `POSTGRES_HOST_PORT` را در `.env` تغییر دهید. سرویس‌ها فقط روی loopback میزبان bind می‌شوند.

`docker compose down` داده‌ها را نگه می‌دارد. اجرای `docker compose down -v` volume پایگاه‌داده را حذف می‌کند و همهٔ داده‌های آن را از بین می‌برد. گذرواژهٔ `POSTGRES_PASSWORD` فقط هنگام ساخت volume تازه اعمال می‌شود؛ تغییر آن در `.env`، گذرواژهٔ volume موجود را عوض نمی‌کند.

## اجرای بدون Docker

این روش برای توسعه است و به Python 3.12، [`uv`](https://docs.astral.sh/uv/)، Node.js 22 یا بالاتر، npm و PostgreSQL 16 همراه افزونهٔ pgvector نیاز دارد. پایگاه و نقش محدود برنامه را طبق [راهنمای پایگاه‌داده](docs/DATABASE.md) آماده کنید، سپس از ریشهٔ مخزن اجرا کنید:

```bash
cp .env.example .env
./run.sh
```

`run.sh` وابستگی‌ها را همگام می‌کند، migrationهای برنامه را اجرا می‌کند و API، وب و worker را بالا می‌آورد. با `Ctrl+C` هر سه متوقف می‌شوند. این اسکریپت PostgreSQL را نصب یا راه‌اندازی نمی‌کند.

## قابلیت‌ها

- گفت‌وگوی چندنوبتی فارسی با تاریخچهٔ پایدار و مخصوص هر حساب، حتی پس از خروج.
- بازیابی واژگانی و معنایی در اسناد مجاز و پاسخ همراه با منبع.
- نمایش پیوند منبع و نقل‌قول تأییدشده در جزئیات هر پاسخ.
- مدیریت حساب‌ها و چرخهٔ عمر اسناد Markdown، متن ساده، PDF، DOCX، XLSX و XLS برای مدیر؛ متن را نیز می‌توان در فرم نوشت یا چسباند.
- providerهای قابل تنظیم برای chat و embedding؛ بازرتبه‌بندی اختیاری.

ارجاع معتبر بودن نقل‌قول را می‌سنجد، اما درستی معنایی همهٔ نثر مدل را تضمین نمی‌کند. کیفیت پاسخ را با بازبینی انسانی ارزیابی کنید.

## اسناد

- [معماری و اجزای سامانه](docs/ARCHITECTURE.md)
- [پایگاه‌داده و migrationها](docs/DATABASE.md)
- [امنیت و حریم داده](docs/SECURITY.md)
- [راهبرد آزمون و نتایج](docs/TESTING.md)
- [راهنمای ارزیابی پاسخ و بازیابی](docs/evaluation-guide.md)
- [نظام طراحی](docs/DESIGN_SYSTEM.md) و [شیوهٔ کدنویسی](docs/CODE_STYLE.md)
- [برنامه و وضعیت انتشار](docs/plans/plans.md)

## مجوز

این مخزن فایل مجوز ندارد؛ پیش از استفاده یا بازتوزیع، شرایط را از مالک پروژه بپرسید.

## فرمان‌های توسعه

```bash
(cd apps/api && uv run --locked pytest -q)
(cd apps/api && uv run --locked ruff check .)
(cd apps/api && uv run --locked mypy app)
(cd apps/web && npm run lint)
(cd apps/web && npm run typecheck)
(cd apps/web && npm run build)
```
