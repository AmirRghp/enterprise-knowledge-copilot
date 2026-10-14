# مرجع فنی قراردادها و مثال‌های پروژه

> **کاربرد:** این سند مرجع فنی قراردادها و مثال‌هاست، نه برنامهٔ اجرا. ترتیب کار و وضعیت انتشار فقط در [برنامهٔ مرحله‌ای](plans.md) ثبت می‌شوند.

**Goal:** ساخت یک نمونهٔ اولیهٔ فارسی برای پرسش‌وپاسخ مستند سازمانی با دو نقش، مدیریت چرخهٔ عمر سند، بازیابی ترکیبی و ارزیابی قابل‌بازتولید.

**Architecture:** رابط Next.js همهٔ درخواست‌های same-origin را از Route Handler به FastAPI عبور می‌دهد؛ API در هر درخواست نقش را از نشست پایگاه‌داده‌ای حل می‌کند. PostgreSQL و pgvector تنها پایگاه‌داده‌اند و API یک worker تک‌فرایندی برای صف ingestion دارد. retrieval فقط در دامنهٔ اسناد مجاز انجام می‌شود، BM25 و جست‌وجوی برداری را با RRF ادغام می‌کند و زنجیره‌های provider برای chat و rerank از DB پیکربندی می‌شوند. جزئیات رفتار provider پیش از Part 20 سابقهٔ طراحی/اجرا هستند.

**Tech Stack:** Next.js، TypeScript، Python 3.12، FastAPI، SQLAlchemy، Alembic، PostgreSQL و pgvector؛ `rank_bm25` برای BM25 درون‌حافظه‌ایِ هر درخواست؛ embedding انتخابی از OpenAI، OpenRouter یا Ollama با مدل واردشدهٔ مدیر؛ پیشوندهای Nomic فقط برای همان مدل، OpenRouter rerank با `nvidia/llama-nemotron-rerank-vl-1b-v2:free` (اختیاری و خاموش)، و OpenRouter generation با `google/gemini-2.5-flash` قابل‌پیکربندی.

**Spec:** سندهای جاری در `docs/` مرجع‌اند؛ جزئیات محصول در [PRD](../PRD.md)، [معماری](../ARCHITECTURE.md)، [داده](../DATABASE.md)، [امنیت](../SECURITY.md)، [نظام طراحی](../DESIGN_SYSTEM.md)، [شیوهٔ کدنویسی](../CODE_STYLE.md)، [راهبرد آزمون](../TESTING.md) و [راهنمای ارزیابی](../evaluation-guide.md) ثبت شده‌اند. معیار ثابت: [eval/questions.jsonl](../../eval/questions.jsonl).

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

## قراردادهای پایدار

- نقش از نشست معتبر سمت سرور می‌آید؛ ورودی UI، پرسش یا ادعای کاربر مجوز را تغییر نمی‌دهد. setup فقط برای پایگاه بدون کاربر باز است و مدیرها حساب‌های بعدی را مدیریت می‌کنند.
- کوکی نشست opaque و `HttpOnly; SameSite=Lax` است، در HTTPS صفت `Secure` دارد و حداکثر ۸ ساعت اعتبار دارد؛ DB فقط hash نشست و گذرواژه را نگه می‌دارد.
- بارگذاری مدیر فقط `.md` و `.txt` تا سقف ۱ MiB می‌پذیرد. حد پرسش ۲۰۰۰ نویسه و سقف جاری ۲۰۰۰ قطعه است. قرارداد دقیق‌تر در [PRD](../PRD.md)، [معماری](../ARCHITECTURE.md) و [پایگاه‌داده](../DATABASE.md) آمده است.
- قطعه حداکثر ۱۲۰۰ نویسه و ۴۰۰ واحد شمارش مدل، با هم‌پوشانی حداکثر ۱۵۰ نویسه دارد. ورودی embedding بلند با `truncate=false` رد می‌شود. بُعد بردار را اتصال فعال تعیین می‌کند؛ پیشوندهای Nomic فقط برای مدل مربوط اعمال می‌شوند.
- ارجاع پایدار از `document_id + section_id + revision` ساخته می‌شود؛ `chunk_id` به کاربر نشان داده نمی‌شود. فقط سند فعال، جاری، آماده و مجاز وارد retrieval می‌شود و دسترسی در هر مرز ارسال/نمایش دوباره بررسی می‌شود.
- بازیابی lexical و vector با RRF ادغام می‌شود؛ rerank اختیاری و پیش‌فرض خاموش است. جزئیات اجرایی و محدودیت provider در [معماری](../ARCHITECTURE.md) و [راهبرد آزمون](../TESTING.md) آمده است.
- خطای transport، key، model یا schema فقط طبق زنجیرهٔ تنظیم‌شده می‌تواند fallback کند؛ خطاهای authorization، evidence، citation و digest terminal هستند. بدون شاهد معتبر پاسخ ساخته نمی‌شود.
- گفت‌وگو در همان صفحه موقت است؛ پنج نوبت پیشین فقط همراه ارجاع‌های معتبرشان به زمینه می‌روند. نقل‌قول‌های پذیرفته‌شده از متن passage برداشته می‌شوند و بررسی quote جای بازبینی معنایی استناد را نمی‌گیرد.
- ارزیابی روی مجموعهٔ ثابت ۴۰تایی گزارش می‌شود؛ سؤال‌های توسعه باید fixture جدا داشته باشند. پرسش، prompt، متن سند و راز provider در log عادی ثبت نمی‌شوند.
- روش‌های اجرای native و Compose در [README](../../README.md)، schema در [DATABASE](../DATABASE.md)، و وضعیت انتشار در [برنامه](plans.md) مرجع‌اند.

## Review Focus

