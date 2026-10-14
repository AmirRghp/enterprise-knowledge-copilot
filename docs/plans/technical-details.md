# مرجع فنی قراردادها و مثال‌های پروژه

> **کاربرد:** این سند مرجع فنی قراردادها و مثال‌هاست و برنامهٔ اجرایی نیست. ترتیب اجرا، وضعیت و checkboxها فقط در [برنامهٔ مرحله‌ای](plans.md) ثبت می‌شوند. پارت ۲۰ تنظیم provider در DB را معرفی و در ۲۰۲۶-۱۰-۱۳ با SHA `4eee1502c287bf9a4e01fe3f2004dac999e6a9d6` روی `origin/main` منتشر کرد؛ تعریف‌های provider زیر سابقه/نمونه هستند.

**Goal:** ساخت یک نمونهٔ اولیهٔ فارسی برای پرسش‌وپاسخ مستند سازمانی با دو نقش، مدیریت چرخهٔ عمر سند، بازیابی ترکیبی و ارزیابی قابل‌بازتولید.

**Architecture:** رابط Next.js همهٔ درخواست‌های same-origin را از Route Handler به FastAPI عبور می‌دهد؛ API در هر درخواست نقش را از نشست پایگاه‌داده‌ای حل می‌کند. PostgreSQL و pgvector تنها پایگاه‌داده‌اند و API یک worker تک‌فرایندی برای صف ingestion دارد. retrieval فقط در دامنهٔ اسناد مجاز انجام می‌شود، BM25 و جست‌وجوی برداری را با RRF ادغام می‌کند و زنجیره‌های provider برای chat و rerank از DB پیکربندی می‌شوند. جزئیات رفتار provider پیش از Part 20 سابقهٔ طراحی/اجرا هستند.

**Tech Stack:** Next.js، TypeScript، Python 3.12، FastAPI، SQLAlchemy، Alembic، PostgreSQL و pgvector؛ `rank_bm25` برای BM25 درون‌حافظه‌ایِ هر درخواست؛ embedding انتخابی از OpenAI، OpenRouter یا Ollama با مدل واردشدهٔ مدیر؛ پیشوندهای Nomic فقط برای همان مدل، OpenRouter rerank با `nvidia/llama-nemotron-rerank-vl-1b-v2:free` (اختیاری و خاموش)، و OpenRouter generation با `google/gemini-2.5-flash` قابل‌پیکربندی.

**Spec:** هشت سند اصلی Part 2 در `docs/` مقدم‌اند؛ قواعد دقیق رابط در `docs/DESIGN_SYSTEM.md` و مرجع `docs/references/notion-DESIGN.md`؛  [مشخصات محصول](../PRD.md)، [معماری](../ARCHITECTURE.md)، [مدل داده](../DATABASE.md)، [امنیت](../SECURITY.md)، [راهنمای ارزیابی](../evaluation-guide.md)، و معیار ثابت [eval/questions.jsonl](../../eval/questions.jsonl).

## نگاشت موضوع‌های فنی به برنامهٔ اجرا

| موضوع در این مرجع | پارت‌های مرتبط |
|---|---|
| قرارداد دامنه، تنظیمات، schema و health (موضوع ۱) | ۱، ۳ |
| هویت، نشست و proxy هم‌مبدأ (موضوع ۲) | ۴، ۵ |
| job و چرخهٔ عمر سند (موضوع ۳) | ۸، ۱۰ |
| parse، قطعه‌بندی، embedding و ورود corpus (موضوع ۴) | ۶، ۷، ۹ |
| retrieval ترکیبی و rerank (موضوع ۵) | ۱۱، ۱۲ |
| پاسخ، استناد و abstention (موضوع ۶) | ۱۳، ۱۴، ۱۵ |
| endpointهای سند و پاسخ (موضوع ۷) | ۹، ۱۰، ۱۵، ۱۶، ۱۷ |
| رابط فارسی و ارجاع (موضوع ۸) | ۲، ۵، ۹، ۱۶، ۱۷ |
| ارزیابی و راهنمای اجرا (موضوع ۹) | ۱۸، ۱۹ |

موضوع‌ها و مثال‌های پایین فقط اطلاعات طراحی‌اند؛ ترتیب و دامنهٔ کار را از جدول بالا یا این سند استنتاج نکنید. برای اجرا، تنها پارت درخواستی از برنامه مرجع است.

## Global Constraints

