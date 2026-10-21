# ثبت رویداد، سنجش و evidence

## وضعیت موجود

API از logging استاندارد و [StructuredFormatter](../apps/api/app/logging_setup.py) با allowlist استفاده می‌کند. log endpoint پاسخ و metadata جدول request_runs برای عیب‌یابی‌اند. endpoint metrics، backend trace، dashboard و alert خودکار در نسخهٔ فعلی وجود ندارند. health فقط liveness است.

فیلدهای مجاز formatter اکنون: abstained، attempts، claims، duration_ms، missing_parts، reason، request_id، role، sources، provider، model، input_tokens، output_tokens، cost و currency. داشتن نام در allowlist به معنی ثبت آن در هر رخداد نیست؛ null ممکن است چاپ نشود. message نیز نباید از متن ورودی یا خطای خام provider ساخته شود.

جدول request_runs پرسش/پاسخ/prompt/متن سند را ذخیره نمی‌کند. در مقابل conversations و turnها عمداً شامل محتوای گفتگو هستند و برای backup/retention دادهٔ حساس محسوب می‌شوند. artifact ارزیابی با --show-text می‌تواند متن داشته باشد و مجاز به انتشار عمومی خودکار نیست.

## قواعد داده

- گذرواژه، cookie، API key، token OIDC، payload، quote و عنوان/مسیر سند در log/metric/trace قرار نگیرند.
- request_id برای همبستگی در log/trace مناسب است؛ metric label نباشد. user_id، document_id، مسیر فایل و model آزادشکل نیز label پرکاردینال نسازند.
- duration با واحد و مبدأ ساعت مشخص؛ شمارش تلاش، صف، خطا و نتیجه از هم جدا باشند. هزینهٔ نامعلوم صفر نیست و ارزها با هم جمع نمی‌شوند.
- خطاهای provider قبل از ثبت پالایش شوند؛ redirect/endpoint یا DNS ناشناخته مجوز چاپ URI حساس نیست.
- exporter اختیاری باشد؛ مقصد بیرونی و retention با اپراتور مشخص شوند و خاموش‌بودن آن سرویس را مختل نکند.

## targetهای برنامه‌ریزی‌شده

| دامنه | سنجه/رخداد لازم | کارت |
|---|---|---|
| درخواست | count، error class، p50/p95 duration، timeout و abstention جدا | ۳۹.۳ |
| مدل | زمان صف و اجرا، attempts، rate/queue failure، token/cost گزارش‌شده یا unknown | ۳۹.۳ |
| ingestion/source/OCR | job state، lease expiry، scan failure، retry، صفحه/زمان/منابعِ تجمیعی | ۳۹.۳ |
| دسترسی | اقدام مدیریتی و تغییر policy غیرحساس؛ محتوای محدود افشا نشود | ۳۷ و ۳۹.۳ |
| عملیات | readiness، backlog، disk/staging، backup age و restore evidence | ۳۹.۱–۳۹.۴ |
| ظرفیت | workload، سخت‌افزار، corpus و concurrency ثبت‌شده با throughput و error | ۴۰.۱ |

Alert باید شرط/پنجره، مسئول، مسیر delivery و runbook داشته باشد. threshold پس از baseline تعیین شود؛ dashboard دادهٔ واقعی بدون نام/متن سند نشان دهد. استفاده از OTel/Prometheus یا backend دیگر در ۳۹.۳ انتخاب می‌شود؛ dependency امروز تحمیل نشده است.

## گزارش معتبر

هر گزارش source SHA/hash، تاریخ، پیکربندی، داده، محیط و ابزار را ثبت کند. mock، local test، provider زنده، browser واقعی، hosted CI و publish شواهد متفاوت‌اند. ناقص/skip/unknown حفظ شوند؛ failure به‌عنوان دقت صفر یا موفقیت پنهان نشود. گزارش کیفیت معنایی نیازمند rubric ارزیابی است.
