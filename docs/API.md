# قراردادهای API

این سند مسیرهای موجود را از routerهای کد توصیف می‌کند. API تولیدشدهٔ FastAPI نیز از نوع‌های همان کد ساخته می‌شود؛ handlerهایی که JSON/multipart را دستی می‌خوانند ممکن است تمام schema خود را در OpenAPI نداشته باشند. این محدودیت با وجود جدول route پنهان نمی‌شود. وضعیت انتشار در [برنامه](plans/plans.md) است.

## احراز هویت، مبدا و داده

مرورگر از Route Handler هم‌مبدأ Next.js به FastAPI می‌رسد. cookie نشست HttpOnly و opaque است؛ نقش و مالکیت از DB سمت سرور می‌آید. HTTP local فقط loopback و Secure cookie در WEB_ORIGIN دارای HTTPS است. API فعلی API key عمومی ندارد. endpointهای session، Origin را طبق handler/guard بررسی می‌کنند؛ مجازبودن یک GET را به endpoint دیگر تعمیم ندهید. درخواست‌های تغییردهنده از Origin درست و content-type همان قرارداد استفاده کنند.

پاسخ‌های خصوصی no-store هستند. کارمند و مدیر فقط سند فعال، جاری، ready و مجاز را دریافت می‌کنند. منبع یا چت غیرمجاز/ناموجود پاسخ یکسان و بدون افشای وجود سند دارد؛ عنوان سند یا کلید provider در خطا برنمی‌گردد. [خطاها](ERROR_HANDLING.md) قالب‌های واقعی را توضیح می‌دهد؛ قالب واحد جدید فرض نشود.

## فهرست همهٔ routeهای برنامه

APIهای زیر در FastAPI موجودند؛ وجود route لزوماً به معنی داشتن proxy مرورگر برای هر مسیر نیست. route خودکار /docs و /openapi.json از این جدول حذف شده‌اند و API محصول نسخه‌دار عمومی محسوب نمی‌شوند.

