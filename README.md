# Enterprise Knowledge Copilot

دستیار فارسی برای پرسیدن سؤال از اسناد سازمانی و دیدن پاسخ همراه با ارجاع به منبع. کارمند فقط اسناد عمومیِ مجاز را می‌بیند؛ مدیر به اسناد مدیریتی هم دسترسی دارد و می‌تواند سندهای Markdown و متن ساده را بارگذاری، جایگزین یا حذف کند.

این مخزن یک نمونهٔ قابل اجرای محلی با داده‌های ساختگی شرکت فرضی «سپهر داده» است. سیاست‌ها، نام‌ها و افراد واقعی نیستند. این نرم‌افزار برای تصمیم‌گیری منابع انسانی، مشاورهٔ حقوقی یا استفاده با اسناد محرمانه آماده نشده است.

## چه کاری انجام می‌دهد؟

- پرسش فارسی را با جست‌وجوی واژگانی و معنایی در اسناد مجاز بررسی می‌کند.
- پاسخ را به ادعاهای دارای نقل‌قول و ارجاع به سند و بخش می‌سازد. نقل‌قول پیش از نمایش با متن منبع سنجیده می‌شود؛ اگر ادعایی معتبر نباشد، کل پاسخ رد می‌شود.
- وقتی شواهد کافی در دسترس نباشد، از پاسخ‌سازی خودداری می‌کند.
- دسترسی را در سمت سرور و پیش از بازیابی و تولید پاسخ اعمال می‌کند و پیش از نمایش منبع دوباره می‌سنجد.
- صفحهٔ مدیر برای مشاهدهٔ اسناد و وضعیت پردازش، بارگذاری، جایگزینی و حذف منطقی دارد.
- ارزیابی آفلاین و گزارش‌های عملیاتی دارد که برای بررسی retrieval، مصرف و رفتار سامانه به کار می‌روند.

## اجزای سامانه

| بخش | فناوری | کاربرد |
|---|---|---|
| رابط وب | Next.js، TypeScript، React | رابط فارسی راست‌به‌چپ، ورود، پرسش‌وپاسخ، نمایش منبع و مدیریت سند |
| API و worker | FastAPI، Python 3.12 | احراز هویت، مجوز، بازیابی، تولید پاسخ و پردازش صف پایدار سند |
| پایگاه‌داده | PostgreSQL 16 و pgvector | حساب‌ها، اسناد، نسخه‌ها، قطعه‌ها و بردارهای embedding |
| embedding | اتصال انتخابی مدیر از OpenAI، OpenRouter یا Ollama | شناسهٔ مدل آزادانه انتخاب می‌شود؛ آزمون اتصال بُعد بردار را تعیین می‌کند |
| تولید پاسخ | زنجیرهٔ provider تنظیم‌شده در پایگاه‌داده | ساخت پاسخ ساختاریافته از شواهد مجاز |
| بازرتبه‌بندی | زنجیرهٔ provider تنظیم‌شده در پایگاه‌داده، اختیاری و خاموش به‌صورت پیش‌فرض | مرتب‌سازی دوبارهٔ نامزدهای مجاز |

جریان یک پرسش چنین است:

```text
کاربر واردشده → فیلتر دسترسی در پایگاه‌داده → جست‌وجوی واژگانی و برداری
               → ادغام رتبه‌ها → (بازرتبه‌بندی اختیاری) → تولید پاسخ
               → بررسی نقل‌قول و دسترسی جاری → پاسخ و ارجاع
```

## پیش‌نیازها

