# موجودی مجوز، وابستگی و دارایی

ثبت: ۲۰۲۶-۱۰-۲۱ · کارت [۳۲.۱](plans/plans.md#part-32-1) · نیازمندی `OSS-01`

این سند نتیجهٔ ممیزی است، نه نظر حقوقی. مالک پروژه مجوز MIT و نام حق نشر `Amirreza Gholipour` را انتخاب کرده است ([D-06](DECISIONS.md)); متن رسمی `LICENSE` و فایل `NOTICE` در کارت ۳۲.۲ اضافه می‌شوند و در این کارت ساخته نشده‌اند. آنچه اینجا می‌آید فهرست موجودی، منشأ هر مورد و مواردی است که پیش از انتشار نیاز به تصمیم مالک دارند.

## ۱. دامنه و روش

**دامنهٔ توزیع.** دو چیز از این مخزن منتشر می‌شود: (۱) source tarball مخزن که روی GitHub است و هر فایل tracked را شامل می‌شود، (۲) imageهای Docker که `apps/api/Dockerfile` و `apps/web/Dockerfile` از همین مخزن می‌سازند. هر موردی که در یکی از این دو مسیر قرار می‌گیرد، در دامنهٔ ممیزی است.

**قاعدهٔ شواهد.** مجوز هر مورد از خود artifact توزیع‌شده خوانده می‌شود، نه از حافظه: `uv.lock` و `package-lock.json` برای نسخه و منشأ، `METADATA` نصب‌شدهٔ Python و `license` در lockfile برای مجوز، و فایل `LICENSE`/`NOTICE` داخل خود بسته برای متنی که واقعاً همراه کد می‌آید. هرجا این سه کافی نبود، فایل `LICENSE` رسمی upstream خوانده شد. هرجا هیچ مدرکی پیدا نشد، مقدار «نامشخص» ثبت شد و حدس زده نشد.

**خارج از دامنه.** وزن و مجوز مدل‌ها و توکنایزرها (پذیرش مجوز مدل‌ها طبق کارت ۳۲.۲ مستقل می‌ماند)، شرایط سرویس‌های provider، محتوای سازمانی که کاربر بارگذاری می‌کند، و متن نهایی `LICENSE`/`NOTICE`.

**منشأ محتوای سند.** کد پروژه را مالک پروژه پیاده‌سازی کرده است؛ هیچ کد شخص ثالثی در `apps/api/app/`، `apps/web/src/`، migrationها، SQL یا Dockerfileها وجود ندارد.

## ۲. خلاصهٔ نتیجه

| دسته | تعداد | مجوز | وضعیت |
|---|---|---|---|
| کد و دارایی اولیه | ۱ پروژه | MIT | روشن |
| فونت | ۱ | SIL OFL 1.1 | روشن، متن مجوز در `apps/web/src/fonts/OFL.txt` موجود است |
| وابستگی Python runtime | ۴۸ | MIT ۲۳، BSD-3-Clause ۱۳، Apache-2.0 ۹، PSF-2.0 ۱، درگیر MPL-2.0 ۲ | ۵ یافته |
| وابستگی npm runtime | ۷۰ | MIT ۳۲، Apache-2.0 ۱۸، ISC ۳، 0BSD ۱، BSD-3-Clause ۱، LGPL-3.0 ۱۴، CC-BY-4.0 ۱ | ۳ یافته |
| وابستگی فقط-توسعه | ۹ پایتون + ۳۶۱ npm | عمدتاً permissive | توزیع نمی‌شود |
| imageهای container | ۳ | PSF-2.0، MIT، PostgreSQL License | روشن |
| ابزار build | ۱ (`uv`) | MIT/Apache-2.0 | خارج از lockfile |
| محتوای ثالث vendored | ۷۸۴ فایل | ۵ مهارت MIT، ۱۵ مهارت بدون مدرک، ۱ بستهٔ vendor بدون مجوز، ۴ سند مرجع | ۲ یافتهٔ سطح بالا، ۱ متوسط |
| دادهٔ tracked | ۴۰ سؤال ارزیابی + ۵ fixture | ساختگی، مالک | روشن |

چهار یافته پیش از انتشار به تصمیم مالک نیاز دارند: `libvips` با مجوز LGPL-3.0 در image وب (F-01)، ۱۵ مهارت `.agents/skills` که نه فایل مجوز دارند نه نشانی عمومی upstream (F-04)، `.agents/vendor/data-analytics` که هیچ فیلد مجوزی ندارد (F-05) و چهار سند `docs/references/` بدون اعلان انتساب (F-06).

## ۳. کد و دارایی اولیه

| مسیر | نوع | مجوز | منشأ |
|---|---|---|---|
| `apps/api/app/**` | کد پایتون | MIT (انتخاب مالک) | همین مخزن |
| `apps/api/alembic/**` | migration | MIT | همین مخزن |
| `apps/api/sql/provision.sql` | provisioning DB | MIT | همین مخزن |
| `apps/api/tests/**` | آزمون و fixture | MIT | همین مخزن |
| `apps/web/src/**` | کد TypeScript، CSS و asset | MIT | همین مخزن |
| `apps/web/tests/**` | آزمون رابط | MIT | همین مخزن |
| `apps/api/Dockerfile`، `apps/web/Dockerfile`، `compose.yaml`، `compose.ollama-linux.yaml`، `docker/postgres-init.sh` | build و استقرار | MIT | همین مخزن |
| `run.sh`، `.env.example`، `.dockerignore`، `.gitignore` | اسکریپت و پیکربندی | MIT | همین مخزن |
| `docs/**`، `README.md`، `ollama-setup.md` | مستندات | MIT | همین مخزن، به‌جز اسناد مرجع (بخش ۸) |
| `apps/web/src/app/icon.svg` | آیکون | MIT | همین مخزن؛ شکل دست‌ساز است و فقط مقادیر رنگ از [مرجع طراحی](references/wattvision-DESIGN.md) گرفته شده |

## ۴. فونت

| مورد | نسخه | مجوز | لینک رسمی | وضعیت |
|---|---|---|---|---|
| Vazirmatn variable (`Vazirmatn-variable.woff2`) | `v33.003`، وزن‌های ۱۰۰ تا ۹۰۰ | SIL Open Font License 1.1 | [رستی‌کردار/vazirmatn](https://github.com/rastikerdar/vazirmatn/tree/v33.003) | متن کامل مجوز در `apps/web/src/fonts/OFL.txt` موجود است |

OFL 1.1 فایل فونت را جدا از کد مجوز می‌داند و متن مجوز باید همراه فونت توزیع شود؛ این شرط با وجود `OFL.txt` برقرار است. فونت با `next/font/local` بارگذاری می‌شود و در زمان اجرا درخواست شبکه‌ای برای فونت وجود ندارد. نام فونت تغییر نکرده است، پس قید «تغییر نام» در OFL فعال نیست.

## ۵. وابستگی‌های Python

منبع: `apps/api/uv.lock`؛ نسخه‌ها دقیقاً همان چیزی است که `uv sync --locked --no-dev` نصب می‌کند. closure runtime از ۱۷ وابستگی مستقیم `pyproject.toml` با احتساب extraهای `pwdlib[argon2]` و `sqlalchemy[asyncio]` به‌دست آمده: **۴۸ بسته**. از این ۴۸، ۴۷ روی این میزبان لینوکس نصب‌اند و `colorama` فقط برای `win32` در lockfile است.

| بسته | نسخه | مجوز | منبع مجوز | لینک رسمی | پرچم |
|---|---|---|---|---|---|
| `alembic` | 1.20.0 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/alembic/) | |
| `annotated-doc` | 0.0.5 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/annotated-doc/) | |
| `annotated-types` | 0.8.0 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/annotated-types/) | |
| `anyio` | 4.15.1 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/anyio/) | |
| `argon2-cffi` | 25.1.0 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/argon2-cffi/) | F-10 |
| `argon2-cffi-bindings` | 26.1.0 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/argon2-cffi-bindings/) | F-10 |
| `asyncpg` | 0.31.0 | Apache-2.0 | metadata: `License-Expression` | [PyPI](https://pypi.org/project/asyncpg/) | |
| `certifi` | 2026.7.22 | MPL-2.0 | metadata: `License` + upstream `LICENSE` | [PyPI](https://pypi.org/project/certifi/) | F-02 |
| `cffi` | 2.1.1 | MIT-0 | metadata: `License-Expression` | [PyPI](https://pypi.org/project/cffi/) | |
| `click` | 8.5.0 | BSD-3-Clause | metadata: `License-Expression` | [PyPI](https://pypi.org/project/click/) | |
| `colorama` | 0.4.6 | BSD-3-Clause | PyPI trove classifier + upstream `LICENSE` | [PyPI](https://pypi.org/project/colorama/) | F-08 |
| `cryptography` | 46.0.7 | Apache-2.0 OR BSD-3-Clause | metadata: `License-Expression` | [PyPI](https://pypi.org/project/cryptography/) | F-10 |
| `fastapi` | 0.142.2 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/fastapi/) | |
| `filelock` | 4.0.11 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/filelock/) | |
| `fsspec` | 2026.9.0 | BSD-3-Clause | metadata: `License-Expression` | [PyPI](https://pypi.org/project/fsspec/) | |
| `greenlet` | 3.5.6 | MIT AND PSF-2.0 | metadata: `License-Expression` + upstream `LICENSE` | [PyPI](https://pypi.org/project/greenlet/) | |
| `h11` | 0.16.0 | MIT | metadata: `License` + upstream `LICENSE` | [PyPI](https://pypi.org/project/h11/) | |
| `hf-xet` | 1.6.0 | Apache-2.0 | metadata: `License-Expression` | [PyPI](https://pypi.org/project/hf-xet/) | |
| `httpcore` | 1.0.9 | BSD-3-Clause | metadata: `License-Expression` | [PyPI](https://pypi.org/project/httpcore/) | |
| `httpx` | 0.28.1 | BSD-3-Clause | metadata: `License` + upstream `LICENSE` | [PyPI](https://pypi.org/project/httpx/) | |
| `huggingface-hub` | 1.33.0 | Apache-2.0 | metadata: `License` + upstream `LICENSE` | [PyPI](https://pypi.org/project/huggingface-hub/) | F-13 |
| `idna` | 3.20 | BSD-3-Clause | metadata: `License-Expression` | [PyPI](https://pypi.org/project/idna/) | |
| `lxml` | 6.1.3 | BSD-3-Clause | metadata: `License` + upstream `LICENSE` | [PyPI](https://pypi.org/project/lxml/) | F-10 |
| `mako` | 1.4.3 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/mako/) | |
| `markupsafe` | 3.0.4 | BSD-3-Clause | metadata: `License-Expression` | [PyPI](https://pypi.org/project/markupsafe/) | |
| `numpy` | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | metadata: `License-Expression` + upstream `LICENSE` | [PyPI](https://pypi.org/project/numpy/) | |
| `opentelemetry-api` | 1.45.0 | Apache-2.0 | metadata: `License-Expression` | [PyPI](https://pypi.org/project/opentelemetry-api/) | |
| `packaging` | 26.3 | Apache-2.0 OR BSD-2-Clause | metadata: `License-Expression` | [PyPI](https://pypi.org/project/packaging/) | |
| `pgvector` | 0.5.0 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/pgvector/) | |
| `pwdlib` | 0.3.1 | MIT | metadata: trove classifier + upstream `LICENSE` | [PyPI](https://pypi.org/project/pwdlib/) | |
| `pycparser` | 3.0 | BSD-3-Clause | metadata: `License-Expression` + upstream `LICENSE` | [PyPI](https://pypi.org/project/pycparser/) | |
| `pydantic` | 2.13.5 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/pydantic/) | |
| `pydantic-core` | 2.46.5 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/pydantic-core/) | |
| `pydantic-settings` | 2.15.0 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/pydantic-settings/) | |
| `pypdf` | 6.20.1 | BSD-3-Clause | metadata: `License-Expression` | [PyPI](https://pypi.org/project/pypdf/) | F-10 |
| `python-calamine` | 0.8.3 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/python-calamine/) | F-10 |
| `python-docx` | 1.2.0 | MIT | metadata: `License` + upstream `LICENSE` | [PyPI](https://pypi.org/project/python-docx/) | |
| `python-dotenv` | 1.2.4 | BSD-3-Clause | metadata: `License` + upstream `LICENSE` | [PyPI](https://pypi.org/project/python-dotenv/) | |
| `python-multipart` | 0.0.32 | Apache-2.0 | metadata: `License-Expression` + upstream `LICENSE` | [PyPI](https://pypi.org/project/python-multipart/) | |
| `pyyaml` | 6.0.3 | MIT | metadata: `License` + upstream `LICENSE` | [PyPI](https://pypi.org/project/pyyaml/) | F-10 |
| `rank-bm25` | 0.2.2 | Apache-2.0 | metadata: `License` + upstream `LICENSE` | [PyPI](https://pypi.org/project/rank-bm25/) | F-07 |
| `sqlalchemy` | 2.1.3 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/sqlalchemy/) | |
| `starlette` | 1.7.0 | BSD-3-Clause | metadata: `License-Expression` | [PyPI](https://pypi.org/project/starlette/) | |
| `tokenizers` | 0.23.2 | Apache-2.0 | metadata: trove classifier + upstream `LICENSE` | [PyPI](https://pypi.org/project/tokenizers/) | F-13 |
| `tqdm` | 4.70.1 | MPL-2.0 AND MIT | metadata: `License` + upstream `LICENSE` | [PyPI](https://pypi.org/project/tqdm/) | F-02 |
| `typing-extensions` | 4.16.0 | PSF-2.0 | metadata: `License-Expression` | [PyPI](https://pypi.org/project/typing-extensions/) | |
| `typing-inspection` | 0.4.4 | MIT | metadata: `License-Expression` | [PyPI](https://pypi.org/project/typing-inspection/) | |
| `uvicorn` | 0.54.0 | BSD-3-Clause | metadata: `License-Expression` | [PyPI](https://pypi.org/project/uvicorn/) | |

**فقط-توسعه (۹ بسته، در image توزیع نمی‌شود):** `iniconfig` ۲.۳.۰، `librt` ۰.۱۶.۰، `mypy` ۱.۲۰.۲، `mypy-extensions` ۱.۱.۰، `pathspec` ۱.۱.۱ (MPL-2.0)، `pluggy` ۱.۶.۰، `pygments` ۲.۲۱.۰، `pytest` ۹.۱.۱، `ruff` ۰.۱۶.۱۰. منشأ رسمی همه `https://pypi.org/project/<نام>/` است و برای هر ۹ بسته باز شد. گروه `dev` در `uv sync --no-dev` کنار گذاشته می‌شود، پس این‌ها تعهد توزیع ندارند.

## ۶. وابستگی‌های npm

منبع: `apps/web/package-lock.json`. closure runtime از ۷ وابستگی مستقیم `dependencies` به‌دست آمده: **۷۰ بسته**. ستون «در image وب» یعنی بسته در خروجی standalone یک build واقعی روی این میزبان (`linux-x64`) حاضر بوده است؛ بقیه یا فقط-پلتفرم‌اند یا در trace نیامده‌اند.

| بسته | نسخه | مجوز | پلتفرم | در image وب | لینک رسمی | پرچم |
|---|---|---|---|---|---|---|
| `@babel/runtime` | 8.0.7 | MIT | — |  | [registry](https://registry.npmjs.org/@babel%2fruntime) |  |
| `@base-ui/react` | 1.9.0 | MIT | — |  | [registry](https://registry.npmjs.org/@base-ui%2freact) |  |
| `@base-ui/utils` | 0.5.0 | MIT | — |  | [registry](https://registry.npmjs.org/@base-ui%2futils) |  |
| `@emnapi/runtime` | 1.11.3 | MIT | — |  | [registry](https://registry.npmjs.org/@emnapi%2fruntime) |  |
| `@floating-ui/core` | 1.8.0 | MIT | — |  | [registry](https://registry.npmjs.org/@floating-ui%2fcore) |  |
| `@floating-ui/dom` | 1.8.0 | MIT | — |  | [registry](https://registry.npmjs.org/@floating-ui%2fdom) |  |
| `@floating-ui/react-dom` | 2.1.9 | MIT | — |  | [registry](https://registry.npmjs.org/@floating-ui%2freact-dom) |  |
| `@floating-ui/utils` | 0.2.12 | MIT | — |  | [registry](https://registry.npmjs.org/@floating-ui%2futils) |  |
| `@img/colour` | 1.1.0 | MIT | — | بله | [registry](https://registry.npmjs.org/@img%2fcolour) |  |
| `@img/sharp-darwin-arm64` | 0.35.5 | Apache-2.0 | darwin |  | [registry](https://registry.npmjs.org/@img%2fsharp-darwin-arm64) | F-01 |
| `@img/sharp-darwin-x64` | 0.35.5 | Apache-2.0 | darwin |  | [registry](https://registry.npmjs.org/@img%2fsharp-darwin-x64) | F-01 |
| `@img/sharp-freebsd-wasm32` | 0.35.5 | Apache-2.0 | freebsd |  | [registry](https://registry.npmjs.org/@img%2fsharp-freebsd-wasm32) | F-01 |
| `@img/sharp-libvips-darwin-arm64` | 1.3.4 | LGPL-3.0-or-later | darwin |  | [registry](https://registry.npmjs.org/@img%2fsharp-libvips-darwin-arm64) | F-01 |
| `@img/sharp-libvips-darwin-x64` | 1.3.4 | LGPL-3.0-or-later | darwin |  | [registry](https://registry.npmjs.org/@img%2fsharp-libvips-darwin-x64) | F-01 |
| `@img/sharp-libvips-linux-arm` | 1.3.4 | LGPL-3.0-or-later | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-libvips-linux-arm) | F-01 |
| `@img/sharp-libvips-linux-arm64` | 1.3.4 | LGPL-3.0-or-later | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-libvips-linux-arm64) | F-01 |
| `@img/sharp-libvips-linux-ppc64` | 1.3.4 | LGPL-3.0-or-later | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-libvips-linux-ppc64) | F-01 |
| `@img/sharp-libvips-linux-riscv64` | 1.3.4 | LGPL-3.0-or-later | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-libvips-linux-riscv64) | F-01 |
| `@img/sharp-libvips-linux-s390x` | 1.3.4 | LGPL-3.0-or-later | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-libvips-linux-s390x) | F-01 |
| `@img/sharp-libvips-linux-x64` | 1.3.4 | LGPL-3.0-or-later | linux | بله | [registry](https://registry.npmjs.org/@img%2fsharp-libvips-linux-x64) | F-01 |
| `@img/sharp-libvips-linuxmusl-arm64` | 1.3.4 | LGPL-3.0-or-later | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-libvips-linuxmusl-arm64) | F-01 |
| `@img/sharp-libvips-linuxmusl-x64` | 1.3.4 | LGPL-3.0-or-later | linux | بله | [registry](https://registry.npmjs.org/@img%2fsharp-libvips-linuxmusl-x64) | F-01 |
| `@img/sharp-linux-arm` | 0.35.5 | Apache-2.0 | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-linux-arm) | F-01 |
| `@img/sharp-linux-arm64` | 0.35.5 | Apache-2.0 | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-linux-arm64) | F-01 |
| `@img/sharp-linux-ppc64` | 0.35.5 | Apache-2.0 | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-linux-ppc64) | F-01 |
| `@img/sharp-linux-riscv64` | 0.35.5 | Apache-2.0 | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-linux-riscv64) | F-01 |
| `@img/sharp-linux-s390x` | 0.35.5 | Apache-2.0 | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-linux-s390x) | F-01 |
| `@img/sharp-linux-x64` | 0.35.5 | Apache-2.0 | linux | بله | [registry](https://registry.npmjs.org/@img%2fsharp-linux-x64) | F-01 |
| `@img/sharp-linuxmusl-arm64` | 0.35.5 | Apache-2.0 | linux |  | [registry](https://registry.npmjs.org/@img%2fsharp-linuxmusl-arm64) | F-01 |
| `@img/sharp-linuxmusl-x64` | 0.35.5 | Apache-2.0 | linux | بله | [registry](https://registry.npmjs.org/@img%2fsharp-linuxmusl-x64) | F-01 |
| `@img/sharp-wasm32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | — | بله | [registry](https://registry.npmjs.org/@img%2fsharp-wasm32) | F-01 |
| `@img/sharp-webcontainers-wasm32` | 0.35.5 | Apache-2.0 | — |  | [registry](https://registry.npmjs.org/@img%2fsharp-webcontainers-wasm32) | F-01 |
| `@img/sharp-win32-arm64` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | win32 |  | [registry](https://registry.npmjs.org/@img%2fsharp-win32-arm64) | F-01 |
| `@img/sharp-win32-ia32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | win32 |  | [registry](https://registry.npmjs.org/@img%2fsharp-win32-ia32) | F-01 |
| `@img/sharp-win32-x64` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | win32 |  | [registry](https://registry.npmjs.org/@img%2fsharp-win32-x64) | F-01 |
| `@next/env` | 16.3.8 | MIT | — | بله | [registry](https://registry.npmjs.org/@next%2fenv) |  |
| `@next/swc-darwin-arm64` | 16.3.8 | MIT | darwin |  | [registry](https://registry.npmjs.org/@next%2fswc-darwin-arm64) | F-01 |
| `@next/swc-darwin-x64` | 16.3.8 | MIT | darwin |  | [registry](https://registry.npmjs.org/@next%2fswc-darwin-x64) | F-01 |
| `@next/swc-linux-arm64-gnu` | 16.3.8 | MIT | linux |  | [registry](https://registry.npmjs.org/@next%2fswc-linux-arm64-gnu) | F-01 |
| `@next/swc-linux-arm64-musl` | 16.3.8 | MIT | linux |  | [registry](https://registry.npmjs.org/@next%2fswc-linux-arm64-musl) | F-01 |
| `@next/swc-linux-x64-gnu` | 16.3.8 | MIT | linux |  | [registry](https://registry.npmjs.org/@next%2fswc-linux-x64-gnu) | F-01 |
| `@next/swc-linux-x64-musl` | 16.3.8 | MIT | linux |  | [registry](https://registry.npmjs.org/@next%2fswc-linux-x64-musl) | F-01 |
| `@next/swc-win32-arm64-msvc` | 16.3.8 | MIT | win32 |  | [registry](https://registry.npmjs.org/@next%2fswc-win32-arm64-msvc) | F-01 |
| `@next/swc-win32-x64-msvc` | 16.3.8 | MIT | win32 |  | [registry](https://registry.npmjs.org/@next%2fswc-win32-x64-msvc) | F-01 |
| `@paper-design/shaders` | 0.0.81 | Apache-2.0 | — |  | [registry](https://registry.npmjs.org/@paper-design%2fshaders) | F-09 |
| `@paper-design/shaders-react` | 0.0.81 | Apache-2.0 | — |  | [registry](https://registry.npmjs.org/@paper-design%2fshaders-react) | F-09 |
| `@swc/helpers` | 0.5.23 | Apache-2.0 | — | بله | [registry](https://registry.npmjs.org/@swc%2fhelpers) |  |
| `baseline-browser-mapping` | 2.11.27 | Apache-2.0 | — |  | [registry](https://registry.npmjs.org/baseline-browser-mapping) | F-09 |
| `caniuse-lite` | 1.0.30001814 | CC-BY-4.0 | — |  | [registry](https://registry.npmjs.org/caniuse-lite) | F-03 |
| `client-only` | 0.0.1 | MIT | — | بله | [registry](https://registry.npmjs.org/client-only) |  |
| `detect-libc` | 2.1.2 | Apache-2.0 | — | بله | [registry](https://registry.npmjs.org/detect-libc) |  |
| `framer-motion` | 14.3.0 | MIT | — |  | [registry](https://registry.npmjs.org/framer-motion) |  |
| `lucide-react` | 1.52.0 | ISC | — |  | [registry](https://registry.npmjs.org/lucide-react) |  |
| `motion` | 14.3.0 | MIT | — |  | [registry](https://registry.npmjs.org/motion) |  |
| `motion-dom` | 14.3.0 | MIT | — |  | [registry](https://registry.npmjs.org/motion-dom) |  |
| `motion-utils` | 14.1.1 | MIT | — |  | [registry](https://registry.npmjs.org/motion-utils) |  |
| `nanoid` | 3.3.19 | MIT | — |  | [registry](https://registry.npmjs.org/nanoid) |  |
| `next` | 16.3.8 | MIT | — | بله | [registry](https://registry.npmjs.org/next) |  |
| `picocolors` | 1.1.1 | ISC | — |  | [registry](https://registry.npmjs.org/picocolors) |  |
| `postcss` | 8.5.23 | MIT | — |  | [registry](https://registry.npmjs.org/postcss) |  |
| `react` | 19.3.0 | MIT | — | بله | [registry](https://registry.npmjs.org/react) |  |
| `react-dom` | 19.3.0 | MIT | — | بله | [registry](https://registry.npmjs.org/react-dom) |  |
| `reselect` | 5.3.0 | MIT | — |  | [registry](https://registry.npmjs.org/reselect) |  |
| `scheduler` | 0.28.0 | MIT | — |  | [registry](https://registry.npmjs.org/scheduler) |  |
| `semver` | 7.8.5 | ISC | — | بله | [registry](https://registry.npmjs.org/semver) |  |
| `sharp` | 0.35.5 | Apache-2.0 | — | بله | [registry](https://registry.npmjs.org/sharp) |  |
| `source-map-js` | 1.2.2 | BSD-3-Clause | — |  | [registry](https://registry.npmjs.org/source-map-js) |  |
| `styled-jsx` | 5.1.6 | MIT | — | بله | [registry](https://registry.npmjs.org/styled-jsx) |  |
| `tslib` | 2.8.1 | 0BSD | — |  | [registry](https://registry.npmjs.org/tslib) |  |
| `use-sync-external-store` | 1.7.0 | MIT | — |  | [registry](https://registry.npmjs.org/use-sync-external-store) |  |

لینک رسمی هر بسته نشانی registry آن در npm است (`https://registry.npmjs.org/<نام>`) که برای هر ۷۰ بسته باز شد. صفحهٔ انسانی هر بسته `https://www.npmjs.com/package/<نام>` است؛ این صفحه درخواست‌های خودکار را با `403` رد می‌کند، پس بررسی خودکار روی registry انجام شد.

**فقط-توسعه (۳۶۱ بسته، در image توزیع نمی‌شود).** توزیع مجوز: MIT ۳۱۲، Apache-2.0 ۱۹، ISC ۱۸، BSD-2-Clause ۷، BSD-3-Clause ۱، CC0-1.0 ۱، BlueOak-1.0.0 ۱، MPL-2.0 ۱، Python-2.0 ۱. سه مورد غیرمجاز: `axe-core` ۴.۱۳.۰ (MPL-2.0)، `argparse` ۲.۰.۱ (Python-2.0) و `minimatch` ۱۰.۲.۶ (BlueOak-1.0.0). build وب با `npm ci` همهٔ این‌ها را نصب می‌کند اما مرحلهٔ runtime فقط `.next/standalone` و `.next/static` را کپی می‌کند، پس در image نهایی نیستند.

Next.js در `next/dist/compiled/` ۵۴ بستهٔ دیگر را همراه خود می‌آورد؛ این‌ها کپی‌های upstream همان مجوزهای جدول بالا هستند و زیرمجموعهٔ همان ۷۰ بسته‌اند.
## ۷. imageهای container و ابزار build

| مورد | نسخه | مجوز | لینک رسمی | پرچم |
|---|---|---|---|---|
| `python:3.12-slim` | digest `sha256:2f17fc04…be06a9` | Python Software Foundation License | [Docker Hub](https://hub.docker.com/_/python) | |
| `node:24-alpine` | digest `sha256:ebfe2f90…5ec1c1` | MIT | [Docker Hub](https://hub.docker.com/_/node) | |
| `pgvector/pgvector:pg16` | digest `sha256:ccc6e83d…1fb4d6b` | PostgreSQL License | [Docker Hub](https://hub.docker.com/r/pgvector/pgvector) | |
| `uv` | 0.12.18 | MIT OR Apache-2.0 | [PyPI](https://pypi.org/project/uv/) | F-11 |

imageها در مخزن vendored نیستند و با digest ثابت در `Dockerfile` و `compose.yaml` قفل شده‌اند؛ در زمان build از registry کشیده می‌شوند و مجوزشان به توزیع source اضافه نمی‌شود.

## ۸. محتوای ثالث vendored در مخزن

این محتوا بخشی از source tarball است و با مجوز MIT پروژه منتشر می‌شود.

### مهارت‌های `.agents/skills/`

snapshot محلی ۲۰ مهارت، ثبت‌شده در `2026-10-06` با `skills-manifest.json` (شامل SHA-256 هر فایل منبع).

| وضعیت | تعداد | مهارت‌ها | مجوز |
|---|---|---|---|
| مدرک مجوز موجود | ۵ | `no-ai-slop` (© 2026 Peter Yang)، `ponytail` (© 2026 DietrichGebert)، `supabase-postgres-best-practices` (© 2025 Supabase)، `systematic-debugging` و `verification-before-completion` (© 2025 Jesse Vincent) | MIT |
| بدون مدرک | ۱۵ | `context-engineering`، `source-driven-development`، `incremental-implementation`، `frontend-ui-engineering`، `design-system`، `vercel-react-best-practices`، `api-and-interface-design`، `security-and-hardening`، `code-simplification`، `code-review-and-quality`، `documentation-and-adrs`، `git-workflow-and-versioning`، `test-driven-development`، `analyze-data-quality`، `validate-data` | نامشخص |

در manifest، `license_sources` این ۱۵ مهارت خالی است و `source` فقط یک مسیر محلی cache را نشان می‌دهد، نه یک نشانی عمومی. برای پنج مهارت دارای `UPSTREAM-LICENSE`، متن MIT و نام حق‌نویسی در خود مخزن موجود است.

### `docs/references/`

| فایل | محتوا | وضعیت |
|---|---|---|
| `notion-DESIGN.md` | تحلیل طراحی و توکن‌های رنگی سایت Notion، شامل ارجاع به شش صفحهٔ notion.com | بدون اعلان انتساب |
| `wattvision-DESIGN.md` | سند طراحی اسپانیایی «Sistema de Monitoreo Eléctrico WattVision» | بدون اعلان انتساب |
| `part3-documentation-reference.md` | گزیدهٔ بخش PART 3 از سند Google Docs «THE VIBE CODING BLUEPRINT» | نویسنده و مجوز نامشخص |
| `part2-documentation-reference.txt` | گزیدهٔ PART 2 از همان سند | نویسنده و مجوز نامشخص |

## ۹. داده

| مورد | حجم | منشأ | وضعیت |
|---|---|---|---|
| `eval/questions.jsonl` | ۴۰ سؤال (بر پایهٔ ۴۰ خط، هر خط یک نمونه) | ساختهٔ مالک پروژه، محتوای ساختگی دربارهٔ سیاست داخلی فرضی | tracked، MIT |
| `apps/api/tests/fixtures/documents/` | ۵ فایل (PDF، DOCX، XLSX، XLS، PDF خالی) | ساختهٔ مالک پروژه برای آزمون استخراج متن | tracked، MIT |
| `corpus/` | ۲۰ فایل Markdown با شناسهٔ `HR-*`، `IT-*`، `COM-*`، `MGR-*` و `DOC-001` | ساختهٔ مالک پروژه، محتوای ساختگی | **untracked و در `.gitignore`**؛ در توزیع نیست |
| `eval/runs/` | artifactهای ارزیابی | خروجی اجرا | untracked؛ ممکن است متن سند داشته باشد، پس عمداً منتشر نمی‌شود |

## ۱۰. یافته‌ها و اقدام لازم

| شناسه | شدت | یافته | شواهد | الزام | اقدام | مالک |
|---|---|---|---|---|---|---|
| F-01 | بالا | `libvips` با مجوز LGPL-3.0-or-later در image وب هست و بستهٔ باینری هیچ فایل `LICENSE` یا `NOTICE` ندارد. `sharp` و `@img/sharp-*` و `@next/swc-*` هم متن مجوز را همراه باینری نمی‌آورند. | `apps/web/.next/standalone/node_modules/@img/sharp-libvips-linux-x64/`؛ فهرست فایل‌های بسته | LGPL 3 همراهی متن مجوز و حق جایگزینی/اتصال مجدد را الزام می‌کند؛ MIT و Apache-2.0 هم متن اعلان را | ۳۲.۲ باید متن LGPL و سایر متن‌ها را در `NOTICE` بیاورد. مالک باید تصمیم بگیرد آیا `sharp` در runtime بماند: پروژه از `next/image` استفاده نمی‌کند، پس حذف آن ممکن است و کل تعهد را برمی‌دارد. | تصمیم مالک، اجرا در ۳۲.۲ |
| F-02 | متوسط | `certifi` با MPL-2.0 است. `tqdm` (MPL-2.0 AND MIT) و `pathspec` (upstream: `LICENSE-MIT` + `LICENSE-MPL-2.0`) دو‌مجوزی‌اند و انتخاب MIT ممکن است. `pathspec` فقط-توسعه است و در image توزیع نمی‌شود. | `certifi-2026.7.22.dist-info/licenses/LICENSE`؛ `tqdm-4.70.1.dist-info/licenses/LICENCE`؛ `pathspec-1.1.1.dist-info/licenses/LICENSE` | MPL-2.0 تعهد سطح فایل دارد: فایل‌های تحت MPL باید همان‌طور بمانند و متن مجوز و دسترسی به کد منبع هنگام توزیع اعلام شود | ۳۲.۲ متن MPL-2.0 را در `NOTICE` بیاورد، انتخاب مجوز برای `tqdm` و `pathspec` را صریح بنویسد و برای `certifi` مسیر دسترسی به کد منبع را اعلام کند | ۳۲.۲ |
| F-03 | متوسط | `caniuse-lite` با CC-BY-4.0 است و در closure runtime قرار دارد (در build واقعیِ این میزبان در خروجی standalone نیامد). | `package-lock.json`، مقدار `license` همان بسته | CC-BY-4.0 انتساب نام اثر، نام دارندهٔ حق نشر، عنوان اثر و نشانی منبع را الزام می‌کند | ۳۲.۲ انتساب `caniuse-lite` را در `NOTICE` بیاورد | ۳۲.۲ |
| F-04 | بالا | ۱۵ مهارت از `.agents/skills/` هیچ فایل مجوز و هیچ نشانی عمومی upstream ندارند، ولی در مخزن tracked هستند و با source tarball منتشر می‌شوند. | `.agents/skills-manifest.json`، `license_sources` خالی؛ `.agents/README.md` | انتشار کد شخص ثالث بدون تعیین تکلیف، ریسک اصلی این ممیزی است | مالک یکی از دو راه را انتخاب کند: حذف `.agents/` از توزیع، یا ثبت مجوز هر مهارت به‌علاوهٔ انتساب در `NOTICE`. ۳۲.۲ اجرا کنده | تصمیم مالک، اجرا در ۳۲.۲ |
| F-05 | بالا | `.agents/vendor/data-analytics` هیچ فیلد مجوز ندارد (`private: true`) و کد شخص ثالث را در خود دارد؛ `THIRD_PARTY_NOTICES.txt` آن فقط پوشش داخلی خودش را پوشش می‌دهد. | `.agents/vendor/data-analytics/package.json` | همان تعهد F-04 | همان مسیر F-04؛ بهتر است همراه `.agents/` یکی تصمیم گرفته شود | تصمیم مالک، اجرا در ۳۲.۲ |
| F-06 | متوسط | چهار سند در `docs/references/` محتوای شخص ثالث را بدون اعلان انتساب نگه داشته‌اند؛ دو سند از منابع عمومی و دو سند از یک سند Google Docs با نویسندهٔ نامشخص. | `docs/references/`، سرصفحهٔ هر فایل | بازنشر متن شخص ثالث بدون انتساب، ریسک حقوقی مستقل از MIT است | یا انتساب و منبع در سرصفحهٔ هر فایل اضافه شود، یا فایل‌هایی که سند اصلی را بازنشر می‌کنند از توزیع خارج شوند و فقط ارجاع بماند | تصمیم مالک، اجرا در ۳۲.۲ |
| F-07 | کم | `rank-bm25` در metadata مقدار `License: Apache2.0` دارد که رشتهٔ معتبر SPDX نیست. | `rank_bm25-0.2.2.dist-info/METADATA` | درج مقدار نامعتبر، ابزارهای تولید `NOTICE` را دچار خطا می‌کند | مقدار درست Apache-2.0 در ۳۲.۲ درج شود. فایل `LICENSE` upstream هم Apache-2.0 است و همین را تأیید می‌کند | ۳۲.۲ |
| F-08 | کم | `colorama` فقط در lockfile است و روی لینوکس نصب نمی‌شود؛ مدرک مجوز از lockfile در دسترس نیست. | `uv.lock`، marker ویندوز | اطلاع‌رسانی نادرست در `NOTICE` | مجوز BSD-3-Clause از PyPI و فایل `LICENSE.txt` upstream (© 2010 Jonathan Hartley) تأیید شد و در ۳۲.۲ درج می‌شود | ۳۲.۲ |
| F-09 | کم | `@paper-design/shaders`، `@paper-design/shaders-react` و `baseline-browser-mapping` فایل `NOTICE` یا `LICENSE.txt` همراه دارند. | پوشهٔ هر بسته در `node_modules` | Apache-2.0 حفظ فایل `NOTICE` را الزام می‌کند | متن `NOTICE` این بسته‌ها در ۳۲.۲ عیناً در `NOTICE` پروژه بیاید | ۳۲.۲ |
| F-10 | کم | چند wheel پایتون کتابخانهٔ بومی بسته‌بندی‌شده دارند: `cryptography` (OpenSSL)، `lxml` (libxml2/libxslt)، `argon2-cffi` (argon2)، `pypdf`، `python-calamine`، `pyyaml` (libyaml). | پوشهٔ `licenses/` در `dist-info` هر بسته | متن مجوز کتابخانهٔ بومیِ بسته‌بندی‌شده هم جزء توزیع است | ۳۲.۲ متن‌های موجود در `dist-info/licenses/` را به `NOTICE` منتقل کند | ۳۲.۲ |
| F-11 | اطلاع | `uv` با `pip install uv==0.12.18` در `apps/api/Dockerfile` نصب می‌شود، نه با lockfile و نه با hash. | `apps/api/Dockerfile:2` | build بدون hash قابل بازتولید کامل نیست، هرچند نسخه ثابت است | در ۳۲.۲ یا ۳۳.۳ ثبت شود؛ تغییر Dockerfile خارج از دامنهٔ این کارت است | ۳۳.۳ |
| F-12 | اطلاع | `corpus/` در `.gitignore` است و در توزیع نیست؛ کارت ۳۴.۱ به corpus ساختگیِ مجوزدار با شناسهٔ ثابت نیاز دارد. | `.gitignore:4`، `corpus/` | نصب خالی و corpus ساختگیِ مجوزدار، دو الزام جدا | کارت ۳۴.۱ ورودی این وضعیت را در قرارداد خود بیاورد | ۳۴.۱ |
| F-13 | اطلاع | `tokenizers` و `huggingface-hub` در نخستین اجرا فایل `tokenizer.json` را از Hugging Face Hub می‌گیرند؛ مجوز آن توکنایزر (Nomic) به مدل وابسته است. | `apps/api/app/documents/tokenizer.py` | مجوز مدل و توکنایزر جدا از مجوز کد است | طبق کارت ۳۲.۲، پذیرش مجوز مدل‌ها مستقل می‌ماند و در این سند داوری نمی‌شود | ۳۲.۲ |

## ۱۱. تطبیق با MIT

مجوز MIT انتخاب‌شده با همهٔ ردیف‌های runtime سازگار است. MIT اجازهٔ استفاده، تکثیر، تغییر و توزیع می‌دهد و تنها تعهدش حفظ متن اعلان است، پس هیچ‌کدام از وابستگی‌های permissive مانعی برای MIT پروژه ایجاد نمی‌کنند.

سه گروه تعهد اضافه دارند و باید در `NOTICE` پوشش داده شوند:

- **LGPL-3.0-or-later** (`libvips` و بسته‌های وابستهٔ آن): copyleft سطح کتابخانه با حق جایگزینی. پروژه این کتابخانه را تغییر نمی‌دهد، پس تعهد روی متن مجوز و امکان جایگزینی است، نه روی انتشار کد پروژه. F-01.
- **MPL-2.0** (`certifi`، و در صورت عدم انتخاب MIT برای `tqdm` و `pathspec`): copyleft سطح فایل. F-02.
- **CC-BY-4.0** (`caniuse-lite`): انتساب. F-03.

Apache-2.0 و MIT در بسته‌های runtime مشکلی ایجاد نمی‌کنند؛ فقط باید متن اعلان و هر `NOTICE` همراه بسته در توزیع حفظ شود (F-09).

محتوای ثالثِ vendored (F-04، F-05، F-06) از MIT پروژه مستقل است: MIT فقط رفتار مالک را تعیین می‌کند و مجوز کدی را که مالک ندارد تغییر نمی‌دهد. تا وقتی این موارد تعیین تکلیف نشده‌اند، وضعیت آن‌ها «نامشخص» است و نباید در `NOTICE` به‌عنوان «MIT» یا «مجوز پروژه» معرفی شوند.

## ۱۲. روش بازتولید

همهٔ فرمان‌ها از ریشهٔ مخزن و بدون تغییر وضعیت اجرا می‌شوند.

**closure و نسخه‌های Python**

```bash
( cd apps/api && uv sync --locked )        # نصب دقیق مطابق lockfile
( cd apps/api && python3 - <<'PYEOF'
import tomllib, pathlib
lock = tomllib.loads(pathlib.Path("uv.lock").read_text())
pkgs = {p["name"]: p for p in lock["package"]}
root = pkgs["enterprise-knowledge-copilot-api"]
def deps_of(p):
    d = set()
    for x in p.get("dependencies", []):
        d.add(x["name"] if isinstance(x, dict) else x)
    for ex in p.get("optional-dependencies", {}).values():
        for x in ex:
            d.add(x["name"] if isinstance(x, dict) else x)
    return d
def closure(seed):
    seen, stack = set(), list(seed)
    while stack:
        n = stack.pop()
        if n in seen or n not in pkgs:
            continue
        seen.add(n)
        stack.extend(deps_of(pkgs[n]))
    return seen
rt = closure([x["name"] if isinstance(x, dict) else x for x in root["dependencies"]])
dev = closure(["mypy", "pytest", "ruff"]) - rt
print(f"runtime={len(rt)} dev_only={len(dev)}")
PYEOF
)
```

**مجوز بسته‌های نصب‌شدهٔ Python**

```bash
( cd apps/api && python3 - <<'PYEOF'
import pathlib, re
for d in sorted(pathlib.Path(".venv/lib/python3.12/site-packages").glob("*.dist-info")):
    m = (d / "METADATA").read_text(errors="replace")
    g = lambda k: (re.search(r"^" + k + r": (.+)$", m, re.M).group(1) if re.search(r"^" + k + r": (.+)$", m, re.M) else "-")
    print(f"{g('Name')}|{g('Version')}|{g('License-Expression') or g('License')}|{g('Home-page')}")
PYEOF
)
```

**closure و مجوز npm**

```bash
( cd apps/web && node -e '
const lock = require("./package-lock.json").packages;
const resolve = (from, name) => {
  let dir = from;
  for (;;) {
    const cand = (dir ? dir + "/" : "") + "node_modules/" + name;
    if (lock[cand]) return cand;
    if (!dir) return null;
    const i = dir.lastIndexOf("/node_modules/");
    dir = i < 0 ? "" : dir.slice(0, i);
  }
};
const root = lock[""];
const closure = (direct) => {
  const seen = new Set(), stack = direct.map((n) => [n, ""]);
  while (stack.length) {
    const [name, from] = stack.pop();
    const p = resolve(from, name);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const v = lock[p];
    for (const d of Object.keys(v.dependencies || {})) stack.push([d, p]);
    for (const d of Object.keys(v.optionalDependencies || {})) stack.push([d, p]);
  }
  return seen;
};
const prod = closure(Object.keys(root.dependencies || {}));
const all = closure([...Object.keys(root.dependencies || {}), ...Object.keys(root.devDependencies || {})]);
console.log("runtime=" + prod.size + " dev_only=" + (all.size - prod.size));
' )
```

**محتوای واقعی image وب**

```bash
( cd apps/web && npm run build )
( cd apps/web && find .next/standalone/node_modules -maxdepth 3 -name package.json )
```

**مدرک upstream برای موارد پرچم‌خورده**

```bash
curl -s https://raw.githubusercontent.com/dorianbrown/rank_bm25/master/LICENSE   # F-07
curl -s https://raw.githubusercontent.com/certifi/python-certifi/master/LICENSE # F-02
curl -s https://raw.githubusercontent.com/rastikerdar/vazirmatn/v33.003/OFL.txt
```

## ۱۳. نامشخص‌ها و محدودیت‌ها

- **نشانی عمومی upstream برای ۱۵ مهارت `.agents` وجود ندارد.** manifest فقط مسیر محلی cache را نگه داشته است. متن مجوز این مهارت‌ها با حدس پر نشد؛ وضعیت «نامشخص» ثبت شد (F-04).
- **نویسنده و مجوز سند «THE VIBE CODING BLUEPRINT»** که دو فایل مرجع از آن گرفته شده‌اند معلوم نیست، چون سند دسترسی عمومی ندارد (F-06).
- **مجوز مدل‌ها و توکنایزر** داوری نشد؛ طبق کارت ۳۲.۲ پذیرش آن مستقل است (F-13).
- **مجوز محتوایی که کاربر سازمان بارگذاری می‌کند** در دامنهٔ این مخزن نیست.
- **ستون «در image وب» از یک build واقعی روی `linux-x64`** گرفته شده است. در پلتفرم‌های دیگر بسته‌های متفاوتی نصب می‌شوند و مجموعهٔ باینری‌های بومی متفاوت خواهد بود.
- **مجوز محتوای `docs/archive/`** بررسی نشد؛ این پوشه اسناد تاریخی داخلی پروژه است و در توزیع هست. اگر روزی محتوای شخص ثالث به آن اضافه شود، در دامنهٔ همین سند می‌آید.
- **این ممیزی وضعیت لحظه‌ای را ثبت می‌کند**: نسخه‌ها از `uv.lock` و `package-lock.json` فعلی برداشته شده‌اند. با تغییر این دو فایل، سند باید به‌روز شود.
