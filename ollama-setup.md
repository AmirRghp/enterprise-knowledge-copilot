# اتصال Ollama شخصی به پروژهٔ Docker

Ollama اختیاری است. Compose اصلی آن را نصب یا اجرا نمی‌کند و هیچ مدلی را خودکار دانلود نمی‌کند. اگر OpenAI یا OpenRouter را انتخاب کرده‌اید، به این راهنما نیاز ندارید.

## ۱. Ollama و مدل را روی دستگاه خود آماده کنید

[Ollama](https://ollama.com/download) را طبق راهنمای رسمی نصب و اجرا کنید. نام مدل را خودتان انتخاب کنید؛ برای نمونه:

```bash
ollama pull qwen3.5:2b-q4_K_M
ollama pull qwen3-embedding:0.6b
ollama list
```

این نام‌ها فقط مثال‌اند. مدل chat را در بخش «چت» و مدل embedding را در بخش «Embedding» ثبت کنید. یک مدل chat را به‌جای embedding انتخاب نکنید. پیش از ثبت، پاسخ محلی Ollama را بررسی کنید:

```bash
curl http://127.0.0.1:11434/api/tags
```

## ۲. مسیر اتصال متناسب با Docker خود را انتخاب کنید

### Windows و macOS با Docker Desktop

Compose اصلی را طبق [README](README.md#اجرای-docker-compose) اجرا کنید. در فرم provider نوع **Ollama** و آدرس پایهٔ `http://host.docker.internal:11434` را بگذارید. Docker Desktop این نام را برای دسترسی کانتینر به سرویس میزبان فراهم می‌کند. اگر تست اتصال شکست خورد، ابتدا مطمئن شوید Ollama روی همان دستگاه روشن است و `curl` بالا پاسخ می‌دهد. اگر Docker Engine را داخل WSL یا VM جدا اجرا می‌کنید، این مسیر را معادل Docker Desktop فرض نکنید؛ دسترسی شبکهٔ همان محیط را بررسی کنید.

### Linux با Docker Engine معمولی

Ollama در حالت معمول فقط روی `127.0.0.1:11434` میزبان گوش می‌دهد. در Linux Engine، `host.docker.internal` به gateway شبکهٔ Docker اشاره می‌کند و به این loopback نمی‌رسد. برای اتصال بدون تغییر `OLLAMA_HOST` یا بازکردن پورت جدید، فایل Compose اختیاری پروژه را به فایل اصلی اضافه کنید:

```bash
docker compose -f compose.yaml -f compose.ollama-linux.yaml up -d --build
```

این فایل یک relay کوچک را در شبکهٔ میزبان اجرا می‌کند که فقط از طریق سوکت Unix مشترک با API و worker به Ollama محلی وصل می‌شود. این relay Ollama را نصب، اجرا یا دانلود نمی‌کند و پورت TCP تازه‌ای روی میزبان منتشر نمی‌کند. در فرم provider همچنان آدرس پایهٔ `http://host.docker.internal:11434` را بگذارید؛ برنامه هنگام فعال‌بودن این فایل، درخواست‌های همین مقصد را از سوکت محلی عبور می‌دهد. مقصدهای دیگر از مسیر عادی و محدودیت‌های امنیتی فعلی می‌گذرند.

برای توقف یا راه‌اندازی دوباره، **همین دو فایل** را به Compose بدهید:

```bash
docker compose -f compose.yaml -f compose.ollama-linux.yaml restart
docker compose -f compose.yaml -f compose.ollama-linux.yaml down
```

`down` بدون `-v` داده‌های PostgreSQL را پاک نمی‌کند. اگر Compose را بدون فایل اختیاری اجرا کنید، relay و مسیر سوکت فعال نخواهند بود. این روش برای Linux Docker Engine طراحی شده است؛ Docker Desktop به آن نیاز ندارد.

## ۳. اتصال را در پنل مدیر آزمایش کنید

در `/manager/providers`، برای هر اتصال نام نمایشی، نوع **Ollama**، نام دقیق مدل از `ollama list` و آدرس بالا را وارد کنید. API key برای Ollama محلی لازم نیست. پس از ذخیره، «تست اتصال» را بزنید. برای embedding، مدل آزموده‌شده را «پیش‌فرض» کنید؛ اگر اسناد از قبل نمایه شده‌اند، هشدار بازسازی و ارسال متن به مدل انتخابی را بخوانید و فقط در صورت پذیرش تأیید کنید.

اگر هر دو نوع اتصال در تست شکست خوردند، اول مسیر شبکه را بررسی کنید. در Linux Engine، اجرای Compose فقط با `compose.yaml` به Ollama محدود به loopback نمی‌رسد. اگر فقط یک مدل شکست خورد، نام مدل، نصب‌بودن آن و قابلیت chat یا embedding همان مدل را بررسی کنید. برای دیدن وضعیت relay در Linux:

```bash
docker compose -f compose.yaml -f compose.ollama-linux.yaml ps ollama-relay
docker compose -f compose.yaml -f compose.ollama-linux.yaml logs --tail=50 ollama-relay
```

Ollama محلی API key ندارد؛ سوکت relay فقط به کانتینرهایی که volume اختیاری را mount می‌کنند داده می‌شود. به این volume به کانتینرهای نامطمئن دسترسی ندهید. اگر Ollama را در شبکهٔ دیگری در دسترس می‌گذارید، حفاظت دسترسی آن شبکه بر عهدهٔ شماست.

منابع: [شبکهٔ میزبان Docker](https://docs.docker.com/engine/network/drivers/host/)، [دسترسی کانتینر به میزبان در Docker Desktop](https://docs.docker.com/desktop/features/networking/networking-how-tos/)، [FAQ رسمی Ollama](https://docs.ollama.com/faq).