برای مسیر Docker Compose فقط Docker با Compose و دسترسی شبکه برای دریافت imageها لازم است. Compose مدل یا سرویس Ollama همراه برنامه نصب نمی‌کند؛ providerهای OpenAI، OpenRouter یا Ollama را در پنل مدیر به‌صورت اختیاری تنظیم کنید. برای اجرای بدون container به پیش‌نیازهای بخش «اجرای native» نیاز دارید. راهنماهای رسمی: [ترتیب شروع سرویس‌ها در Compose](https://docs.docker.com/compose/how-tos/startup-order/)، [خروجی standalone در Next.js](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)، [تصویر Docker در pgvector](https://github.com/pgvector/pgvector#docker)، [Embeddingهای OpenRouter](https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings) و [مدل‌های embedding در Ollama](https://docs.ollama.com/capabilities/embeddings).

## اجرای Docker Compose

این مسیر برای نصب تازه است و volume تازه‌ای برای پایگاه‌داده می‌سازد؛ داده‌های PostgreSQL میزبان یا نصب قبلی را منتقل نمی‌کند. مدل و provider بیرونی در صورت نیاز جداگانه پیکربندی می‌شوند. `run.sh` همچنان مسیر اجرای native است.

پورت ۳۰۰۰ برای وب و پورت انتخابی PostgreSQL باید آزاد باشند؛ اجرای native قبلی برنامه روی ۳۰۰۰ را پیش از بالا آوردن Compose متوقف کنید.

```bash
git clone https://github.com/AmirRghp/enterprise-knowledge-copilot.git
cd enterprise-knowledge-copilot
cp .env.example .env
chmod 600 .env
```

در `.env`، برای حساب bootstrap پایگاه `POSTGRES_PASSWORD` و برای role محدود برنامه `DB_PASSWORD` را جداگانه تنظیم کنید. `POSTGRES_HOST_PORT` به‌طور پیش‌فرض `5434` است و سرویس فقط روی loopback میزبان bind می‌شود. مقدار `APP_ENCRYPTION_KEY` را با فرمان زیر بسازید و خروجی را در `.env` قرار دهید:

```bash
docker compose run --build --rm --no-deps api python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

کلید را ثابت و امن نگه دارید؛ تعویض آن API keyهای provider ذخیره‌شده را غیرقابل‌خواندن می‌کند.

```bash
docker compose up -d --build
```

Compose پایگاه را آماده می‌کند، migration یک‌باره را اجرا می‌کند و سپس API، worker و وب را بالا می‌آورد. پس از بالا آمدن سرویس‌ها، در [صفحهٔ setup](http://localhost:3000/setup) مدیر نخست را بسازید. در `/manager/providers` می‌توانید برای embedding چند اتصال از نوع OpenAI، OpenRouter یا Ollama با مدل دلخواه تعریف کنید؛ endpoint Ollama باید از container API قابل دسترسی باشد. اتصال‌ها را آزمایش کنید و یکی را فعال کنید. نصب تازه provider پیش‌فرض ندارد و import سند تا فعال‌شدن embedding قابل پردازش نیست. اتصال chat برای پاسخ‌گویی جداگانه تنظیم می‌شود؛ rerank اختیاری است.

برای OpenAI یا OpenRouter، نوع provider، شناسهٔ مدل و API key حساب خود را در پنل وارد کنید؛ این کلید رمزگذاری‌شده در DB ذخیره می‌شود. برای Ollama شخصی روی میزبان Linux، مدل دلخواه را خودتان در Ollama نصب کنید و endpoint آن را برای شبکهٔ Docker قابل دسترسی کنید؛ در فرم آدرس `http://host.docker.internal:11434` را بگذارید. Ollama که فقط روی `127.0.0.1` گوش می‌دهد از کانتینر قابل دسترسی نیست؛ تنظیم `OLLAMA_HOST=0.0.0.0:11434` برای سرویس شخصی و محدودکردن دسترسی با firewall میزبان لازم است. Compose Ollama را اجرا یا مدل را دانلود نمی‌کند.

اگر corpus قبلاً بردار دارد، پیش از فعال‌کردن embedding تازه تعداد سندها و هشدار ارسال متن/هزینه را مرور و بازسازی نمایه را صریحاً تأیید کنید. بازسازی پایدار است: حلقهٔ پیشرفت درصد انجام‌شده از کل قطعه‌ها را نشان می‌دهد و پس از refresh یا راه‌اندازی مجدد ادامهٔ وضعیت را نمایش می‌دهد. جست‌وجو تا تعویض اتمی از نمایهٔ قبلی استفاده می‌کند؛ شکست بازسازی هم نمایهٔ قبلی را حفظ می‌کند. هنگام بازسازی بارگذاری و جایگزینی سند موقتاً بسته‌اند، اما حذف سند و دکمهٔ مستقل «محدود کردن دسترسی به مدیران» در صفحهٔ اسناد مجاز می‌مانند. پس از پایان موفق، همان حلقه ۱۰۰٪ و «پروسه تکمیل شد» را نشان می‌دهد.

برای بارگذاری corpus نمونه، login ایمیل مدیر واقعی را جایگزین کنید:

```bash
docker compose exec api python -m app.cli.import_corpus --manager-login admin@example.com
```

`POSTGRES_HOST_PORT` درگاه PostgreSQL را روی میزبان تعیین می‌کند و پیش‌فرض آن `5434` است. داخل شبکهٔ Compose، API به `postgres:5432` و پایگاه `enterprise-pgvector` متصل می‌شود؛ تنظیم native `DB_*` دست‌نخورده می‌ماند. جزئیات در [معماری](docs/ARCHITECTURE.md) و [پایگاه‌داده](docs/DATABASE.md) آمده است.

برای نمونه، با `POSTGRES_HOST_PORT=5544` در `.env` و اجرای دوبارهٔ `docker compose up -d` پورت میزبان به ۵۵۴۴ تغییر می‌کند. با `docker compose down` سرویس‌ها متوقف می‌شوند و volume پایگاه باقی می‌ماند؛ گزینهٔ `-v` دادهٔ آن را حذف می‌کند. رمزهای PostgreSQL فقط هنگام ساخت نخستین volume اعمال می‌شوند؛ ویرایش `.env` روی volume موجود رمز DB را تغییر نمی‌دهد. API پورت میزبان ندارد و فقط داخل شبکهٔ Compose در دسترس است.

## اجرای native

- Python 3.12 و [`uv`](https://docs.astral.sh/uv/)
- Bash نسخهٔ ۴٫۳ یا بالاتر برای اجرای `run.sh`
- Node.js نسخهٔ ۲۲ یا بالاتر و npm
- PostgreSQL 16 با افزونهٔ `pgvector`
- دسترسی به providerهای موردنیاز و credentialهایشان برای اتصال‌هایی که مدیر ثبت می‌کند
- دسترسی شبکه به Hugging Face هنگام اولین پردازش سند، یا tokenizer ازپیش‌دریافت‌شده

پیکربندی نمونهٔ مخزن برای PostgreSQL روی `127.0.0.1:5433` نوشته شده است. اگر PostgreSQL شما روی میزبان یا درگاه دیگری است، `DB_HOST` و `DB_PORT` را در `.env` با همان مقدارها تنظیم کنید. جزئیات آماده‌سازی نقش محدود و پایگاه‌های جداگانهٔ برنامه و آزمون در [راهنمای پایگاه‌داده](docs/DATABASE.md) آمده است.

## اجرای محلی

### ۱. دریافت مخزن و تنظیم محیط

```bash
git clone https://github.com/AmirRghp/enterprise-knowledge-copilot.git
cd enterprise-knowledge-copilot
cp .env.example .env
chmod 600 .env
```

در `.env` این مقدارها را تنظیم کنید:

| متغیر | مقدار |
|---|---|
| `DB_PASSWORD` | رمز حساب محدود برنامه در PostgreSQL |
| `APP_ENCRYPTION_KEY` | کلید Fernet برای رمزگذاری کلیدهای provider؛ در مدیر اسرار نگهداری شود |

نصب تازه اتصال provider ندارد و تنظیم‌های provider از `.env` خودکار import نمی‌شوند. پس از ورود مدیر، اتصال‌ها را در `/manager/providers` ثبت کنید.

در تب `chat` برای هر اتصال مقدار `Temperature (تنوع پاسخ)` جداگانه تنظیم می‌شود؛ مقدار تازه `0.7` است و دامنهٔ مجاز ۰ تا ۲. این گزینه روی اتصال‌های rerank و embedding کاربرد ندارد.

`WEB_ORIGIN` را با نشانی‌ای که برای بازکردن رابط استفاده می‌کنید هماهنگ نگه دارید. مقدار پیش‌فرض `http://localhost:3000` است؛ `localhost` و `127.0.0.1` مبدأهای متفاوت‌اند.

### ۲. آماده‌سازی PostgreSQL

یک سرویس PostgreSQL 16 با افزونهٔ نصب‌شدهٔ `pgvector` آماده کنید. فایل `apps/api/sql/provision.sql` نقش کم‌دسترسی پروژه، پایگاه برنامه و پایگاه آزمون را ایجاد می‌کند و پیش از تغییر، مالکیت و سطح دسترسی نام‌های موجود را بررسی می‌کند. فرمان زیر را از ریشهٔ مخزن اجرا کنید؛ اگر میزبان، درگاه یا نام حساب مدیر شما فرق دارد، همان گزینه‌ها را تغییر دهید. رمز حساب برنامه را در prompt وارد کنید و همان مقدار را در `DB_PASSWORD` فایل `.env` بگذارید:

```bash
(
  read -rsp 'رمز حساب برنامه: ' EKC_DB_PASSWORD
  printf '\n'
  export EKC_DB_PASSWORD
  psql -h 127.0.0.1 -p 5433 -U postgres -d postgres \
    -v ON_ERROR_STOP=1 -f apps/api/sql/provision.sql
)
```

این فرمان باید با حساب مدیر PostgreSQL اجرا شود؛ حسابی که برنامه استفاده می‌کند محدود است و مجوز ساخت role یا database ندارد. راهنمای [DATABASE.md](docs/DATABASE.md) جزئیات بررسی‌های اسکریپت و روش اجرای آن روی سرویس PostgreSQL فعلی مخزن را دارد. اگر مقادیر اتصال شما متفاوت‌اند، `DB_HOST` و `DB_PORT` در `.env` را نیز به‌روز کنید.

برای راه‌اندازی PostgreSQL، login و پنل مدیریت نیازی به provider مدل نیست. پیش از پردازش سند، یک اتصال embedding از OpenAI، OpenRouter یا Ollama را با مدل دلخواه در پنل مدیر تنظیم، آزمایش و فعال کنید. برای Ollama، server انتخابی باید جداگانه اجرا شود و از API قابل دسترسی باشد.

### ۳. نصب، ساخت کلید رمزگذاری و migration

ابتدا وابستگی‌ها را نصب کنید:

```bash
(cd apps/api && uv sync --locked)
```

`APP_ENCRYPTION_KEY` را پیش از ذخیرهٔ نخستین API key به‌صورت یک کلید Fernet معتبر و ثابت تنظیم کنید؛ برای رمزگذاری و بازیابی API key لازم است. login، نصب بدون provider و اتصال Ollama بدون API key از این کلید استفاده نمی‌کنند. آن را در مدیر اسرار نگه دارید، یا یک‌بار با Python در `.env` بسازید. پس از ذخیرهٔ API key کلید را عوض نکنید مگر آنکه مقدارهای ذخیره‌شده را با سازوکار چرخش کلید بازرمزگذاری کنید؛ جایگزینی کلید، API keyهای موجود را غیرقابل‌خواندن می‌کند. فرمان مقدار کلید را چاپ نمی‌کند، کلید معتبر موجود را نگه می‌دارد، مقدار خالی را تولید می‌کند و اگر مقدار غیرخالی نامعتبر باشد متوقف می‌شود؛ مقدارهای دیگر را حفظ می‌کند و mode فایل را `0600` می‌گذارد:

```bash
(cd apps/api && uv run --locked python - <<'PY'
from pathlib import Path
from cryptography.fernet import Fernet

path = Path('../../.env')
lines = path.read_text(encoding='utf-8').splitlines()
key_index = next((i for i, line in enumerate(lines) if line.startswith('APP_ENCRYPTION_KEY=')), None)
if key_index is not None:
    key = lines[key_index].partition('=')[2].strip()
    if key:
        Fernet(key.encode())
    else:
        lines[key_index] = f"APP_ENCRYPTION_KEY={Fernet.generate_key().decode()}"
else:
    entry = f"APP_ENCRYPTION_KEY={Fernet.generate_key().decode()}"
    lines.append(entry)
path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
path.chmod(0o600)
PY
)
```

سپس schema برنامه را به‌روز کنید:

```bash
(cd apps/api && uv run --locked alembic upgrade head)
```

### ۴. اجرای برنامه

از ریشهٔ مخزن اجرا کنید:

```bash
./run.sh
```

اسکریپت وابستگی‌های Python و در صورت نیاز وابستگی‌های وب را همگام می‌کند، migrationهای معوق را روی پایگاه برنامه اجرا می‌کند و API، رابط توسعهٔ وب و worker مقیم را بالا می‌آورد. پیش از شروع provider یا embedding را بررسی نمی‌کند؛ بنابراین می‌توان ابتدا UI و ورود را آماده کرد. با `Ctrl+C` هر سه فرایند متوقف می‌شوند. PostgreSQL باید آماده باشد؛ اسکریپت دادهٔ موجود را بازنشانی نمی‌کند.

رابط در [http://localhost:3000](http://localhost:3000) در دسترس است. در نخستین بازدید از نصب خالی، به `/setup` بروید و نام، نام خانوادگی، `admin@example.com` و گذرواژهٔ ۱۲ تا ۵۱۲ نویسه‌ای وارد کنید؛ setup مدیر و نشست او را یکجا می‌سازد و پس از ایجاد هر کاربر برای همیشه بسته می‌شود. در صفحهٔ ورود از `admin@example.com` یا `employee@example.com` استفاده کنید و گذرواژه را در فرم وارد کنید؛ رمزها در این راهنما یا مخزن قرار نمی‌گیرند. صفحهٔ `/manager/users` برای ساخت حساب دکمهٔ «کاربر جدید» دارد و «ویرایش» هر ردیف، نام‌ها، ایمیل، نقش، وضعیت و گذرواژهٔ اختیاری را در dialog باز می‌کند. گذرواژهٔ خالی یعنی حفظ رمز فعلی؛ dialog پس از ذخیرهٔ موفق بسته می‌شود و خطا آن را باز نگه می‌دارد. سپس در `/manager/providers` اتصال‌های لازم را ثبت کنید. برای هر اتصال نام نمایشی اجباری است و حداکثر ۱۰۰ نویسه دارد. کلید API هنگام ثبت پذیرفته می‌شود و هرگز در پاسخ API یا رابط دوباره بازگردانده نمی‌شود؛ پس از ذخیره آن را از UI نمی‌توان بازیابی کرد. سپس اگر از corpus نمونه استفاده می‌کنید، آن را به‌عنوان مدیر وارد کنید:

```bash
(cd apps/api && DB_NAME=enterprise_knowledge_copilot uv run --locked python -m app.cli.import_corpus --manager-login admin@example.com)
```

ایمیل‌های بالا فقط مثال‌اند؛ از ایمیلی که خودتان ثبت کرده‌اید استفاده کنید. نصب دارای کاربر همچنان صفحهٔ ورود دارد و شناسه‌ها و رمزهای قبلی آن حفظ می‌شوند؛ برای نمونه، حساب قدیمی `manager` با همان شناسه وارد می‌شود. نام کاربران موجود ناشناخته می‌ماند تا خود مدیر آن را ویرایش کند؛ migration برای آن‌ها نام حدس نمی‌زند. حساب تازه را فقط یک مدیر می‌سازد.

صفحهٔ پرسش `/ask` و صفحه‌های مدیریت کاربران و اسناد به‌ترتیب `/manager/users` و `/manager/documents` هستند. worker مقیم برای پردازش بارگذاری‌ها و جایگزینی‌ها فعال می‌ماند.

## مرزها و محدودیت‌ها

- corpus، حساب‌ها و سیاست‌ها ساختگی‌اند. دادهٔ واقعی یا محرمانه وارد نکنید.
- تولید و rerank متن پرسش یا شواهد مجاز را به provider انتخاب‌شده در زنجیرهٔ DB می‌فرستند. Rerank به‌طور پیش‌فرض خاموش است.
- اعتبار نقل‌قول نشان می‌دهد نقل‌قول در منبع وجود دارد؛ به‌تنهایی ثابت نمی‌کند که نتیجه‌گیری جمله از آن نقل‌قول درست است. ارزیابی معنایی به بازبینی انسانی نیاز دارد.
- سامانه سیاست را اجرا یا تصویب نمی‌کند و تصمیم‌هایی مانند تأیید مرخصی نمی‌گیرد.
- بارگذاری مدیر فقط فایل‌های `.md` و `.txt` با سقف ۱ MiB را می‌پذیرد. نقش دسترسی سند را مدیر تعیین می‌کند، نه متن فایل.
- این مخزن راه‌اندازی محلی و نمایشی را مستند می‌کند؛ برای استقرار عمومی، بازبینی امنیت، حریم خصوصی، عملیات و ظرفیت لازم است.

## مستندات بیشتر

- [نیازمندی‌های محصول](docs/PRD.md)
- [معماری](docs/ARCHITECTURE.md)
- [امنیت و مرزهای اعتماد](docs/SECURITY.md)
- [پایگاه‌داده و migration](docs/DATABASE.md)
- [راهنمای ارزیابی](docs/evaluation-guide.md)
- [راهبرد آزمون و نتایج ثبت‌شده](docs/TESTING.md)

## فرمان‌های توسعه

```bash
(cd apps/api && uv run --locked pytest -q)
(cd apps/api && uv run --locked ruff check .)
(cd apps/api && uv run --locked mypy app)
(cd apps/web && npm run lint)
(cd apps/web && npm run typecheck)
(cd apps/web && npm run build)
```

## مجوز

در این مخزن فایل مجوزی ارائه نشده است. تا زمان افزودن مجوز، شرایط استفاده و بازتوزیع را از مالک پروژه جویا شوید.

## آزمون‌های proxy با حساب واقعی

`npm run test:users` آزمون قطعی قراردادهای Part 22 است و به سرویس زنده نیاز ندارد. آزمون‌های HTTP `test:answers` و `test:sources` به برنامهٔ در حال اجرا و حساب‌های واقعی نقش مربوط نیاز دارند. رمزها از `.env` خوانده نمی‌شوند؛ آن‌ها را فقط برای همان اجرای آزمون وارد کنید:

```bash
read -rp 'Manager email/login: ' WEB_TEST_MANAGER_LOGIN
read -rsp 'Manager password: ' WEB_TEST_MANAGER_PASSWORD
printf '\n'
read -rp 'Employee email/login: ' WEB_TEST_EMPLOYEE_LOGIN
read -rsp 'Employee password: ' WEB_TEST_EMPLOYEE_PASSWORD
printf '\n'
export WEB_TEST_MANAGER_LOGIN WEB_TEST_MANAGER_PASSWORD WEB_TEST_EMPLOYEE_LOGIN WEB_TEST_EMPLOYEE_PASSWORD
(cd apps/web && npm run test:answers && npm run test:sources)
unset WEB_TEST_MANAGER_LOGIN WEB_TEST_MANAGER_PASSWORD WEB_TEST_EMPLOYEE_LOGIN WEB_TEST_EMPLOYEE_PASSWORD
```

آزمون منبع به corpus نمونهٔ آماده با دستگیره‌های `document_id-S1` نیاز دارد؛ آن را روی محیط آزمون جداگانه اجرا کنید. برای میزبان متفاوت، `WEB_TEST_ORIGIN` و `WEB_TEST_ALLOWED_ORIGIN` را با نشانی وب و `WEB_ORIGIN` آن محیط هماهنگ کنید. برای eval روی حساب‌های تازه، `--employee-login employee@example.com --manager-login admin@example.com` را به فرمان `app.cli.eval_run` بدهید؛ پیش‌فرض‌ها نام‌های قدیمی را برای نصب موجود حفظ می‌کنند.
