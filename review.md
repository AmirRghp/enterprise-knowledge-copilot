# گزارش نهایی بازبینی پارت ۳

## نتیجه

**وضعیت: آمادهٔ انتشار؛ blocker بازبینی باقی نمانده است.** همهٔ موارد بازبینی نهایی برطرف و بررسی شده‌اند. کاربر انتشار Part 3 را صریحاً تأیید کرده است؛ checkboxهای کار، تأیید، انتشار و تکمیل در `docs/plans/plans.md` تا push موفق خالی می‌مانند و SHA هنوز ثبت نشده است.

## شواهد نهایی پیش از انتشار

- `uv run --locked pytest -q tests/test_database.py tests/test_scaffold.py tests/test_provision_sql.py`: ۳۱ تست موفق و بدون skip (۱۱ دیتابیس، ۱۲ scaffold، ۸ ایستای provisioning).
- `uv run --locked ruff check app/db alembic tests/test_database.py tests/test_provision_sql.py`: موفق.
- `uv run --locked ruff format --check app/db alembic tests/test_database.py tests/test_provision_sql.py`: موفق، ۱۰ فایل.
- `uv run --locked mypy app`: موفق، ۱۲ منبع.
- ماتریس فقط‌خواندنی provisioning با credential جعلی و بدون ثبت/چاپ مقدار آن: بدون برخورد `exit 0`, `success=True`؛ یک مالکیت بیگانه، دو مالکیت بیگانه و دو مالکیت اضافی، هرکدام `exit 3`, `success=False`. هیچ مورد برخوردی پیام موفقیت نداد.

این بازبینی ماتریس dry-run را بررسی می‌کند و ادعای اجرای mutation تازه ندارد. شواهد mutation که در یادداشت‌های تاریخی آمده‌اند متعلق به اجرای قبلی در namespace ایزوله بوده‌اند.

## موارد بسته‌شده

- تمام guardهای برخورد و مالکیت در `provision.sql` از `EXISTS` استفاده می‌کنند و شکست پیش از عملیات mutation رخ می‌دهد.
- کانال انتقال credential از argv به env-file خصوصی اصلاح شده است؛ مقدار credential در این گزارش نیست.
- آزمون‌های DB فقط خطای اتصال را skip می‌کنند؛ خطای query موجب شکست آزمون می‌شود.
- typo و شرح نادقیق رفتار قبلی psql در `docs/TESTING.md` اصلاح شد. گزارش تاریخی اکنون صریح می‌گوید مقدار ۲ خطای boolean می‌دهد و شاخهٔ FALSE را می‌گیرد؛ بازتولید قبلی فقط‌خواندنی بود و وقوع mutation روی DB بیگانه ادعا نمی‌شود.
- سابقهٔ اجرای دستی migration در مستندات به‌عنوان نتیجهٔ قبلی نگه داشته شده و به اجرای این بازبینی تعمیم داده نشده است.

## مرز کار

این گزارش blocker بازبینی نهایی را نمی‌یابد. Part 4 شروع نشده است. وضعیت انتشار و SHA پس از push توسط `git_manager` ثبت خواهد شد.
