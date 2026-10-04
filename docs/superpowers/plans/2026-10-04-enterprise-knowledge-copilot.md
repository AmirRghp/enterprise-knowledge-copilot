# برنامهٔ پیاده‌سازی دستیار دانش سازمانی

> **برای عامل‌های اجرایی:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ساخت یک نمونهٔ اولیهٔ فارسی برای پرسش‌وپاسخ مستند سازمانی با دو نقش، مدیریت چرخهٔ عمر سند، بازیابی ترکیبی و ارزیابی قابل‌بازتولید.

**Architecture:** رابط Next.js همهٔ درخواست‌های same-origin را از Route Handler به FastAPI عبور می‌دهد؛ API در هر درخواست نقش را از نشست پایگاه‌داده‌ای حل می‌کند. PostgreSQL و pgvector تنها پایگاه‌داده‌اند و API یک worker تک‌فرایندی برای صف ingestion دارد. retrieval فقط در دامنهٔ اسناد مجاز انجام می‌شود، BM25 و جست‌وجوی برداری را با RRF ادغام می‌کند و پس از آن در صورت فعال‌بودن Cohere rerank را اجرا می‌کند؛ تولید OpenRouter خروجی ساختاریافته با ادعاها و ارجاع‌های معتبر می‌دهد.

**Tech Stack:** Next.js، TypeScript، Python 3.12، FastAPI، SQLAlchemy، Alembic، PostgreSQL و pgvector؛ `rank_bm25` برای BM25 درون‌حافظه‌ایِ هر درخواست؛ Ollama `nomic-embed-text-v2-moe:latest` با بُعد 768 و پیشوندهای `search_document: `/`search_query: `، Cohere `rerank-v4.0-fast`، و OpenRouter با `google/gemini-2.5-flash` قابل‌پیکربندی.

**Spec:** هشت سند اصلی Part 2 در `docs/` مقدم‌اند؛ قواعد دقیق رابط در `docs/DESIGN_SYSTEM.md` و مرجع `docs/references/notion-DESIGN.md`؛  [مشخصات محصول](../../PRD.md)، [معماری](../../ARCHITECTURE.md)، [مدل داده](../../DATABASE.md)، [امنیت](../../SECURITY.md)، [راهنمای ارزیابی](../../evaluation-guide.md)، و معیار ثابت [eval/questions.jsonl](../../../eval/questions.jsonl).

## Global Constraints

- نقش معتبر فقط از هویت نشست سمت سرور می‌آید؛ هیچ ورودی UI، سؤال یا ادعای کاربر سطح دسترسی را تغییر نمی‌دهد.
- کوکی نشست opaque، هش نشست در DB، `HttpOnly`, `SameSite=Lax`, `Secure` در HTTPS؛ نشست ۸ ساعت؛ رمز با Argon2id از طریق `pwdlib`.
- دو حساب seedشده از مقادیر `.env` نادیده‌گرفته‌شده؛ بدون ثبت‌نام عمومی، بازنشانی رمز یا ارتقای نقش در UI. هیچ رمز واقعی/ضعیفی در مخزن قرار نگیرد.
- Next.js و FastAPI روی میزبان؛ استفاده از Ollama موجود روی 11434 و سرور `rag-postgres` روی 5433؛ یک دیتابیس مستقل پروژه و یک ingestion loop، بدون Redis یا DB container تازه.
- PostgreSQL 16.15 و pgvector 0.8.6 موجود تأیید شدند. پیش از migration فقط دیتابیس جدید `enterprise_knowledge_copilot` و حساب محدود آن ایجاد شود؛ دیتابیس‌ها و volumeهای قبلی تغییر نکنند.
- منابع آغازین ۲۰ فایل Markdown هستند؛ بارگذاری فقط `.md`/`.txt`، حداکثر ۱ MiB هر فایل و ۱۰۰ سند فعال؛ پرسش حداکثر ۲۰۰۰ نویسه. سقف آغازین کل ۲۰۰۰ قطعهٔ جاری، پس از parse و پیش از فراخوانی provider بررسی شود؛ جایگزینی از سهم قطعه‌های نسخهٔ قبلی همان سند اعتبار می‌گیرد.
- قطعه‌بندی درون هر بخش: حداکثر ۱۲۰۰ نویسه و ۴۰۰ توکن شامل prefix، با هم‌پوشانی حداکثر ۱۵۰ نویسه؛ شناسهٔ نمایشی ارجاع `document_id + section_id + revision` است و `chunk_id` هرگز مرجع کاربر نیست.
- تنها اسناد جاری، فعال، `ready` و مجاز وارد retrieval می‌شوند. مجوز پیش از جست‌وجو، پیش از rerank، پیش از generation و دوباره پیش از تحویل پاسخ/بخش منبع بررسی می‌شود.
- بردارها با pgvector و جست‌وجوی exact scan نگهداری می‌شوند؛ دو فهرست lexical/vector هرکدام top-20، RRF با `k=60`، rerank اختیاری و پیش‌فرض خاموش، حداکثر ۲۰ نامزد و حداکثر ۵ نتیجهٔ نهایی.
- retrieval، generation و rerank شکست‌خورده نباید پاسخ حدسی بسازند. هیچ fallback خاموش به مدل/روش آزمایشی مجاز نیست؛ اگر rerank خاموشی از پیش پیکربندی نشده، شکست آن خطای آشکار است.
- deadline کل درخواست پاسخ ۶۰ ثانیه است؛ هر تلاش generation حداکثر ۳۰ ثانیه و حداکثر ۲ تلاش generation در همان سقف کل، با network retry و JSON repair که این سقف را باهم شریک‌اند. embedding و rerank هرکدام حداکثر ۲ تلاش و هر تلاش حداکثر ۱۰ ثانیه دارند. exponential jitter فقط برای 429/502/503/504 یا خطای شبکه؛ JSON نامعتبر حداکثر یک repair در سقف دو تلاش generation.
- lease کار ingestion برابر ۱۲۰ ثانیه و تمدید هر ۳۰ ثانیه؛ حداکثر ۳ تلاش. خطای قطعی parse دائمی است؛ به‌روزرسانی وضعیت job و تعویض revision با شرط compare-and-swap انجام شود.
- مجموعهٔ ثابت ۴۰تایی معیار ارزیابی برای تنظیم مدل، prompt، رتبه‌بندی یا امتناع استفاده نشود؛ سؤال‌های توسعه باید fixture جدا و بدون هم‌پوشانی باشند.
- همهٔ متن‌ها و پیام‌های قابل مشاهدهٔ کاربر فارسی و رابط RTL باشد؛ نام مسیرهای API و فایل‌ها لاتین باقی می‌ماند؛ متن سند و prompt به‌عنوان دادهٔ نامطمئن تفسیر شوند. متن حساس غیرضروری و رازهای provider در log ثبت نشوند.
- وضعیت جاری: هشت سند اصلی و فایل‌های env تهیه می‌شوند؛ برنامه هنوز پیاده نشده است. فرمان‌ها و checkboxهای زیر مربوط به اجرای آینده‌اند؛ `.env` نیازمند کلید و حساب دیتابیس مستقل است.

