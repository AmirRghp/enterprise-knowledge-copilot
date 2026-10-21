# نصب، ارتقا و عملیات

این سند مرزهای عملیاتی را نگه می‌دارد. مراحل شروع جاری در [README](../README.md)، اتصال مدل در [راهنمای Ollama](../ollama-setup.md)، متغیرها در [ENVIRONMENT](ENVIRONMENT.md) و provision پایگاه در [DATABASE](DATABASE.md) است.

## مسیرهای موجود

| حالت | اجزا و اتصال | مرز |
|---|---|---|
| native توسعه | Python 3.12/uv، Node سازگار package.json، PostgreSQL 16/pgvector میزبان؛ run.sh | PostgreSQL نصب/اجرا نمی‌شود؛ run.sh DB_NAME برنامهٔ native را صریح می‌گذارد و مقصد آزمون نیست. |
| Compose تازه | postgres، migrate، api، worker و web | volume مستقل؛ DB enterprise-pgvector؛ model server/وزن بسته‌بندی نمی‌شود. |
| Linux host Ollama | compose.yaml به‌علاوهٔ compose.ollama-linux.yaml | relay سوکت محدود؛ Ollama/مدل باید قبلاً روی میزبان آماده باشد. |

وب و publish DB در Compose روی loopback هستند. HTTPS/reverse proxy، مدیریت دسترسی میزبان و secret برای ارائهٔ عمومی لازم است. WEB_ORIGIN باید مبدا واقعی و API_BASE_URL مقصد server-to-server باشد؛ سرویس داخلی API به‌خودی‌خود نباید عمومی شود.

## روش نصب موجود

۱. طبق README، .env.example را بدون secret واقعی کپی و دو رمز DB مستقل تنظیم کنید.
۲. APP_ENCRYPTION_KEY را در صورت ذخیرهٔ credential provider تولید و امن نگهداری کنید.
۳. Compose انتخابی را با build بالا بیاورید؛ migrate تا head پیش از api/worker اجرا می‌شود.
۴. health/ps، setup مدیر نخست، provider test/activation و سپس upload سند خود سازمان را اجرا کنید.
۵. پس از ready شدن سند پرسش بفرستید و citation را باز کنید. liveness به معنی سلامت provider یا کیفیت پاسخ نیست.

پس از آماده‌سازی image، dependency، وزن و language data، استفادهٔ محلی می‌تواند بدون اینترنت باشد. نصب fresh، دانلود image، وزن مدل و provider cloud به دسترسی شبکه نیاز دارند. defaultهای مدل نمونه در راهنما تضمین کیفیت/مجوز/جاگیری روی هر سخت‌افزار نیستند.

## توقف و ارتقا

```bash
docker compose ps
docker compose logs --tail=100 api worker web
docker compose down
```

در نصب relay، تمام فرمان‌ها باید همان دو فایل -f را داشته باشند. down بدون -v volume را نگه می‌دارد؛ down -v داده را حذف می‌کند و دستور عادی نگهداری نیست.

برای ارتقا، source/image و نسخهٔ schema پیشین ثبت، تغییر migration و backup بررسی، سرویس‌های لازم متوقف/تخلیه، migration افزایشی اعمال و smoke نقش/سند/provider انجام شود. downgrade عمومی و امن برای همهٔ migrationها تضمین نشده است. برگشت image بدون بررسی schema rollback معتبر نیست. با دادهٔ واقعی، تا زمان داشتن restore آزموده، readiness و طرح عملیات مصوب ادعای آمادگی گسترده نکنید.

## برنامهٔ backup/restore

۳۹.۱ باید RPO/RTO و retention را با اپراتور تعیین، از DB سازگار snapshot بگیرد و restore را در مقصد تازه اجرا کند. APP_ENCRYPTION_KEY مستقل و محافظت‌شده backup شود؛ DB تنها برای خواندن credential رمزدار کافی نیست. فایل‌های staging آینده و state sync در دامنهٔ backup طبق lifecycle تصمیم‌گیری شوند.

runbook باید account/document/revision و decrypt provider را پس از restore بررسی کند، failure کلید گمشده را نشان دهد و cleanup را فقط به مقصد موقت محدود کند. در این مرحله هنوز script backup یا نتیجهٔ restore تازه وجود ندارد.

## topology هدف

نسخهٔ جاری یک API و ingestion با concurrency محدود دارد؛ capacity و rate limitها process-local هستند و turnها task داخل API دارند. افزایش تعداد replica بدون اجرای ۴۰.۲–۴۰.۴ مدرک ظرفیت/هماهنگی نیست. readiness و exporter در ۳۹.۲–۳۹.۳، صف پاسخ پایدار و limiter مشترک در ۴۰ عرضه می‌شوند.

## پذیرش و انتشار

برای هر قابلیت انتخاب‌شده، گیت‌های [TESTING](TESTING.md)، مجوز/attribution، migration روی محیط ایزوله، smoke نصب و browser مربوط اجرا شوند. release واقعی با tag/image/SHA، روش ارتقا و محدودیت مشخص شود. نتیجهٔ CI hosted و deploy فقط پس از رخداد واقعی ثبت شود؛ درخواست فعلی مستندسازی، مجوز tag/push/registry/deploy نیست.
