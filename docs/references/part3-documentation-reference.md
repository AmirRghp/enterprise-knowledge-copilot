# منبع ساختار مستندات تکمیلی

بررسی‌شده در ۲۰۲۶-۱۰-۲۱ از tab t.0 سند [THE VIBE CODING BLUEPRINT](https://docs.google.com/document/d/14GR5EhXGuyX7xRea52ZP3h5vQEP2Egcwvx_SusGWkCc/edit?tab=t.0#heading=h.t3puhqvuwu65)، بخش PART 3 — THE ADVANCED DOCUMENTATION LAYER.

منبع، الگوی ساختار است؛ کد و اسناد محلی مرجع رفتار محصول‌اند. نمونهٔ عمومی آن برای ثبت‌نام، DATABASE_URL و قالب یکسان خطا، قرارداد این پروژه نیست. دسترسی خواندن این سند توسط ابزار، اتصال Google Drive در محصول را اثبات نمی‌کند.

| سند پیشنهادی منبع | محل در پروژه | مالکیت |
|---|---|---|
| UX_FLOWS | [UX_FLOWS.md](../UX_FLOWS.md) | جریان و حالت‌های رابط |
| API | [API.md](../API.md) | مسیر، درخواست، پاسخ و سازگاری |
| ENVIRONMENT | [ENVIRONMENT.md](../ENVIRONMENT.md) | تنظیمات فعلی و مرز secret |
| DECISIONS | [DECISIONS.md](../DECISIONS.md) | دلیل انتخاب‌ها و تصمیم باز |
| ROADMAP | [ROADMAP.md](../ROADMAP.md) | اولویت‌ها؛ جزئیات فقط plans |
| ERROR_HANDLING | [ERROR_HANDLING.md](../ERROR_HANDLING.md) | خطا، retry و رفتار شکست |
| OBSERVABILITY | [OBSERVABILITY.md](../OBSERVABILITY.md) | دادهٔ مجاز برای log/metric و evidence |
| DEPLOYMENT | [DEPLOYMENT.md](../DEPLOYMENT.md) | نصب، ارتقا، بازیابی و مرزهای عملیاتی |
| CHANGELOG | [CHANGELOG.md](../CHANGELOG.md) | مدخل کشف تاریخچه؛ SHA و وضعیت در plans |

## منابع فنی برای تصمیم‌های جدید

- [GitHub community profile](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories): فایل‌های مجوز، راهنمای مشارکت و گزارش امنیت.
- [OCRmyPDF performance](https://ocrmypdf.readthedocs.io/en/stable/performance.html): هزینه برحسب پیکسل و concurrency است؛ اندازهٔ PDF سقف کافی حافظه نیست.
- [OCRmyPDF processing modes](https://ocrmypdf.readthedocs.io/en/latest/advanced.html): صفحات دارای متن می‌توانند از OCR عبور نکنند.
- [Tesseract language data](https://tesseract-ocr.github.io/tessdoc/Data-Files.html): مدل فارسی fas موجود است؛ وجود مدل نتیجهٔ کیفیت فارسی نیست.
- [vLLM API](https://docs.vllm.ai/en/stable/serving/online_serving/openai_compatible_server/): API سازگار، با تفاوت قابلیت و نیاز به حفاظت شبکه.
- [SGLang API benchmark guide](https://docs.sglang.ai/developer_guide/bench_serving): مسیرهای سازگار و شیوهٔ سنجش سرور مدل.
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html): احراز هویت و اعتبارسنجی ID token؛ پیاده‌سازی نیازمند قرارداد issuer و کتابخانهٔ منتخب است.
- [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph): برای workflow پایدار و چندمرحله‌ای نامزد است؛ در مسیر فعلی وابستگی لازم نیست.
- [Dify](https://github.com/langgenius/dify)، [RAGFlow](https://github.com/infiniflow/ragflow)، [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)، [Onyx](https://github.com/onyx-dot-app/onyx): مطالعهٔ قابلیت/تجربه؛ نسخه‌های تجاری و مجوزها عیناً به این پروژه تعمیم داده نشوند.

این صفحه متن template را تکثیر نمی‌کند و نسخهٔ خصوصی سند مرجع را در مخزن ذخیره نمی‌کند. API یا نسخهٔ ابزار منتخب هنگام پیاده‌سازی دوباره از منبع رسمی همان نسخه بررسی شود.