| متد | مسیر | دسترسی | کد مرجع |
|---|---|---|---|
| `POST` | `/api/answers` | نشست معتبر | [answers.py](../apps/api/app/api/answers.py) |
| `POST` | `/api/auth/login` | عمومی؛ Origin و محدودیت تلاش | [auth.py](../apps/api/app/api/auth.py) |
| `POST` | `/api/auth/logout` | Origin؛ حتی بدون نشست زنده | [auth.py](../apps/api/app/api/auth.py) |
| `GET` | `/api/auth/me` | نشست معتبر | [auth.py](../apps/api/app/api/auth.py) |
| `GET` | `/api/conversations` | نشست معتبر | [conversations.py](../apps/api/app/api/conversations.py) |
| `POST` | `/api/conversations` | نشست معتبر | [conversations.py](../apps/api/app/api/conversations.py) |
| `GET` | `/api/conversations/{conversation_id}` | نشست معتبر | [conversations.py](../apps/api/app/api/conversations.py) |
| `PATCH` | `/api/conversations/{conversation_id}` | نشست معتبر | [conversations.py](../apps/api/app/api/conversations.py) |
| `DELETE` | `/api/conversations/{conversation_id}` | نشست معتبر | [conversations.py](../apps/api/app/api/conversations.py) |
| `POST` | `/api/conversations/{conversation_id}/turns` | نشست معتبر | [conversations.py](../apps/api/app/api/conversations.py) |
| `POST` | `/api/conversations/{conversation_id}/turns/{turn_id}/retry` | نشست معتبر | [conversations.py](../apps/api/app/api/conversations.py) |
| `POST` | `/api/conversations/{conversation_id}/turns/{turn_id}/cancel` | نشست معتبر | [conversations.py](../apps/api/app/api/conversations.py) |
| `GET` | `/api/documents` | نشست معتبر | [documents.py](../apps/api/app/api/documents.py) |
| `GET` | `/api/sources/{document_id}/sections/{section_id}` | نشست معتبر | [documents.py](../apps/api/app/api/documents.py) |
| `GET` | `/api/health` | عمومی | [health.py](../apps/api/app/api/health.py) |
| `GET` | `/api/manager/documents` | مدیر | [manager.py](../apps/api/app/api/manager.py) |
| `POST` | `/api/manager/documents` | مدیر | [manager.py](../apps/api/app/api/manager.py) |
| `PUT` | `/api/manager/documents/{document_id}` | مدیر | [manager.py](../apps/api/app/api/manager.py) |
| `PATCH` | `/api/manager/documents/{document_id}` | مدیر | [manager.py](../apps/api/app/api/manager.py) |
| `DELETE` | `/api/manager/documents/{document_id}` | مدیر | [manager.py](../apps/api/app/api/manager.py) |
| `GET` | `/api/manager/jobs/{job_id}` | مدیر | [manager.py](../apps/api/app/api/manager.py) |
| `GET` | `/api/organization` | عمومی | [organization.py](../apps/api/app/api/organization.py) |
| `GET` | `/api/manager/settings/organization` | مدیر | [organization.py](../apps/api/app/api/organization.py) |
| `PUT` | `/api/manager/settings/organization` | مدیر | [organization.py](../apps/api/app/api/organization.py) |
| `GET` | `/api/manager/providers/embedding/reindex` | مدیر | [providers.py](../apps/api/app/api/providers.py) |
| `POST` | `/api/manager/providers/embedding/{provider_id}/activate` | مدیر | [providers.py](../apps/api/app/api/providers.py) |
| `GET` | `/api/manager/providers` | مدیر | [providers.py](../apps/api/app/api/providers.py) |
| `PUT` | `/api/manager/providers/{purpose}/order` | مدیر | [providers.py](../apps/api/app/api/providers.py) |
| `POST` | `/api/manager/providers/{purpose}` | مدیر | [providers.py](../apps/api/app/api/providers.py) |
| `PUT` | `/api/manager/providers/{purpose}/{provider_id}` | مدیر | [providers.py](../apps/api/app/api/providers.py) |
| `DELETE` | `/api/manager/providers/{purpose}/{provider_id}` | مدیر | [providers.py](../apps/api/app/api/providers.py) |
| `PATCH` | `/api/manager/providers/rerank` | مدیر | [providers.py](../apps/api/app/api/providers.py) |
| `POST` | `/api/manager/providers/{purpose}/{provider_id}/test` | مدیر | [providers.py](../apps/api/app/api/providers.py) |
| `GET` | `/api/manager/settings/rate-limits` | مدیر | [rate_limits.py](../apps/api/app/api/rate_limits.py) |
| `PUT` | `/api/manager/settings/rate-limits` | مدیر | [rate_limits.py](../apps/api/app/api/rate_limits.py) |
| `GET` | `/api/manager/system-prompts` | مدیر | [system_prompts.py](../apps/api/app/api/system_prompts.py) |
| `POST` | `/api/manager/system-prompts` | مدیر | [system_prompts.py](../apps/api/app/api/system_prompts.py) |
| `PUT` | `/api/manager/system-prompts/{prompt_id}` | مدیر | [system_prompts.py](../apps/api/app/api/system_prompts.py) |
| `POST` | `/api/manager/system-prompts/{prompt_id}/activate` | مدیر | [system_prompts.py](../apps/api/app/api/system_prompts.py) |
| `GET` | `/api/auth/setup` | عمومی؛ POST فقط نصب بدون کاربر | [users.py](../apps/api/app/api/users.py) |
| `POST` | `/api/auth/setup` | عمومی؛ POST فقط نصب بدون کاربر | [users.py](../apps/api/app/api/users.py) |
| `GET` | `/api/manager/users` | مدیر | [users.py](../apps/api/app/api/users.py) |
| `POST` | `/api/manager/users` | مدیر | [users.py](../apps/api/app/api/users.py) |
| `PATCH` | `/api/manager/users/{user_id}` | مدیر | [users.py](../apps/api/app/api/users.py) |
| `PUT` | `/api/manager/users/{user_id}/password` | مدیر | [users.py](../apps/api/app/api/users.py) |