- تلاش کارمند برای کشف یا استنتاج سند مدیریتی باید پیش از retrieval حذف شود؛ آزمون API باید نبود شناسه/عنوان/تعداد سند مدیریتی را در نتیجه، source، خطا و log قابل‌مشاهده بررسی کند (موضوع‌های فنی ۲، ۵ و ۷).
- محدودشدن نقش، حذف سند یا جایگزینی revision هم‌زمان با generation نباید پاسخ یا بخش قدیمی را تحویل دهد؛ آزمون تغییر مجوز میان retrieval و final recheck باید پاسخ را رد کند (موضوع‌های فنی ۳ و ۶).
- خطا یا timeout در Ollama، OpenRouter rerank اختیاری یا OpenRouter generation نباید پاسخ حدسی یا شناسهٔ ساختگی بسازد؛ آزمون timeout، پاسخ rerank نامعتبر، JSON نامعتبر و پایان سقف retry باید خطای امن و telemetry ثبت‌شده را بسنجد (موضوع‌های فنی ۵ و ۶).
- فایل خراب، front matter نامعتبر، quota لب‌مرز و worker متوقف‌شده نباید سند را `ready` کند یا job را گم کند؛ آزمون recovery و idempotency برای ingestion لازم است (موضوع‌های فنی ۳ و ۴).
- رابط فارسی در عرض‌های 320، 375 و 768 پیکسل، با صفحه‌کلید و بازشدن inspector منبع باید بدون overflow کار کند؛ آزمون مرورگر، نه فقط snapshot، این رفتار را بررسی کند (موضوع فنی ۸).

---

### موضوع فنی 1: اسکلت سرویس‌ها، پیکربندی و قراردادهای دامنه

**قرارداد پیکربندی provider:** تنظیم DB از محیط می‌ماند، اما providerها از جداول versioned/locked `provider_configs` و `provider_chains` خوانده می‌شوند. کلیدها با Fernet و `APP_ENCRYPTION_KEY` رمز می‌شوند؛ نصب تازه provider ندارد و env خودکار import نمی‌شود. Chat از Ollama/OpenAI/compatible/OpenRouter پشتیبانی می‌کند؛ rerank فقط OpenRouter یا compatible روی `/rerank`؛ embedding از OpenAI/OpenRouter/Ollama با مدل واردشدهٔ مدیر پشتیبانی می‌شود و اتصال فعال بُعد را تعیین می‌کند. API، worker، CLI و eval تنظیم مشترک را بدون restart می‌خوانند. هر درخواست API بودجهٔ سراسری ۶۰ ثانیه دارد و deadline واقعی باقی‌مانده بین تلاش‌های هر زنجیره اعمال می‌شود. refusalهای سیاستی مانند `finish_reason=content_filter` یا `message.refusal` terminal هستند و fallback نمی‌شوند. پیکربندی URL ممنوع، DNS غیرمجاز و redirect نیز terminal است. پایان retryهای embedding می‌تواند به اتصال سازگار بعدی برود؛ timeout خام ingestion job را pending می‌کند و گزارش‌های provider usage آن تلاش را نگه می‌دارند. مصرف هر تلاش در `provider_usage` ثبت می‌شود؛ currencyهای متفاوت providerها با هم جمع نمی‌شوند.

**پارامتر chat:** Migration `0004` به `provider_configs` ستون nullable `temperature` افزوده است. فقط اتصال‌های chat مقدار finite بین ۰ تا ۲ می‌پذیرند؛ پیش‌فرض و backfill `0.7` است، و purposeهای دیگر باید `NULL` بمانند. مقدار ذخیره‌شده از snapshot runtime به adapter تولید می‌رسد و در API، CLI، probe، retry و repair یکسان استفاده می‌شود؛ eval metadata نیز آن را ثبت می‌کند. کلاینتی که فیلد را نفرستد مقدار فعلی را حفظ می‌کند. پارامتر پشتیبانی‌نشده حذف نمی‌شود و خطا از قواعد type/fallback جاری پیروی می‌کند. migration روی DBهای برنامه و آزمون اعمال شده است.

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
- Upload accepts `.md`, `.txt`, `.pdf`, `.docx`, `.xlsx` and `.xls` up to 1 MiB. `extract_document(filename: str, raw: bytes, *, max_bytes: int) -> str` validates/extracts office formats before the existing text staging path; it stores no original binary. Excel includes hidden sheets and uses cached values without formula execution. Pasted text is sent as a browser-created Markdown file; API and schema are unchanged.
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

### موضوع فنی 10: کتابخانهٔ system prompt مدیر

- قراردادهای API: `GET/POST /api/manager/system-prompts`، `PUT /api/manager/system-prompts/{id}` و `POST /api/manager/system-prompts/{id}/activate`؛ دسترسی فقط برای مدیر و از proxy هم‌مبدأ.
- prompt پیش‌فرض در migration `0009` seed می‌شود و قابل ویرایش نیست. prompt سفارشی نام و متن غیرخالی تا ۱۶٬۰۰۰ نویسه دارد؛ prompt تازه غیرفعال می‌ماند و فقط سازنده اجازهٔ ویرایش دارد.
- تنظیم فعال یک ردیف singleton برای هر نصب است. قفل ردیف و `version` جابه‌جایی فعال را اتمی می‌کنند؛ `revision` ویرایش کهنه را رد می‌کند. downgrade با وجود prompt سفارشی خطا می‌دهد.
- generation همیشه هستهٔ ثابت را نگه می‌دارد و متن فعال را فقط به‌عنوان دستور تکمیلی می‌افزاید. نبود پیکربندی پیش از provider خطا می‌دهد. گزارش ارزیابی hash prompt مؤثر را نگه می‌دارد، نه متن آن.

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