- **پارت ۱۴، سه قاعده که از اندازه‌گیری آمدند.** (۱) **تحمل نگاشت در مقایسه، عین‌بودن در استناد:** `quote in source` خالص روی corpus واقعی غیرقابل استفاده بود — ۸۷ از ۱۰۹ قطعه نیم‌فاصله دارند و یک نقل‌قول ۱۰۰ نویسه‌ای با احتمال ~۷۵٪ یکی دارد — پس نقل‌قول با نگاشت طول‌ثابت و توکن‌های مجاور پذیرفته می‌شود ولی **بازهٔ سروشده از متن passage برداشته می‌شود**. مرز توکن از خود `normalize_for_search` استخراج می‌شود نه با فهرست موازی. **پیوستگی شرط است:** دو تکهٔ واقعی که به هم چسبیده‌اند نقل نمی‌کنند. **کف دو توکن** است نه شمار نویسه، چون واژه‌های فارسی کوتاه‌اند. (۲) **دروازهٔ نهایی پیش از اعتبارسنجی:** قطعه‌های ارجاع‌شده یک‌بار دیگر زیر allowlist در نشست تازه خوانده می‌شوند؛ نبودِ هر کدام یعنی حذف/جایگزینی/باریک‌سازی در پنجرهٔ بین ارسال و تحویل، و کل پاسخ رد می‌شود. ترتیب عمدی است: نقل‌قول فقط مقابل متنی سنجیده می‌شود که در آخرین لحظه مجاز بوده. (۳) **سقف claimها در لایهٔ پاسخ است، نه در schema:** `GENERATION_SCHEMA` روی `claims` حد `maxItems` ندارد و افزودنش ریسک رد شدن کل درخواست را دارد، چون پارامتر پشتیبانی‌نشده نادیده گرفته می‌شود و با `require_parameters` نادیده‌گرفتن به رد تبدیل می‌شود.
- نقش معتبر فقط از هویت نشست سمت سرور می‌آید؛ هیچ ورودی UI، سؤال یا ادعای کاربر سطح دسترسی را تغییر نمی‌دهد.
- کوکی نشست opaque، هش نشست در DB، `HttpOnly`, `SameSite=Lax`, `Secure` در HTTPS؛ نشست ۸ ساعت؛ رمز با Argon2id از طریق `pwdlib`.
- دو حساب seedشده از مقادیر `.env` نادیده‌گرفته‌شده؛ بدون ثبت‌نام عمومی، بازنشانی رمز یا ارتقای نقش در UI. هیچ رمز واقعی/ضعیفی در مخزن قرار نگیرد.
- مسیر native: Next.js و FastAPI روی میزبان، Ollama موجود روی 11434 و `rag-postgres` روی 5433. مسیر نصب تازهٔ پارت ۲۳: Compose با سرویس‌های وب، API، worker و PostgreSQL/pgvector مستقل، بدون Ollama؛ نام DB برنامه `enterprise-pgvector` و پورت میزبان پیش‌فرض 5434، قابل تنظیم با `POSTGRES_HOST_PORT` در `.env`. صف همان PostgreSQL است و Redis اضافه نمی‌شود.
- PostgreSQL 16.15 و pgvector 0.8.6 موجود تأیید شدند. پیش از migration فقط دیتابیس جدید `enterprise_knowledge_copilot` و حساب محدود آن ایجاد شود؛ دیتابیس‌ها و volumeهای قبلی تغییر نکنند.
- منابع آغازین ۲۰ فایل Markdown هستند؛ بارگذاری فقط `.md`/`.txt`، حداکثر ۱ MiB هر فایل و ۱۰۰ سند فعال؛ پرسش حداکثر ۲۰۰۰ نویسه. سقف آغازین کل ۲۰۰۰ قطعهٔ جاری، پس از parse و پیش از فراخوانی provider بررسی شود؛ جایگزینی از سهم قطعه‌های نسخهٔ قبلی همان سند اعتبار می‌گیرد.
- قطعه‌بندی درون هر بخش: حداکثر ۱۲۰۰ نویسه و ۴۰۰ توکن شامل prefix، با هم‌پوشانی حداکثر ۱۵۰ نویسه؛ tokenizer باید با مدل منطبق باشد و embedding با `truncate=false` انجام شود. شناسهٔ نمایشی ارجاع `document_id + section_id + revision` است و `chunk_id` هرگز مرجع کاربر نیست.
- تنها اسناد جاری، فعال، `ready` و مجاز وارد retrieval می‌شوند. مجوز پیش از جست‌وجو، پیش از rerank، پیش از generation و دوباره پیش از تحویل پاسخ/بخش منبع بررسی می‌شود.
- بردارها با pgvector و جست‌وجوی exact scan نگهداری می‌شوند؛ دو فهرست lexical/vector هرکدام top-20، RRF با `k=60`، rerank اختیاری و پیش‌فرض خاموش، حداکثر ۲۰ نامزد و حداکثر ۵ نتیجهٔ نهایی.
- خطای transport/key/model/schema می‌تواند به اتصال بعدی همان زنجیره برود؛ خطای authorization/evidence/citation/digest terminal است و fallback نمی‌شود. rerank غیرفعال صفر فراخوانی دارد. Part 20 در ۲۰۲۶-۱۰-۱۳ با SHA `4eee1502c287bf9a4e01fe3f2004dac999e6a9d6` روی `origin/main` منتشر شد.
- OpenRouter rerank از `POST /api/v1/rerank` با `model`, `query`, `documents` به‌صورت فهرست رشته‌ها و `top_n` استفاده می‌کند ([مرجع API رسمی](https://openrouter.ai/docs/api/api-reference/rerank/create-rerank), [راهنمای RAG رسمی](https://openrouter.ai/docs/guides/evaluate-and-optimize/rag)). برای حداکثر ۲۰ candidate مجاز، پاسخ باید دقیقاً تعداد مورد انتظار نتیجهٔ قابل‌اعتبارسنجی داشته باشد. `index` باید integer غیر boolean، در بازهٔ ورودی و یکتا و `relevance_score` عدد متناهی باشد؛ نتیجهٔ مفقود/تکراری/نامعتبر رد می‌شود و fallback خاموش ندارد. هر index فقط به همان `chunk_id` متناظر در فهرست ارسالی map می‌شود و متن بازگشتی مدل منبع هویت/محتوای chunk محسوب نمی‌شود. adapter داخلی باید `ScoredCandidate` را با همان chunk record بازگرداند. preflight آغازین Part 12 یک نمونهٔ کوچکِ واقعی را، فقط وقتی کلید موجود است، برای تطبیق index/score و ترتیب فارسی بررسی می‌کند؛ کیفیت رتبه‌بندی فارسی از پیش ادعا نمی‌شود.
- مدل رایگان rerank برای چت یا embedding نیست. دادهٔ درخواست برای امنیت و بهبود NVIDIA ثبت می‌شود ([اطلاعات مدل و ارائه‌دهنده](https://openrouter.ai/nvidia/llama-nemotron-rerank-vl-1b-v2:free/providers))؛ فقط دادهٔ ساختگی و غیرشخصی پروژه مجاز است. هیچ محدودیت نرخ/سهمیهٔ عددی در این طراحی **فرض نشده بود**؛ دسترسی و محدودیت واقعی باید هنگام preflight بررسی شود. **اصلاح پارت ۱۳:** این فرض برای endpoint تولید نادرست از آب درآمد و اندازه‌گیری شد. `POST /api/v1/chat/completions` روی مدل‌های رایگان با `429` و `X-RateLimit-Limit: 50` پاسخ می‌دهد — یعنی **پنجاه درخواست در روز به‌ازای هر حساب** — با `metadata.limit_source` برابر `openrouter_free_tier_daily` و `X-RateLimit-Reset` در نیمه‌شب UTC. پیام remediation خود OpenRouter می‌گوید یا تا reset صبر کنید یا اعتبار بخرید. این یعنی مسیر generation برای استفادهٔ مداوم با این کلید قابل اتکا نیست و هر preflight هم سهمیه مصرف می‌کند. کد در برابر آن درست رفتار می‌کند — `429` گذراست و در بودجهٔ دو تلاشی retry می‌شود و سپس **با خطای آشکار و بدون fallback** شکست می‌خورد — و adapter این refusal را با کلمات خودش نام می‌برد (`last_refusal`) تا اپراتور بداند منتظر بماند نه دنبال خرابی بگردد.
- deadline کل درخواست پاسخ ۶۰ ثانیه است؛ هر تلاش generation حداکثر ۳۰ ثانیه و حداکثر ۲ تلاش generation در همان سقف کل، با network retry و JSON repair که این سقف را باهم شریک‌اند. embedding و rerank تلاش‌های محدود و deadline واقعی دارند؛ بازسازی embedding در worker تا ۴۵ ثانیه برای هر تلاش و ۹۰ ثانیه در مجموع بودجه دارد. exponential jitter فقط برای 429/502/503/504 یا خطای شبکه؛ JSON نامعتبر حداکثر یک repair در سقف دو تلاش generation. آزمون اتصال embedding باید هویت مدل، بُعد یکسان و مقادیر معتبر بردارهای query/document را تأیید کند؛ OpenRouter preflight باید پشتیبانی پارامترهای اجباری JSON Schema را تأیید کند یا با خطای روشن متوقف شود.
- lease کار ingestion برابر ۱۲۰ ثانیه و تمدید هر ۳۰ ثانیه؛ حداکثر ۳ تلاش. خطای قطعی parse دائمی است؛ به‌روزرسانی وضعیت job و تعویض revision با شرط compare-and-swap انجام شود.
- مجموعهٔ ثابت ۴۰تایی معیار ارزیابی برای تنظیم مدل، prompt، رتبه‌بندی یا امتناع استفاده نشود؛ سؤال‌های توسعه باید fixture جدا و بدون هم‌پوشانی باشند.
- همهٔ متن‌ها و پیام‌های قابل مشاهدهٔ کاربر فارسی و رابط RTL باشد؛ نام مسیرهای API و فایل‌ها لاتین باقی می‌ماند؛ متن سند و prompt به‌عنوان دادهٔ نامطمئن تفسیر شوند. متن حساس غیرضروری و رازهای provider در log ثبت نشوند.
- وضعیت پیاده‌سازی را از اسناد جاری و وضعیت واقعی checkout بخوانید؛ این مرجع قرارداد طراحی را ثبت می‌کند و وضعیت اجرایی را تعیین نمی‌کند. `.env` محلی نیازمند کلید و حساب دیتابیس مستقل است.

## Review Focus

- تلاش کارمند برای کشف یا استنتاج سند مدیریتی باید پیش از retrieval حذف شود؛ آزمون API باید نبود شناسه/عنوان/تعداد سند مدیریتی را در نتیجه، source، خطا و log قابل‌مشاهده بررسی کند (موضوع‌های فنی ۲، ۵ و ۷).
- محدودشدن نقش، حذف سند یا جایگزینی revision هم‌زمان با generation نباید پاسخ یا بخش قدیمی را تحویل دهد؛ آزمون تغییر مجوز میان retrieval و final recheck باید پاسخ را رد کند (موضوع‌های فنی ۳ و ۶).
- خطا یا timeout در Ollama، OpenRouter rerank اختیاری یا OpenRouter generation نباید پاسخ حدسی یا شناسهٔ ساختگی بسازد؛ آزمون timeout، پاسخ rerank نامعتبر، JSON نامعتبر و پایان سقف retry باید خطای امن و telemetry ثبت‌شده را بسنجد (موضوع‌های فنی ۵ و ۶).
- فایل خراب، front matter نامعتبر، quota لب‌مرز و worker متوقف‌شده نباید سند را `ready` کند یا job را گم کند؛ آزمون recovery و idempotency برای ingestion لازم است (موضوع‌های فنی ۳ و ۴).
- رابط فارسی در عرض‌های 320، 375 و 768 پیکسل، با صفحه‌کلید و بازشدن inspector منبع باید بدون overflow کار کند؛ آزمون مرورگر، نه فقط snapshot، این رفتار را بررسی کند (موضوع فنی ۸).

---

### موضوع فنی 1: اسکلت سرویس‌ها، پیکربندی و قراردادهای دامنه

**همگام‌سازی پارت ۲۰ (منتشرشده در ۲۰۲۶-۱۰-۱۳، SHA `4eee1502c287bf9a4e01fe3f2004dac999e6a9d6`):** تنظیم DB از محیط می‌ماند، اما providerها از جداول versioned/locked `provider_configs` و `provider_chains` خوانده می‌شوند. کلیدها با Fernet و `APP_ENCRYPTION_KEY` رمز می‌شوند؛ نصب تازه provider ندارد و env خودکار import نمی‌شود. Chat از Ollama/OpenAI/compatible/OpenRouter پشتیبانی می‌کند؛ rerank فقط OpenRouter یا compatible روی `/rerank`؛ embedding فقط قرارداد جاری Ollama Nomic v2 MoE با digest/prefix/tokenizer و ۷۶۸بعدی. API، worker، CLI و eval تنظیم مشترک را بدون restart می‌خوانند. اعتبارسنجی فنی پارت ۲۰ در ۲۰۲۶-۱۰-۱۲ و ۲۰۲۶-۱۰-۱۳ ثبت شده و پیاده‌سازی در ۲۰۲۶-۱۰-۱۳ منتشر شد. هر درخواست API بودجهٔ سراسری ۶۰ ثانیه دارد و deadline واقعی باقی‌مانده بین تلاش‌های هر زنجیره اعمال می‌شود. refusalهای سیاستی مانند `finish_reason=content_filter` یا `message.refusal` terminal هستند و fallback نمی‌شوند. پیکربندی URL ممنوع، DNS غیرمجاز و redirect نیز terminal است. پایان retryهای embedding می‌تواند به اتصال سازگار بعدی برود؛ timeout خام ingestion job را pending می‌کند و گزارش‌های provider usage آن تلاش را نگه می‌دارند. مصرف هر تلاش در `provider_usage` ثبت می‌شود؛ currencyهای متفاوت providerها با هم جمع نمی‌شوند.

**همگام‌سازی Part 21 (منتشرشده در ۲۰۲۶-۱۰-۱۳، SHA `0fa348c7d13e3aa598e865cb54d08eb9554320cf`):** Migration `0004` به `provider_configs` ستون nullable `temperature` افزوده است. فقط اتصال‌های chat مقدار finite بین ۰ تا ۲ می‌پذیرند؛ پیش‌فرض و backfill `0.7` است، و purposeهای دیگر باید `NULL` بمانند. مقدار ذخیره‌شده از snapshot runtime به adapter تولید می‌رسد و در API، CLI، probe، retry و repair یکسان استفاده می‌شود؛ eval metadata نیز آن را ثبت می‌کند. کلاینتی که فیلد را نفرستد مقدار فعلی را حفظ می‌کند. پارامتر پشتیبانی‌نشده حذف نمی‌شود و خطا از قواعد type/fallback جاری پیروی می‌کند. migration روی DBهای برنامه و آزمون اعمال شده و Part 21 روی `origin/main` منتشر شده است.

**همگام‌سازی Part 23:** محدودیت embedding پارت ۲۰ به Ollama/Nomic، بُعد ۷۶۸ و fallback بین اتصال‌ها دیگر قرارداد جاری نیست. مدیر اتصال OpenAI، OpenRouter یا Ollama و نام مدل را ثبت و آزمایش می‌کند؛ یک اتصال فعال انتخاب می‌شود و تغییر آن روی index موجود فقط پس از تأیید و بازسازی پایدار انجام می‌گیرد. migrationهای `0007` و `0008` بُعد انعطاف‌پذیر، job بازسازی و برابری بُعد واقعی بردار را برقرار می‌کنند. جزئیات و شواهد در [پایگاه‌داده](../DATABASE.md) و [گزارش آزمون](../TESTING.md) آمده‌اند.

**Interfaces:**
- Produces: `Role = Literal['employee','manager']`; `Actor(user_id: UUID, role: Role, session_id: UUID)`; `SourceRef(document_id: str, section_id: str, revision: str)`; `ChunkRecord(chunk_id: UUID, document_id: str, revision: str, section_id: str, text: str, access_role: Role, ordinal: int)`; `RetrievalHit(chunk: ChunkRecord, lexical_rank: int|None, vector_rank: int|None, fused_score: float, rerank_score: float|None)`; `Claim(text: str, quote: str, source_refs: list[SourceRef])`; `ProviderUsage(provider: str, model: str, input_tokens: int|None, output_tokens: int|None, billed_units: dict[str, int|float|str], tariff: dict[str, Decimal]|None, cost: Decimal|None, currency: str|None)`; `AnswerResult(answer: str, claims: list[Claim], sources: list[SourceRef], abstained: bool, retrieval_hits: list[RetrievalHit], usage: list[ProviderUsage])`.
- Produces: `UploadInput(title: str, access_role: Role)` confirmed by the manager in the request; `ParsedSection(section_id: str|None, title: str, heading_path: list[str], text: str, ordinal: int)`; `ParsedDocument(seed_document_id: str|None, version: str, content_status: Literal['active','inactive'], sections: list[ParsedSection])`; `DocumentSummary(document_id: str, title: str, access_role: Role, version: str, content_status: str, processing_status: str, updated_at: datetime, job_id: UUID|None, safe_error: str|None)`; `IngestionJob(job_id: UUID, document_id: str, revision: str, status: Literal['pending','indexing','ready','failed'], attempt: int, safe_error: str|None)`; `SectionView(ref: SourceRef, title: str, heading_path: list[str], text: str)`.
- Produces: `RetrievalConfig(lexical_top_k: int=20, vector_top_k: int=20, rrf_k: int=60, rerank_enabled: bool, rerank_top_k: int=20, final_top_k: int=5)`; `AnswerConfig(model: str, prompt_version: str, total_timeout_s: int=60, generation_timeout_s: int=30, retrieval: RetrievalConfig)`; provider protocols `embed_documents(texts) -> list[list[float]]`, `embed_query(text) -> list[float]`, `generate(messages, response_schema) -> GenerationResult`, `rerank(query, candidates) -> list[ScoredCandidate]`; `ScoredCandidate(chunk_id: UUID, score: float)` در همین قرارداد دامنه تعریف می‌شود.
- Produces: internal `AnswerResult` for services/evaluation only; public `AnswerResponse(answer: str, claims: list[Claim], sources: list[SourceRef], abstained: bool, request_id: UUID)`—never expose retrieval hits, usage details or raw chunks on the answer API.
- Produces: تنظیمات زیرساختی تایپ‌شده از env و اتصال SQLAlchemy؛ تنظیم providerها از `provider_chains`/`provider_configs` در DB؛ جداول `users`, `sessions`, `documents`, `ingestion_jobs`, `sections`, `chunks`, `request_runs`, `provider_chains`, `provider_configs`؛ health endpoint `GET /api/health`.
- Consumes: قواعد پایگاه‌داده از [DATABASE](../DATABASE.md) و lifecycle از [ARCHITECTURE](../ARCHITECTURE.md).


### موضوع فنی 2: ورود، نشست و proxy هم‌مبدأ

**Interfaces:**
- Consumes: `Actor`, `Role` از موضوع فنی ۱.
- Produces: `resolve_actor(session_cookie: str | None) -> Actor | None`; APIهای `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`; Route Handler هم‌مبدأ که `/api` را بی‌تغییر به API عبور می‌دهد.
- ورود فقط حساب‌های seedشدهٔ employee/manager را می‌پذیرد؛ `Origin` درخواست POST باید با میزبان هم‌مبدأ برابر باشد و در نبود آن درخواست رد شود.


```python
assert resolve_actor(cookie).role == "employee"
db_user.role = "manager"
assert resolve_actor(cookie).role == "manager"
```

### موضوع فنی 3: ثبت سند، jobهای پایدار و عملیات مدیر

**Interfaces:**
- Consumes: `Actor`, `SourceRef` و session/DB از موضوع‌های فنی ۱ و ۲.
- Produces: `stage_upload(actor: Actor, file: UploadFile, metadata: UploadInput) -> IngestionJob`; `process_next_job() -> bool`; `list_documents(actor: Actor) -> list[DocumentSummary]`; `read_section(actor: Actor, ref: SourceRef) -> SectionView`; `replace_document(actor: Actor, document_id: str, file: UploadFile, metadata: UploadInput) -> IngestionJob`; `delete_document(actor: Actor, document_id: str) -> None`.
- Routes: `/api/manager/documents`, `/api/manager/documents/{document_id}`, `/api/manager/jobs/{job_id}`؛ manager-only. وضعیت job: `pending`, `indexing`, `ready`, `failed`.


### موضوع فنی 4: parse، قطعه‌بندی و آماده‌سازی بردار

**Interfaces:**
- Consumes: `process_next_job()` از موضوع فنی ۳؛ متن مبدأ و metadata تأییدشده.
- Produces: `parse_document(text: str) -> ParsedDocument`; `chunk_sections(document: ParsedDocument, *, document_id: str, revision: str, access_role: Role, max_chars: int = 1200, max_tokens: int = 400, overlap: int = 150) -> list[ChunkRecord]`; `EmbeddingProvider.embed_documents(texts: list[str]) -> list[list[float]]` با پیشوند `search_document: ` و `EmbeddingProvider.embed_query(text: str) -> list[float]` با پیشوند `search_query: `; `ingest_corpus(path: Path, actor: Actor) -> list[IngestionJob]` فقط برای import اپراتورمحور و حفظ IDهای `corpus-index.md`; provider در config قابل تعویض است. Upload جدید ID سروری می‌گیرد.


### موضوع فنی 5: بازیابی مجاز واژگانی، برداری و رتبه‌بندی

**Interfaces:**
- Consumes: `Actor`, `RetrievalHit`, `ChunkRecord`; embedding query از موضوع فنی ۴.
- Produces: `retrieve(actor: Actor, question: str, config: RetrievalConfig) -> list[RetrievalHit]`; query embedding با پیشوند `search_query: `; `rerank_hits(question: str, hits: list[RetrievalHit]) -> list[RetrievalHit]`.
- خط سیر ثابت: DB allowlist برای همان actor روی سند جاری/فعال/`ready`؛ `rank_bm25` روی همان قطعه‌های مجازِ بارگذاری‌شده برای هر درخواست؛ pgvector exact scan روی همان allowlist؛ top-20 برای هر مسیر؛ RRF `k=60`; rerank حداکثر ۲۰؛ خروجی حداکثر ۵. نرمال‌سازی فارسی فقط روی متن مشتق جست‌وجو (ي/ی، ك/ک، رقم‌های فارسی/عربی/لاتین، فاصله/نیم‌فاصله) انجام شود؛ متن منبع برای quote بدون تغییر بماند.


```python
hits = retrieve(employee, "برنامه‌ریزی نیرو", config)
assert all(hit.chunk.access_role == "employee" for hit in captured_reranker_input)
assert all(not hit.chunk.document_id.startswith("MGR-") for hit in hits)
assert normalize_for_search("ي ك ۱۵ نیم‌فاصله") == normalize_for_search("ی ک 15 نیم فاصله")
assert source_text == original_source_text
```

### موضوع فنی 6: پاسخ ساختاریافته، استناد و abstention امن

**Interfaces:**
- Consumes: `retrieve(actor, question, config)` از موضوع فنی ۵؛ `SourceRef(document_id, section_id, revision)` و `ProviderUsage` از موضوع فنی ۱.
- Produces: `answer(actor: Actor, question: str, config: AnswerConfig, history: Sequence[ConversationTurn] = ()) -> AnswerResult`; ورودی history حداکثر پنج نوبت موقت است و منابعش پیش از هر تلاش دوباره مجاز و جاری می‌شوند. `GenerationResult(claims: list[Claim], abstained: bool, missing_parts: list[Literal['insufficient_evidence','ambiguous','conflict']], answer: str|None)`—نثر مدل فقط در کنار claimهای معتبر نمایش داده می‌شود؛ منابع زیر آن و quoteها در جزئیات بسته‌اند. `ValidatedClaims(claims: list[ValidatedClaim])` و `InvalidGeneration(ValueError)` در `answer/schemas.py`؛ `validate_generation(payload, evidence) -> ValidatedClaims` همهٔ claims را یک‌جا می‌پذیرد/رد می‌کند؛ `compose_answer` نثر مدل را با امتناع خنثای ثابت می‌سازد. **انحراف پیاده‌سازی از این طرح:** نوع claim پذیرفته‌شده `ValidatedClaim` است نه `Claim`، چون `Claim.evidence_id` دستگیرهٔ بی‌معنای مدل است و استناد سروشده باید `SourceRef` را حمل کند؛ quote سروشده هم بازهٔ برداشته‌شده از passage است نه رشتهٔ مدل. اعتبار quote، درستی معنایی کل نثر را ثابت نمی‌کند و بازبینی انسانی لازم است.
- `POST /api/answers` در موضوع فنی ۷ به سرویس متصل می‌شود؛ سؤال حداکثر ۲۰۰۰ نویسه و حداکثر پنج منبع citation.


```python
with pytest.raises(InvalidGeneration):
    validate_generation(payload_with_one_bad_claim, authorized_evidence)
```

### موضوع فنی 7: APIهای پرسش، منبع و مدیریت

**Interfaces:**
- Consumes: auth dependencies از موضوع فنی ۲؛ document services از موضوع فنی ۳؛ `answer()` از موضوع فنی ۶.
- Produces: `GET /api/documents` فقط برای هر نقش، شامل سندهای فعال و ready مجاز؛ `POST /api/answers`; `GET /api/sources/{document_id}/sections/{section_id}?revision=...`; مدیر: `GET/POST /api/manager/documents`, `PUT/DELETE /api/manager/documents/{document_id}` و `GET /api/manager/jobs/{job_id}`. همهٔ responseها typed و خطاها بدون افشای وجود منبع ممنوع.


```python
assert set(answer.json()) == {"answer", "claims", "sources", "abstained", "request_id"}
missing = client.get(source_url_for("absent", "X-S1", "r1"))
forbidden = client.get(source_url_for("MGR-002", "MGR-002-S1", "1"), as_employee=True)
stale = client.get(source_url_for("HR-001", "HR-001-S1", "old-revision"))
assert missing.status_code == forbidden.status_code == stale.status_code == 404
assert missing.json() == forbidden.json() == stale.json()
```

### موضوع فنی 8: رابط فارسی RTL و تجربهٔ ارجاع

**Interfaces:**
- Consumes: same-origin `/api/*` routes از موضوع‌های فنی ۲ و ۷.
- Produces: ورود، پرسش‌وپاسخ، کارت ادعا/ارجاع، inspector با `document_id/section_id/revision`، `SourceList` جداگانه برای منابع مجاز employee از `/api/documents` و `ManagerDocuments` فقط برای فهرست/آپلود/status اسناد مدیر.


### موضوع فنی 9: ارزیابی، گزارش و اجرای بازتولیدپذیر

**Interfaces:**
- Consumes: API/service contracts, `eval/questions.jsonl` معیار ثابت و `docs/evaluation-guide.md`.
- Produces: artifact اجرای JSON/Markdown شامل نسخه/hash corpus و معیار، شناسه/نسخهٔ مدل‌های generation/embedding/rerank، prompt و تنظیمات تولید، top-k و فیلتر مجوز، پاسخ و فهرست بازیابی با document/section/rank/score/مجوز، latency کل، usage و cost همهٔ تلاش‌ها، خطاها، limitationهای log و گزارش به تفکیک category و role.
- معیارها: Recall@5 روی زوج `(document_id, section_id)` برای نمونه‌های پاسخ‌پذیر، MRR همان زوج، پشتیبانی citation و abstention، نشت مشاهده‌شده، p50/p95 و هزینه با همهٔ retryها؛ بدون ادعای تضمین کیفیت.

- Produces: `recall_at_5(ranked_pairs: list[tuple[str,str]], gold_pairs: set[tuple[str,str]], eligible: bool=True) -> float|None`; `mrr(ranked_pairs: list[tuple[str,str]], gold_pairs: set[tuple[str,str]]) -> float`; abstain یا gold خالی برای Recall مقدار `None` دارد. جفت تکراری جایگاه MRR را اشغال می‌کند اما Recall آن را یک‌بار می‌شمارد.


```python
gold_pair = ("HR-001", "HR-001-S1")
other_pair = ("HR-003", "HR-003-S1")
assert recall_at_5([gold_pair, gold_pair], {gold_pair}) == 1.0
assert mrr([other_pair, gold_pair], {gold_pair}) == 0.5
assert recall_at_5([], set(), eligible=False) is None
```

## مرزهای failure و اعتبارسنجی تکمیلی


- محتوای خام upload در DB stage می‌شود و روی filesystem نگهداری نمی‌شود. Upload فقط از نقش مدیر پذیرفته می‌شود؛ `title` و `access_role` از metadata تأییدشدهٔ مدیر می‌آیند و front matter نمی‌تواند آن‌ها یا مجوز را تعیین کند. اسناد و promptها دادهٔ نامطمئن‌اند و نمی‌توانند دستور system را تغییر دهند.
- رقابت workerها باید با lease و fencing حل شود؛ workerِ منقضی‌شده اجازهٔ commit ندارد. عملیات DB برای sections/chunks/vectorها و تغییر job به `ready` اتمی است؛ شکست index ناقص قابل جست‌وجو نمی‌سازد. Provider ممکن است پیش از crash مصرف شده باشد؛ retry می‌تواند هزینهٔ تکراری داشته باشد و exactly-once برای اثر بیرونی تضمین نمی‌شود.
- JSON Schema خروجی OpenRouter با `response_format` و `provider.require_parameters=true` اجباری است. quote هر claim باید عیناً در متن evidence ارسالی باشد؛ یک claim نامعتبر، کل payload را رد می‌کند. یک repair محدود در همان سقف دو تلاش مجاز است؛ پس از شکست، پاسخ فقط abstention خنثی است. نثر مدل کنار claimهای معتبر نمایش داده می‌شود؛ بررسی quote، entailment معنایی کل نثر را ثابت نمی‌کند.
- برای route منبع، نبودن، غیرمجازبودن و revision منسوخ باید 404 و بدنهٔ عمومی یکسان داشته باشند. DTO پاسخ عمومی فقط `answer`, `claims`, `sources`, `abstained`, `request_id` را دارد.
- مصرف هر provider برای embedding سند/پرسش، rerank و generation به `ProviderUsage.billed_units`، tariff یا وضعیت ثبت‌نشدن و `cost` nullable وصل می‌شود. گزارش ارزیابی مصرف و هزینهٔ همهٔ تلاش‌ها، درخواست‌های آغازشده/موفق، خطاها و محدودیت logging را ثبت می‌کند؛ متن خام پرسش/سند در log عملیاتی نمی‌آید. قرارداد CLI آیندهٔ runner شامل `--dataset`، `--mode vector|hybrid|hybrid_rerank` و `--output` است؛ سه حالت در اجراهای جدا ثبت می‌شوند. corpus توسعه در `eval/dev-questions.jsonl` از معیار ثابت جدا و بدون هم‌پوشانی می‌ماند.

## منابع قرارداد rerank

- [راهنمای رسمی RAG و endpoint rerank در OpenRouter](https://openrouter.ai/docs/guides/evaluate-and-optimize/rag)
- [مدل منتخب و شرایط endpoint رایگان NVIDIA](https://openrouter.ai/nvidia/llama-nemotron-rerank-vl-1b-v2:free/providers)

این منابع هنگام تغییر انتخاب مدل بررسی شدند؛ اتصال احرازهویت‌شده و کیفیت فارسی هنوز در پارت ۱۲ بررسی می‌شوند.