## ورود و حساب

- POST /api/auth/login: JSON شامل login و password؛ خروجی role و login، همراه cookie نشست. unknown login، wrong password و disabled account یک 401 عمومی دارند. rate limit با 429 و Retry-After است.
- GET /api/auth/me: user_id، login، role و session_expires_at؛ اطلاعات hash/token در body نیست.
- GET /api/auth/setup: فقط setup_required. POST setup: organization_name، first_name، last_name، email و password؛ 201 در ساخت اتمی نخستین مدیر و سازمان. وجود هر کاربر setup را می‌بندد.
- POST /api/auth/logout: 204 و حذف/revoke cookie؛ اعتبار نشست از body لو نمی‌رود.
- GET /api/manager/users: فهرست صفحه‌بندی‌شده؛ POST: نام‌ها، email، password، role و وضعیت طبق schema accounts. PATCH کاربر نام‌ها/ایمیل/نقش/وضعیت و password اختیاری را ذخیره می‌کند. PUT /api/manager/users/{user_id}/password مسیر جداگانهٔ گذرواژه با 204 است.
- password تازه ۱۲ تا ۵۱۲ نویسه و نام‌ها trimشده ۱ تا ۱۰۰ هستند؛ تغییر ایمیل/نقش/فعال‌بودن/گذرواژه، نشست‌های هدف را revoke می‌کند. آخرین مدیر فعال باید در رقابت حفظ شود.

منبع validation: [accounts.py](../apps/api/app/auth/accounts.py) و [users.py](../apps/api/app/api/users.py). پاسخ عمومی User شامل user_id، login، role، is_active، created_at، first_name و last_name است.

## پرسش و گفتگو

POST /api/answers بدنهٔ JSON با question و history اختیاری دارد. question بین ۱ تا ۲۰۰۰ نویسه است؛ history حداکثر پنج نوبت موفقِ حاوی question، answer و sources است. client حق، role یا evidence معتبر از خود نمی‌سازد و history پیش از هر استفاده مجدداً کنترل می‌شود. پاسخ کامل است و streaming وجود ندارد.

نمونهٔ پاسخ امتناع (شکل، نه پاسخ اجرای زنده):

```json
{
  "answer": "پاسخ در منابع مجاز یافت نشد.",
  "claims": [],
  "sources": [],
  "abstained": true,
  "request_id": "example-request-id"
}
```

این پاسخ دقیقاً پنج کلید دارد. claim شامل text، quote استخراج‌شده از passage و source است؛ source سه‌تایی document_id، section_id و revision است. نتیجهٔ خام retrieval، usage و شناسهٔ داخلی chunk برنمی‌گردد. تطبیق quote درستی معنایی تمام answer را تضمین نمی‌کند.

- GET /api/conversations: cursor و limit؛ سقف ۵۰، خروجی conversations و next_cursor. cursor نامعتبر یا query نامجاز رد می‌شود.
- POST /api/conversations: question نخست؛ ایجاد چت و turn پایدار pending و آغاز کار پاسخ.
- GET /api/conversations/{id}: header چت و turnهای صفحه‌بندی‌شده.
- PATCH همان مسیر: title trimشده تا ۱۰۰ نویسه؛ DELETE با 204 حذف چت متعلق به کاربر.
- POST turns: question بعدی؛ retry/cancel روی همان turn. وضعیت‌ها pending، answered، failed و cancelled هستند.
- پس از restart، pendingهای اجرا‌نشده از مسیر recovery به خطای قابل retry می‌روند؛ این سازوکار تک‌نمونه‌ای، صف پاسخ توزیع‌شده نیست.
- نتیجهٔ تاریخچه sources خوانا را پس از کنترل مجدد با عنوان سند/بخش اضافه می‌کند. اگر منبع مجاز/جاری نباشد result پنهان و source_unavailable اعلام می‌شود.