## Review Focus

- تلاش کارمند برای کشف یا استنتاج سند مدیریتی باید پیش از retrieval حذف شود؛ آزمون API باید نبود شناسه/عنوان/تعداد سند مدیریتی را در نتیجه، source، خطا و log قابل‌مشاهده بررسی کند (Tasks 2, 5, 7).
- محدودشدن نقش، حذف سند یا جایگزینی revision هم‌زمان با generation نباید پاسخ یا بخش قدیمی را تحویل دهد؛ آزمون تغییر مجوز میان retrieval و final recheck باید پاسخ را رد کند (Tasks 3, 6).
- خطا یا timeout در Ollama/Cohere اختیاری/OpenRouter نباید پاسخ حدسی یا شناسهٔ ساختگی بسازد؛ آزمون timeout، JSON نامعتبر و پایان سقف retry باید خطای امن و telemetry ثبت‌شده را بسنجد (Tasks 5, 6).
- فایل خراب، front matter نامعتبر، quota لب‌مرز و worker متوقف‌شده نباید سند را `ready` کند یا job را گم کند؛ آزمون recovery و idempotency برای ingestion لازم است (Tasks 3, 4).
- رابط فارسی در عرض‌های 320، 375 و 768 پیکسل، با صفحه‌کلید و بازشدن inspector منبع باید بدون overflow کار کند؛ آزمون مرورگر، نه فقط snapshot، این رفتار را بررسی کند (Task 8).

---

### Task 1: اسکلت سرویس‌ها، پیکربندی و قراردادهای دامنه

