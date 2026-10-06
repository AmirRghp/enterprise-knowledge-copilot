# مهارت‌های محلی پروژه

این پوشه snapshot محلی مهارت‌های انتخاب‌شده برای همین مخزن است. برای هر کار فقط ۲ تا ۴ مهارت مرتبط را از جدول [دستورهای پروژه](../docs/AGENTS.md) یا برنامهٔ [پارت‌ها](../docs/plans/plans.md) باز کنید؛ مسیر هر مهارت به `SKILL.md` محلی اشاره می‌کند. فایل‌های موجود در پوشه‌های منتخب کپی شده‌اند؛ اصلاح مسیرهای ارجاع و جایگزینی چند ارجاع مفقود به منابع پروژه ثبت‌شده در manifest است (از جمله سه پیوند rules اصلاح‌شده و companionهای `data-analytics`).

## فهرست

| مهارت | فایل محلی | نیاز ابزاری و مرز |
|---|---|---|
| context-engineering | [SKILL.md](skills/context-engineering/SKILL.md) | مستقل از ابزار خاص |
| source-driven-development | [SKILL.md](skills/source-driven-development/SKILL.md) | برای منابع زنده، ابزار دسترسی به منبع لازم است |
| incremental-implementation | [SKILL.md](skills/incremental-implementation/SKILL.md) | مستقل از ابزار خاص |
| frontend-ui-engineering | [SKILL.md](skills/frontend-ui-engineering/SKILL.md) | ابزارهای پروژهٔ وب در صورت نیاز |
| design-system | [SKILL.md](skills/design-system/SKILL.md) | مستقل از ابزار خاص |
| vercel-react-best-practices | [SKILL.md](skills/vercel-react-best-practices/SKILL.md) | React/Next.js؛ توصیه‌ها را با نسخهٔ واقعی پروژه تطبیق دهید |
| api-and-interface-design | [SKILL.md](skills/api-and-interface-design/SKILL.md) | مستقل از ابزار خاص |
| security-and-hardening | [SKILL.md](skills/security-and-hardening/SKILL.md) | مستقل از ابزار خاص |
| code-simplification | [SKILL.md](skills/code-simplification/SKILL.md) | مستقل از ابزار خاص |
| code-review-and-quality | [SKILL.md](skills/code-review-and-quality/SKILL.md) | مهارت محلی منتخب برای بازبینی؛ aliasِ نصب‌نشدهٔ `review-agent` در manifest ثبت شده است |
| documentation-and-adrs | [SKILL.md](skills/documentation-and-adrs/SKILL.md) | مستقل از ابزار خاص |
| git-workflow-and-versioning | [SKILL.md](skills/git-workflow-and-versioning/SKILL.md) | فقط برای کار Git مجاز |
| test-driven-development | [SKILL.md](skills/test-driven-development/SKILL.md) | runner آزمون موجود پروژه در صورت نیاز |
| supabase-postgres-best-practices | [SKILL.md](skills/supabase-postgres-best-practices/SKILL.md) | محتوای PostgreSQL قابل استفاده است؛ این snapshot به معنی استفاده یا نصب Supabase نیست |
| ponytail | [SKILL.md](skills/ponytail/SKILL.md) | متن قواعد محلی موجود است؛ plugin hooks و فعال‌سازی mode سراسری در snapshot نیستند |
| no-ai-slop | [SKILL.md](skills/no-ai-slop/SKILL.md) | مستقل از ابزار خاص |
| verification-before-completion | [SKILL.md](skills/verification-before-completion/SKILL.md) | از فرمان‌های واقعی پروژه استفاده کنید |
| systematic-debugging | [SKILL.md](skills/systematic-debugging/SKILL.md) | مثال‌ها و scriptهای همراه در پوشهٔ مهارت‌اند |
| analyze-data-quality | [SKILL.md](skills/analyze-data-quality/SKILL.md) | روی corpus و ارزیابی همین پروژه قابل استفاده است؛ اتصال‌ها و ابزارهای اختیاری خارجی نیاز جدا دارند |
| validate-data | [SKILL.md](skills/validate-data/SKILL.md) | روی corpus و ارزیابی همین پروژه قابل استفاده است؛ script اختیاری پوشش به Node.js نیاز دارد |

## دسترسی و منشأ

- [skills-manifest.json](skills-manifest.json) نام و مسیر منبع هر snapshot، فایل‌های کپی‌شده، SHA-256 منبع و نسخهٔ محلی، تغییرات جابه‌جایی و ابزارهای خارجی را ثبت می‌کند. مسیرهای منبع فقط برای provenance هستند و در زمان استفاده لازم نیستند.
- `context7:context7-mcp` و `browser-testing-with-devtools` همچنان مهارت/ابزارهای خارجی‌اند؛ این snapshot دسترسی آفلاین به آن‌ها ایجاد نمی‌کند.
- companionهای `data-analytics` زیر `vendor/data-analytics/` هستند؛ حضورشان در مخزن به معنی کشف خودکار یا فعال‌شدن تمام مهارت‌های آن بسته نیست.
- فایل‌های مجوز موجود در منبع مهارت یا ریشهٔ بستهٔ پلاگین حفظ شده‌اند و مسیرشان در `license_sources` ثبت است؛ برخی منابع نصب‌شده فایل مجوز جدا ندارند. شرایط منبع اصلی همچنان معتبر است.
- snapshot در `2026-10-06` ثبت شده و خودکار به‌روزرسانی نمی‌شود. مهارت‌ها دستور پروژه را تغییر نمی‌دهند؛ قواعد کاربر و [docs/AGENTS.md](../docs/AGENTS.md) مقدم‌اند. این بسته جایگاه Part 10 را تغییر نمی‌دهد.