جزئیات کلیدهای envelope از [conversations.py](../apps/api/app/api/conversations.py) مرجع است؛ response مستقیم answer و envelope گفتگو یکسان فرض نشوند.

## اسناد و ingestion

GET /api/documents فقط فهرست سندهای مجاز آماده را می‌دهد. GET /api/sources/{document_id}/sections/{section_id} با revision مربوط، متن/metadata همان منبع را پس از بررسی جاری‌بودن می‌دهد؛ عنوان نامجاز در 404 ظاهر نمی‌شود.

upload و replacement مدیر multipart با file، title و access_role از employee/manager هستند؛ نام سند جدید سمت سرور ساخته می‌شود. POST و PUT موفق 202 با job metadata می‌دهند، نه تضمین ready بودن. raw فایل در کد جاری نگهداری نمی‌شود. PATCH /api/manager/documents/{document_id} فقط narrowing پشتیبانی‌شدهٔ همان handler را می‌پذیرد. DELETE سند را از دامنهٔ جست‌وجو خارج می‌کند. GET /api/manager/jobs/{job_id} برای وضعیت امن job است.

فرمت‌ها: md/txt/pdf/docx/xlsx/xls؛ حداکثر فایل فعلی ۱ MiB و body multipart آن به‌علاوهٔ ۶۴ KiB framing است. PDF لایهٔ متن می‌خواهد؛ XLS/XLSX مقدار ذخیره‌شده دارند و فرمول اجرا نمی‌شود. ZIP و چندفایل در route upload فعلی موجود نیستند.

## provider و تنظیمات

purpose برابر chat، embedding یا rerank است. ProviderInput شامل version، name، kind، model، base_url، api_key و فیلدهای مرتبط است. kind برای chat از ollama/openai/openrouter/openai_compatible؛ embedding فقط ollama/openai/openrouter؛ rerank فقط openrouter/openai_compatible است. temperature فقط chat و expected_digest فقط embedding از نوع Ollama است.

مقدار version برای CAS و stale update به 409 می‌رود. API key ورودی secret است و در listing به raw credential برنمی‌گردد. order با version و ids، toggle rerank با version و enabled، activate embedding با version و confirmed کار می‌کنند. تست موفقِ اتصال و بعد بردار برای فعال‌سازی embedding لازم است؛ تغییر روی index پر تأیید بازسازی می‌خواهد. index قبلی تا cutover حفظ می‌شود.

base_url OpenAI/OpenRouter توسط kind تعیین می‌شود؛ مسیرهای سفارشی از validate_url و ProviderTransport می‌گذرند. HTTP برای هر hostname داخلی دلخواه مجاز نیست؛ استثنای موجود، loopback و host.docker.internal:11434 برای Ollama است.

- system-prompts: ایجاد با name و prompt_text؛ ویرایش/activate با revision و تأیید طبق [system_prompts.py](../apps/api/app/system_prompts.py). تنها سازنده حق edit و هر نصب یک prompt فعال دارد.
- rate-limits: PUT با requests_per_user_per_minute، ollama_concurrency، cloud_concurrency و version؛ GET concurrency را nested برمی‌گرداند. queue ثابت ۵۰ برای هر گروه است.
- organization: GET عمومی فقط name؛ PUT مدیر با name trimشده ۱ تا ۱۰۰ نویسه.
- health: GET /api/health فقط {"status":"ok"} و liveness است؛ readiness DB یا مدل نیست.

## API برنامه‌ریزی‌شده

نیازمندی‌های LOCAL/ACL/SSO/DEV/OCR/OPS در [PRD](PRD.md) و کارت‌های ۳۶ تا ۳۹ تعریف شده‌اند. مسیر v1، envelope خطا، scope، cursor و schema تازه در کارت قرارداد مربوط تثبیت می‌شوند؛ این صفحه route پیشنهادی را فعال معرفی نمی‌کند. wrapper مرورگر و قرارداد پنج‌کلیدی answer تا migration/نسخه‌گذاری صریح معتبر می‌مانند.