**Files:**
- Modify: `.env.example`, `.gitignore` (اکنون موجودند)
- Create: `apps/api/pyproject.toml`, `apps/api/app/config.py`, `apps/api/app/db.py`, `apps/api/app/domain/models.py`
- Create: `apps/api/app/main.py`, `apps/api/alembic.ini`, `apps/api/alembic/env.py`, `apps/api/alembic/versions/0001_initial.py`
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/app/layout.tsx`, `apps/web/app/globals.css`
- Test: `apps/api/tests/test_config.py`, `apps/api/tests/test_health.py`
- Create: `apps/api/uv.lock`
- Create: `apps/web/app/page.tsx`, `apps/web/package-lock.json`
- Modify: existing `README.md` only in Task 9
- Create: `apps/web/tests/` configuration and scripts for lint, typecheck, and browser tests

**Interfaces:**
- Produces: `Role = Literal['employee','manager']`; `Actor(user_id: UUID, role: Role, session_id: UUID)`; `SourceRef(document_id: str, section_id: str, revision: str)`; `ChunkRecord(chunk_id: UUID, document_id: str, revision: str, section_id: str, text: str, access_role: Role, ordinal: int)`; `RetrievalHit(chunk: ChunkRecord, lexical_rank: int|None, vector_rank: int|None, fused_score: float, rerank_score: float|None)`; `Claim(text: str, quote: str, source_refs: list[SourceRef])`; `ProviderUsage(provider: str, model: str, input_tokens: int|None, output_tokens: int|None, billed_units: dict[str, int|float|str], tariff: dict[str, Decimal]|None, cost: Decimal|None, currency: str|None)`; `AnswerResult(answer: str, claims: list[Claim], sources: list[SourceRef], abstained: bool, retrieval_hits: list[RetrievalHit], usage: list[ProviderUsage])`.
- Produces: `UploadInput(title: str, access_role: Role)` confirmed by the manager in the request; `ParsedSection(section_id: str|None, title: str, heading_path: list[str], text: str, ordinal: int)`; `ParsedDocument(seed_document_id: str|None, version: str, content_status: Literal['active','inactive'], sections: list[ParsedSection])`; `DocumentSummary(document_id: str, title: str, access_role: Role, version: str, content_status: str, processing_status: str, updated_at: datetime)`; `IngestionJob(job_id: UUID, document_id: str, revision: str, status: Literal['pending','indexing','ready','failed'], attempt: int, safe_error: str|None)`; `SectionView(ref: SourceRef, title: str, heading_path: list[str], text: str)`.
- Produces: `RetrievalConfig(lexical_top_k: int=20, vector_top_k: int=20, rrf_k: int=60, rerank_enabled: bool, rerank_top_k: int=20, final_top_k: int=5)`; `AnswerConfig(model: str, prompt_version: str, total_timeout_s: int=60, generation_timeout_s: int=30, retrieval: RetrievalConfig)`; provider protocols `embed_documents(texts) -> list[list[float]]`, `embed_query(text) -> list[float]`, `generate(messages, response_schema) -> GenerationResult`, `rerank(query, candidates) -> list[ScoredCandidate]`; `ScoredCandidate(chunk_id: UUID, score: float)` در همین قرارداد دامنه تعریف می‌شود.
- Produces: internal `AnswerResult` for services/evaluation only; public `AnswerResponse(answer: str, claims: list[Claim], sources: list[SourceRef], abstained: bool, request_id: UUID)`—never expose retrieval hits, usage details or raw chunks on the answer API.
- Produces: تنظیمات تایپ‌شده از env و اتصال SQLAlchemy؛ جداول `users`, `sessions`, `documents`, `ingestion_jobs`, `sections`, `chunks`, `request_runs`؛ health endpoint `GET /api/health`.
- Consumes: قواعد پایگاه‌داده از [DATABASE](../../DATABASE.md) و lifecycle از [ARCHITECTURE](../../ARCHITECTURE.md).

- [ ] **گام ۱: آزمون config و health ناموفق را اضافه کنید.** آزمون باید نام مدل پیش‌فرض، سقف‌ها، و پاسخ health را assert کند.
- [ ] **گام ۲: آزمون‌ها را اجرا کنید.** اجرا: `cd apps/api && uv run pytest tests/test_config.py tests/test_health.py -q`. انتظار: شکست به‌علت نبود config و health.
- [ ] **گام ۳: قراردادها، تنظیمات، مدل‌های ORM، مهاجرت اولیه و health را پیاده کنید.** جدول‌های سند، job و chunk باید revision و وضعیت پردازش مستقل را حفظ کنند؛ pgvector با ۷۶۸ بُعد و migration قابل‌اجرا تعریف شود.
- [ ] **گام ۴: وابستگی‌های lockشده را نصب و برنامه‌ها را روی میزبان اجرا کنید.** اجرا: `cd apps/api && uv sync --locked --group dev`; `cd apps/web && npm ci`; سپس در ترمینال‌های جدا `uv run uvicorn app.main:app --host 127.0.0.1 --port 8000` و `npm run dev`؛ بررسی اتصال به دیتابیس مستقل و `cd apps/api && uv run pytest tests/test_config.py tests/test_health.py -q`. انتظار: lockها جاری، پیکربندی معتبر، DB سالم، health برابر 200 و آزمون‌ها سبز.

### Task 2: ورود، نشست و proxy هم‌مبدأ

**Files:**
- Create: `apps/api/app/auth/service.py`, `apps/api/app/api/auth.py`, `apps/api/app/cli/seed_users.py`
- Create: `apps/api/tests/auth/test_sessions.py`, `apps/api/tests/auth/test_csrf_origin.py`
- Create: `apps/web/app/api/[...path]/route.ts`, `apps/web/lib/api.ts`
- Create: `apps/web/app/login/page.tsx`

**Interfaces:**
- Consumes: `Actor`, `Role` از Task 1.
- Produces: `resolve_actor(session_cookie: str | None) -> Actor | None`; APIهای `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`; Route Handler هم‌مبدأ که `/api` را بی‌تغییر به API عبور می‌دهد.
- ورود فقط حساب‌های seedشدهٔ employee/manager را می‌پذیرد؛ `Origin` درخواست POST باید با میزبان هم‌مبدأ برابر باشد و در نبود آن درخواست رد شود.

- [ ] **گام ۱: آزمون‌های رمز، انقضا، ابطال، کوکی و Origin را بنویسید.** بررسی کنید DB فقط hash نشست دارد، نقش از DB حل می‌شود و کاربر/کوکی منقضی رد می‌شود. بعد از تغییر نقش کاربر در DB، actor بعدی باید نقش تازه را بگیرد:

```python
assert resolve_actor(cookie).role == "employee"
db_user.role = "manager"
assert resolve_actor(cookie).role == "manager"
```
- [ ] **گام ۲: اجرا کنید.** `cd apps/api && uv run pytest tests/auth -q`. انتظار: شکست روی سرویس/routeهای احراز هویت.
- [ ] **گام ۳: سرویس نشست و routeها را پیاده کنید.** `pwdlib` با Argon2id، عمر ۸ ساعت، کوکی opaque با `HttpOnly; SameSite=Lax` و `Secure` در HTTPS؛ seed CLI فقط env را می‌خواند و هیچ secret چاپ نمی‌کند.
- [ ] **گام ۴: Route Handler و صفحهٔ ورود را طبق توکن‌های دقیق DESIGN_SYSTEM و مرجع Notion بسازید و آزمون‌ها را دوباره اجرا کنید.** انتظار: درخواست مرورگر به `/api/auth/me` از همان origin عبور کند و هیچ role قابل‌تنظیمی از payload پذیرفته نشود.

### Task 3: ثبت سند، jobهای پایدار و عملیات مدیر

**Files:**
- Create: `apps/api/app/documents/service.py`, `apps/api/app/api/manager.py`
- Create: `apps/api/tests/documents/test_upload_and_jobs.py`, `apps/api/tests/documents/test_replacement_cas.py`
- Modify: `apps/api/app/domain/models.py` برای `DocumentSummary`, `IngestionJob`, `SectionView`

**Interfaces:**
- Consumes: `Actor`, `SourceRef` و session/DB از Tasks 1–2.
- Produces: `stage_upload(actor: Actor, file: UploadFile, metadata: UploadInput) -> IngestionJob`; `process_next_job() -> bool`; `list_documents(actor: Actor) -> list[DocumentSummary]`; `read_section(actor: Actor, ref: SourceRef) -> SectionView`; `replace_document(actor: Actor, document_id: str, file: UploadFile, metadata: UploadInput) -> IngestionJob`; `delete_document(actor: Actor, document_id: str) -> None`.
- Routes: `/api/manager/documents`, `/api/manager/documents/{document_id}`, `/api/manager/jobs/{job_id}`؛ manager-only. وضعیت job: `pending`, `indexing`, `ready`, `failed`.

- [ ] **گام ۱: آزمون‌های manager-only، اندازه/پسوند، ۱۰۰ سند فعال، lease، retry و compare-and-swap را اضافه کنید.** در رقابت workerها فقط یک lease برنده شود؛ worker پس از از دست‌دادن lease نتواند commit کند؛ quota قطعه‌ها پیش از provider بررسی شود. اگر فراخوانی provider پیش از crash تکمیل شده باشد، retry worker ممکن است مصرف تکراری داشته باشد؛ تضمین exactly-once برای اثر بیرونی ندهید.
- [ ] **گام ۲: اجرا کنید.** `cd apps/api && uv run pytest tests/documents/test_upload_and_jobs.py tests/documents/test_replacement_cas.py -q`. انتظار: شکست روی lifecycle.
- [ ] **گام ۳: آپلود را در DB stage کنید و صف پایدار را پیاده کنید.** سقف ۱ MiB، فقط `.md`/`.txt`، lease ۱۲۰ ثانیه با تمدید ۳۰ثانیه‌ای، حداکثر ۳ تلاش؛ فایل خام روی filesystem ذخیره نشود.
- [ ] **گام ۴: جایگزینی و حذف فوری از دامنهٔ جست‌وجو را با CAS اعمال کنید.** اگر محتوای جدید آماده نشد، revision قبلی فقط وقتی دسترسی‌اش تغییر نکرده قابل استفاده بماند؛ محدودشدن دسترسی یا حذف فوراً نسخهٔ قبلی را نامجاز کند.
- [ ] **گام ۵: آزمون‌ها را سبز کنید.** انتظار: تکرار job idempotent باشد، worker منقضی قابل بازیابی باشد، و کارمند در فهرست مدیر حتی عنوان/status سند مدیریتی را نبیند.

### Task 4: parse، قطعه‌بندی و آماده‌سازی بردار

**Files:**
- Create: `apps/api/app/documents/parser.py`, `apps/api/app/documents/chunking.py`
- Create: `apps/api/app/providers/embedding.py`
- Create: `apps/api/tests/documents/test_parse_chunk_embed.py`
- Create: `apps/api/app/cli/provider_preflight.py`, `eval/dev-questions.jsonl`
- Create: `apps/api/app/cli/ingest_corpus.py`

**Interfaces:**
- Consumes: `process_next_job()` از Task 3؛ متن مبدأ و metadata تأییدشده.
- Produces: `parse_document(text: str) -> ParsedDocument`; `chunk_sections(document: ParsedDocument, *, document_id: str, revision: str, access_role: Role, max_chars: int = 1200, max_tokens: int = 400, overlap: int = 150) -> list[ChunkRecord]`; `EmbeddingProvider.embed_documents(texts: list[str]) -> list[list[float]]` با پیشوند `search_document: ` و `EmbeddingProvider.embed_query(text: str) -> list[float]` با پیشوند `search_query: `; `ingest_corpus(path: Path, actor: Actor) -> list[IngestionJob]` فقط برای import اپراتورمحور و حفظ IDهای `corpus-index.md`; provider در config قابل تعویض است. Upload جدید ID سروری می‌گیرد.

- [ ] **گام ۱: آزمون front matter، شناسهٔ پایدار بخش، فایل ناقص، تزریق دستور در متن، حدود طول/هم‌پوشانی و بُعد بردار را بنویسید.** `title` و `access_role` از `UploadInput` manager می‌آیند؛ metadata فایل نمی‌تواند این مقادیر یا مجوز را تعیین کند. متن سند هرگز دستور system را تغییر ندهد.
- [ ] **گام ۲: اجرا کنید.** `cd apps/api && uv run pytest tests/documents/test_parse_chunk_embed.py -q`. انتظار: شکست روی parse/chunk/provider.
- [ ] **گام ۳: parser و chunker قطعی را پیاده کنید.** هر قطعه به document revision و section پایدار متصل بماند؛ دادهٔ نامعتبر پیش از embedding رد شود.
- [ ] **گام ۴: Ollama embedding را با timeout ۱۰ ثانیه و retry policy مشترک بسازید.** `nomic-embed-text-v2-moe:latest`, پیشوند `search_document: ` یا `search_query: `، dimension 768، `truncate=false`؛ کنترل tokenizer منطبق و بودجهٔ 400 توکن با prefix؛ پاسخ با بُعد/شمار اشتباه باعث `failed` شود.
- [ ] **گام ۵: پیش از ingestion کامل و فراخوانی ابری، fixture توسعهٔ کوچکِ بدون هم‌پوشانی با معیار ثابت را بسازید و preflight provider را اجراپذیر کنید.** اجرا با کلیدهای محلی: `cd apps/api && uv run python -m app.cli.provider_preflight`; انتظار: Ollama بُعد ۷۶۸ و ورودی query/document را تأیید کند و OpenRouter پذیرش JSON Schema اجباری را با مدل انتخابی نشان دهد یا با خطای مشخص متوقف شود. برای query, document, rerank و generation هر adapter مصرف provider را به `ProviderUsage.billed_units`, tariff یا وضعیت ثبت‌نشدن و cost nullable وصل کند.
- [ ] **گام ۶: corpus ساختگی را وارد و persistence اتمی را کامل کنید.** اجرا: `cd apps/api && uv run python -m app.cli.ingest_corpus --path ../../corpus`; انتظار: IDهای ۲۰ سند و roleهای ثبت‌شده در `docs/corpus-index.md` حفظ شوند. sections/chunks/vectorها و تغییر job به `ready` اتمی باشند؛ شکست نباید index ناقص قابل جست‌وجو بسازد.

### Task 5: بازیابی مجاز واژگانی، برداری و رتبه‌بندی

**Files:**
- Create: `apps/api/app/retrieval/service.py`, `apps/api/app/retrieval/lexical.py`, `apps/api/app/retrieval/vector.py`, `apps/api/app/providers/reranking.py`
- Create: `apps/api/tests/retrieval/test_authorized_hybrid.py`, `apps/api/tests/retrieval/test_rerank_failures.py`

**Interfaces:**
- Consumes: `Actor`, `RetrievalHit`, `ChunkRecord`; embedding query از Task 4.
- Produces: `retrieve(actor: Actor, question: str, config: RetrievalConfig) -> list[RetrievalHit]`; query embedding با پیشوند `search_query: `; `rerank_hits(question: str, hits: list[RetrievalHit]) -> list[RetrievalHit]`.
- خط سیر ثابت: DB allowlist برای همان actor روی سند جاری/فعال/`ready`؛ `rank_bm25` روی همان قطعه‌های مجازِ بارگذاری‌شده برای هر درخواست؛ pgvector exact scan روی همان allowlist؛ top-20 برای هر مسیر؛ RRF `k=60`; rerank حداکثر ۲۰؛ خروجی حداکثر ۵. نرمال‌سازی فارسی فقط روی متن مشتق جست‌وجو (ي/ی، ك/ک، رقم‌های فارسی/عربی/لاتین، فاصله/نیم‌فاصله) انجام شود؛ متن منبع برای quote بدون تغییر بماند.

- [ ] **گام ۱: آزمون‌های مجوز پیش از lexical/vector، ترکیب RRF، حذف duplicate و مرز top-k را بنویسید.** با reranker جاسازی‌شده ثابت کنید هیچ سند مدیریتی به reranker نمی‌رسد:

```python
hits = retrieve(employee, "برنامه‌ریزی نیرو", config)
assert all(hit.chunk.access_role == "employee" for hit in captured_reranker_input)
assert all(not hit.chunk.document_id.startswith("MGR-") for hit in hits)
assert normalize_for_search("ي ك ۱۵ نیم‌فاصله") == normalize_for_search("ی ک 15 نیم فاصله")
assert source_text == original_source_text
```
- [ ] **گام ۲: اجرا کنید.** `cd apps/api && uv run pytest tests/retrieval -q`. انتظار: شکست روی retrieval pipeline.
- [ ] **گام ۳: retrieval را پیاده کنید.** BM25 فقط بر corpus مجاز همان درخواست ساخته شود؛ فیلتر پس از جست‌وجو به‌تنهایی کافی نیست.
- [ ] **گام ۴: Cohere `rerank-v4.0-fast` و سیاست شکست را اعمال کنید.** timeout ۱۰ ثانیه؛ شکست یا خطای provider پاسخ را متوقف کند، مگر `rerank_enabled=false` از ابتدا ثبت‌شده باشد؛ fallback بی‌صدا ممنوع.
- [ ] **گام ۵: آزمون‌ها را سبز کنید.** انتظار: ترتیب نهایی قابل‌بازتولید، unauthorized صفر، و telemetry شامل model/rank/retry بدون متن خام پرسش باشد. مصرف Ollama embedding و Cohere rerank اختیاری و OpenRouter generation به ProviderUsage/گزارش اجرای ارزیابی برسد؛ retrieval-hitها فقط در ساختار داخلی/ارزیابی بمانند.

### Task 6: پاسخ ساختاریافته، استناد و abstention امن

**Files:**
- Create: `apps/api/app/answer/service.py`, `apps/api/app/providers/generation.py`, `apps/api/app/answer/schemas.py`
- Create: `apps/api/tests/answer/test_grounding_and_recheck.py`, `apps/api/tests/answer/test_provider_retry.py`

**Interfaces:**
- Consumes: `retrieve(actor, question, config)` از Task 5؛ `SourceRef(document_id, section_id, revision)` و `ProviderUsage` از Task 1.
- Produces: `answer(actor: Actor, question: str, config: AnswerConfig) -> AnswerResult`; `GenerationResult(claims: list[Claim], abstained: bool, missing_parts: list[Literal['insufficient_evidence','ambiguous','conflict']], answer: str|None)`—متن آزاد `answer` هیچ‌وقت به کاربر نمایش داده نمی‌شود. `ValidatedClaims(claims: list[Claim])` و `InvalidGeneration(ValueError)` در `answer/schemas.py`؛ `validate_generation(payload, evidence) -> ValidatedClaims` همهٔ claims را یک‌جا می‌پذیرد/رد می‌کند؛ `compose_answer(claims, missing_parts, abstained) -> str` فقط وجود flag را مصرف می‌کند و متن نهایی را از claimهای تأییدشده و پیام خنثای ثابت می‌سازد.
- `POST /api/answers` در Task 7 به سرویس متصل می‌شود؛ سؤال حداکثر ۲۰۰۰ نویسه و حداکثر پنج منبع citation.

- [ ] **گام ۱: آزمون ادعاهای بدون منبع، quote نامنطبق، citation ناشناخته/غیرمجاز، نبود شواهد، پرسش مختلط، تعارض، تغییر role/revision پیش از تحویل، timeout و JSON خراب را بنویسید.** هر claim حداقل یک `SourceRef` از ورودی و quote عیناً منطبق با متن section دارد؛ یک claim نامعتبر کل payload را رد می‌کند:

```python
with pytest.raises(InvalidGeneration):
    validate_generation(payload_with_one_bad_claim, authorized_evidence)
