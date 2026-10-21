# خطا، امتناع و بازیابی

این سند رفتار موجود را توصیف و الزام‌های آینده را مشخص می‌کند. مسیرها در [API](API.md)، state رابط در [UX](UX_FLOWS.md) و allowlist ثبت در [پایش](OBSERVABILITY.md) است.

## قالب فعلی

HTTPException معمولاً JSON شامل detail متنی دارد. RequestValidationError سراسری 422 فقط detail از loc/type می‌دهد و input/context را حذف می‌کند. handlerهای JSON دستی مانند prompt/provider/user پیام امن همان endpoint را می‌سازند؛ proxy ممکن است آن را پالایش کند. envelope مشترک error.code در API فعلی وجود ندارد و نباید از template منبع به‌عنوان رفتار موجود کپی شود.

همهٔ exceptionها لزوماً response JSON سفارشی ندارند؛ unexpected error می‌تواند 500 عمومی بدهد. افزودن request_id یا error code جدید به پاسخ‌ها تغییر قرارداد و نیازمند تست همان دامنه است.

## جدول وضعیت

| وضعیت | معنی و رفتار client | مرز |
|---|---|---|
| 200 با abstained=true | شواهد مجاز کافی نیست یا نتیجهٔ معتبر درخواست، خودداری از پاسخ است. | خطای شبکه محسوب نشود و خودکار پاسخ حدسی ساخته نشود. |
| 202 | job سند پذیرفته و هنوز ready نیست. | وضعیت job خوانده شود؛ پذیرش upload موفقیت extraction نیست. |
| 401 | نشست نامعتبر/منقضی؛ پیام عمومی login یا احراز لازم. | حساب ناموجود، رمز غلط و disabled در login یکسان‌اند. |
| 403 | Origin یا نقش/اقدام مجاز نیست. | جزئیات سند غیرمجاز داده نشود. |
| 404 | منبع/چت ناموجود یا غیرقابل دسترس. | افشای وجود، عنوان و مالک ممنوع. |
| 409 | conflict نسخه/CAS، حساب تکراری یا وضعیت مانع عملیات. | اطلاعات تازه خوانده شود؛ درخواست قدیمی بدون بازبینی دوباره ارسال نشود. |
| 413 | سقف file/body رد شده است. | ارسال کوچک‌تر؛ retry همان body فایده ندارد. |
| 415 / 422 | نوع محتوا/schema/مقدار رد شده است. | فرم اصلاح شود؛ پیام upstream و raw input نمایش داده نشود. |
| 429 | سهمیهٔ سؤال یا تلاش login مصرف شده است. | Retry-After موجود رعایت شود؛ client retry بی‌وقفه نکند. |
| 502 | پاسخ provider/اعتبارسنجی قابل تحویل نیست. | پیام عمومی؛ دلیل پالایش‌شده نزد اپراتور با شناسهٔ درخواست. |
| 503 | پیکربندی/ظرفیت/store لازم در دسترس نیست. | queue full با fallback زنجیره اشتباه نشود؛ اقدام عملیاتی/تلاش بعدی. |
| 504 | deadline کلی یا انتظار صف تمام شده. | نتیجهٔ ناتمام تحویل نشود؛ retry گفت‌وگو همان turn را هدف بگیرد. |
| 500 | شکست غیرمنتظره. | stack/secret/prompt در UI نباشد؛ گزارش با context غیرحساس. |

## retry و دوام موجود

Generation retry/repair در بودجهٔ محدود و با evidence تازه انجام می‌شود؛ تغییر مجوز یا منبع، اجازهٔ replay متن قدیمی نیست. fallback فقط طبق زنجیره و طبقهٔ خطای adapter است. exception عمومی به‌عنوان موفقیت یا retry همیشگی گرفته نشود.

ingestion با lease/renew/fencing و حد attempts کار می‌کند؛ فقط job معتبر revision را منتشر می‌کند. replace شکست‌خورده revision جاری قبلی را در صورت مجازبودن حفظ می‌کند. delete/narrowing منتظر job نمی‌ماند.

turnهای گفتگو pending/answered/failed/cancelled هستند. cancel ابتدا وضعیت DB را تغییر می‌دهد و قطع task بهترین‌تلاش است؛ commit دیررس نباید برنده شود. recovery پس از restart، pending بدون کار زنده را در نخستین خواندن به failed قابل retry تبدیل می‌کند؛ اجرای durable بین replicaها هنوز در برنامهٔ ۴۰.۲ است.

## قرارداد شکست قابلیت‌های آینده

- batch: نتیجهٔ هر فایل و retry انتخابی؛ یک خطا نباید قبولی فایل‌های دیگر را جعل یا duplicate کند.
- source: scan ناقص/root قطع‌شده خطاست، نه مجموعهٔ خالی و دستور حذف. removedها تأیید مدیر می‌خواهند.
- ACL/SSO/token: هویت، mapping یا policy نامعتبر fail-closed؛ token revoke/expired یا issuer نامعتبر به دسترسی محلیِ گسترده fallback نشود.
- OCR: صفحهٔ لازمِ timeoutشده job تازه را failed می‌کند؛ partial extraction بدون برچسب/تصمیم روشن ready نشود. child process و temp پس از cancel پاک شوند.
- telemetry: خطای exporter مانع پاسخ معتبر نشود و payload حساس را در fallback log نکند.
- shared limiter/job: شکست store رفتار مصوب و صریح دارد؛ به حالت permissive فرایندمحلی downgrade نشود.

این موارد requirement آزمون کارت مربوط‌اند و در زمان ثبت این سند، response code یا route جدیدی به برنامه اضافه نکرده‌اند.