```
- [ ] **گام ۲: اجرا کنید.** `cd apps/api && uv run pytest tests/answer -q`. انتظار: شکست روی generation و نهایی‌سازی.
- [ ] **گام ۳: OpenRouter adapter و prompt مرزبندی‌شده را پیاده کنید.** پیش‌فرض `google/gemini-2.5-flash`، model قابل‌پیکربندی؛ JSON Schema با `response_format` و `provider.require_parameters=true` اجباری باشد؛ فقط evidence ورودی مدل باشد؛ محتوا/دستور سند و سؤال نامطمئن تلقی شوند.
- [ ] **گام ۴: validate کردن claims/quotes/citations و abstention را پیاده کنید.** quote باید عیناً در متن chunkهای evidence ارسالی به مدل باشد؛ citation یا quote نامعتبر کل payload را رد کند و یک repair محدود در سقف کلی تلاش‌ها مجاز باشد. پس از repair ناموفق فقط abstention خنثی برگردد؛ حذف citation و نمایش claim بدون منبع مجاز نیست. متن آزاد مدل حتی با claims معتبر نادیده گرفته شود و پاسخ از claims تأییدشده و عبارت خنثی ثابت ساخته شود. `missing_parts` فقط enumهای `insufficient_evidence`, `ambiguous`, `conflict` دارد؛ آن‌ها فقط flag داخلی‌اند و متن‌های تولیدی مدل از آن‌ها استخراج یا نمایش داده نشود. بررسی نحوی، entailment معنایی را ثابت نمی‌کند. آزمون adversarial باید ثابت کند متن مستقل ساختگی مدل به خروجی راه نمی‌یابد.
- [ ] **گام ۵: پیش از برگرداندن AnswerResult revision و مجوز جاری را دوباره بخوانید.** تغییر پس از snapshot باعث رد پاسخ شود؛ سقف درخواست ۶۰ ثانیه، generation حداکثر دو تلاش مشترک با network retry/repair، و embedding/rerank جداگانه حداکثر دو تلاش با timeout ۱۰ ثانیه.
- [ ] **گام ۶: آزمون‌ها را سبز کنید.** آزمون adversarial: مدل متن پاسخ جعلی دارد اما یک claim درست و مستند می‌دهد؛ پاسخ نمایش‌داده‌شده باید فقط از claim ساخته شود و متن جعلی را نداشته باشد. انتظار: شناسهٔ بخش در مرجع کاربر بماند، `chunk_id` نمایش داده نشود و خطای provider متن حساس را افشا نکند.

### Task 7: APIهای پرسش، منبع و مدیریت

**Files:**
- Create: `apps/api/app/api/answers.py`, `apps/api/app/api/sources.py`, `apps/api/app/api/documents.py`
- Modify: `apps/api/app/api/manager.py`, `apps/api/app/main.py`
- Create: `apps/api/tests/api/test_role_boundaries.py`, `apps/api/tests/api/test_source_revision.py`

**Interfaces:**
- Consumes: auth dependencies از Task 2؛ document services از Task 3؛ `answer()` از Task 6.
- Produces: `GET /api/documents` فقط برای هر نقش، شامل سندهای فعال و ready مجاز؛ `POST /api/answers`; `GET /api/sources/{document_id}/sections/{section_id}?revision=...`; مدیر: `GET/POST /api/manager/documents`, `PUT/DELETE /api/manager/documents/{document_id}` و `GET /api/manager/jobs/{job_id}`. همهٔ responseها typed و خطاها بدون افشای وجود منبع ممنوع.

- [ ] **گام ۱: آزمون routeهای anonymous، employee و manager را بنویسید.** missing/forbidden source یک 404 عمومی یکسان بدهد؛ درخواست مدیر برای employee عنوان، ID، شمار یا وضعیت منبع ممنوع را لو ندهد؛ answer API فقط DTO عمومی داشته باشد:

```python
assert set(answer.json()) == {"answer", "claims", "sources", "abstained", "request_id"}
missing = client.get(source_url_for("absent", "X-S1", "r1"))
forbidden = client.get(source_url_for("MGR-002", "MGR-002-S1", "1"), as_employee=True)
stale = client.get(source_url_for("HR-001", "HR-001-S1", "old-revision"))
assert missing.status_code == forbidden.status_code == stale.status_code == 404
assert missing.json() == forbidden.json() == stale.json()
```
- [ ] **گام ۲: اجرا کنید.** `cd apps/api && uv run pytest tests/api -q`. انتظار: شکست روی endpointها.
- [ ] **گام ۳: routeها و validation را پیاده کنید.** مجوزها روی سرور enforce شوند؛ proxy مسیر `/api` را دوباره prefix نکند؛ source endpoint revision citation را بررسی کند.
- [ ] **گام ۴: آزمون‌ها را سبز کنید.** انتظار: پاسخ ترکیبی بخش عمومی را نگه دارد و بخش محدود را بدون تأیید/رد وجود آن حذف کند؛ دسترسی مستقیم به source غیرمجاز 404 یکسان باشد.

### Task 8: رابط فارسی RTL و تجربهٔ ارجاع

**Files:**
- Modify: minimal `apps/web/app/page.tsx` from Task 1
- Create: `apps/web/app/ask/page.tsx`, `apps/web/app/documents/page.tsx`
- Create: `apps/web/components/QuestionForm.tsx`, `apps/web/components/AnswerPanel.tsx`, `apps/web/components/SourceInspector.tsx`, `apps/web/components/SourceList.tsx`, `apps/web/components/ManagerDocuments.tsx`
- Modify: `apps/web/app/layout.tsx`, `apps/web/app/globals.css`
- Create: `apps/web/tests/` browser scenarios for auth, Q&A, manager upload and source inspector

**Interfaces:**
- Consumes: same-origin `/api/*` routes از Tasks 2 و 7.
- Produces: ورود، پرسش‌وپاسخ، کارت ادعا/ارجاع، inspector با `document_id/section_id/revision`، `SourceList` جداگانه برای منابع مجاز employee از `/api/documents` و `ManagerDocuments` فقط برای فهرست/آپلود/status اسناد مدیر.

- [ ] **گام ۱: browser scenarioها را برای keyboard flow، RTL و viewportهای 320/375/768px تعریف کنید.** سؤال، خطا، abstention و status قابل‌فهم فارسی باشند.
- [ ] **گام ۲: اجرا کنید.** `cd apps/web && npm run test:e2e`. انتظار: شکست تا ساخته‌شدن صفحه‌ها.
- [ ] **گام ۳: صفحه‌ها و کامپوننت‌ها را با توکن‌های دقیق DESIGN_SYSTEM و مرجع Notion بسازید.** role از پاسخ `/api/auth/me` گرفته شود؛ UI نقش را به درخواست‌ها اضافه یا از payload قابل‌دستکاری نکند.
- [ ] **گام ۴: آزمون مرورگر را اجرا و state رندرشده را بازبینی کنید.** انتظار: keyboard access به فرم و citation، no horizontal overflow در هر سه عرض، بازشدن/بسته‌شدن inspector و عدم نمایش کنترل مدیریت برای employee.

### Task 9: ارزیابی، گزارش و اجرای بازتولیدپذیر

**Files:**
- Create: `apps/api/app/evaluation/runner.py`, `apps/api/app/evaluation/metrics.py`, `apps/api/tests/evaluation/test_metrics.py`
- Create: `scripts/run-evaluation.sh`
- Modify: `.env.example`, existing `README.md`

**Interfaces:**
- Consumes: API/service contracts, `eval/questions.jsonl` معیار ثابت و `docs/evaluation-guide.md`.
- Produces: artifact اجرای JSON/Markdown شامل نسخه/hash corpus و معیار، شناسه/نسخهٔ مدل‌های generation/embedding/rerank، prompt و تنظیمات تولید، top-k و فیلتر مجوز، پاسخ و فهرست بازیابی با document/section/rank/score/مجوز، latency کل، usage و cost همهٔ تلاش‌ها، خطاها، limitationهای log و گزارش به تفکیک category و role.
- معیارها: Recall@5 روی زوج `(document_id, section_id)` برای نمونه‌های پاسخ‌پذیر، MRR همان زوج، پشتیبانی citation و abstention، نشت مشاهده‌شده، p50/p95 و هزینه با همهٔ retryها؛ بدون ادعای تضمین کیفیت.

- Produces: `recall_at_5(ranked_pairs: list[tuple[str,str]], gold_pairs: set[tuple[str,str]], eligible: bool=True) -> float|None`; `mrr(ranked_pairs: list[tuple[str,str]], gold_pairs: set[tuple[str,str]]) -> float`; abstain یا gold خالی برای Recall مقدار `None` دارد. جفت تکراری جایگاه MRR را اشغال می‌کند اما Recall آن را یک‌بار می‌شمارد.

- [ ] **گام ۱: آزمون metricها را با duplicate chunk، hit در rank، مورد abstain و مخرج صفر بنویسید.** توسعه فقط در `eval/dev-questions.jsonl` جدا و بدون overlap باشد؛ ۴۰ نمونهٔ ثابت برای تنظیم prompt/reranker به کار نرود:

```python
gold_pair = ("HR-001", "HR-001-S1")
other_pair = ("HR-003", "HR-003-S1")
assert recall_at_5([gold_pair, gold_pair], {gold_pair}) == 1.0
assert mrr([other_pair, gold_pair], {gold_pair}) == 0.5
assert recall_at_5([], set(), eligible=False) is None
```
- [ ] **گام ۲: اجرا کنید.** `cd apps/api && uv run pytest tests/evaluation/test_metrics.py -q`. انتظار: شکست تا runner/metricها اضافه شوند.
- [ ] **گام ۳: runner آفلاین و artifact گزارش را پیاده کنید.** CLI با `--dataset`, `--mode vector|hybrid|hybrid_rerank`, `--output` بسازید؛ سه حالت در اجراهای جدا ثبت شوند. هر تلاش ناموفق و هزینه‌دار، شمار درخواست‌های آغازشده و موفق، محدودیت log و خطای هر نمونه ثبت شود؛ کل متن اسناد/پرسش در log عملیاتی چاپ نشود.
- [ ] **گام ۴: مسیر اجرای محلی و handoff را در README مستند کنید.** اجرای Next/FastAPI روی میزبان، migration فقط دیتابیس مستقل پروژه، seed دو حساب از env، بارگذاری corpus، health، اجرای dev/eval با نمونهٔ `cd apps/api && uv run python -m app.evaluation.runner --dataset ../../eval/dev-questions.jsonl --mode hybrid --output ../../runs/dev-hybrid.json`, و توقف سرویس‌ها با نتایج مورد انتظار شرح داده شوند؛ secretها فقط در `.env` ignored بمانند.
- [ ] **گام ۵: کل بررسی‌ها را اجرا کنید.** `cd apps/api && uv run pytest -q`, `cd apps/web && npm run lint && npm run typecheck && npm run build && npm run test:e2e`, سپس بررسی اتصال به سرویس‌های موجود و اجرای تولیدی Next/FastAPI روی میزبان. انتظار: همهٔ آزمون‌ها سبز، build تولیدی موفق، سرویس‌ها ready و browser scenarios در ابعاد هدف موفق.
- [ ] **گام ۶: بازبینی نهایی و گزارش تغییرات را آماده کنید.** چون repository هنوز Git ندارد، init/commit فقط پس از اجازهٔ کاربر؛ تا آن زمان فایل‌های محدودهٔ پروژه را برای بازبینی فهرست کنید.
