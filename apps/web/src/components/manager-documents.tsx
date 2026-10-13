"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type DocumentSummary = {
  document_id: string;
  title: string;
  access_role: string;
  version: string;
  content_status: string;
  processing_status: string;
  // Whether an indexed revision exists right now. Independent of the latest job: a
  // pending or failed replacement leaves the published revision in place, and the
  // declared version cannot stand in for this because a file may claim it.
  has_published_revision: boolean;
  updated_at: string;
  job_id?: string | null;
  safe_error?: string | null;
};
type Job = { job_id: string; status: string; safe_error: string | null };
type Request = (
  path: string,
  options?: RequestInit,
) => Promise<{ job_id?: string; status?: string; safe_error?: string | null }>;

const statuses: Record<string, string> = {
  pending: "در صف پردازش",
  indexing: "در حال پردازش",
  ready: "آماده",
  failed: "پردازش ناموفق",
  active: "فعال",
  inactive: "حذف‌شده",
};
const errors: Record<string, string> = {
  "document could not be parsed": "ساختار فایل را بررسی و نسخهٔ اصلاح‌شده را بارگذاری کنید.",
  "document could not be chunked":
    "متن و بخش‌بندی فایل را بررسی و نسخهٔ اصلاح‌شده را بارگذاری کنید.",
  "current chunk quota exceeded": "ظرفیت قطعه‌های سامانه پر شده است. با مسئول سامانه تماس بگیرید.",
  "embedding provider unavailable":
    "سرویس پردازش در دسترس نیست. پس از برقراری سرویس، دوباره بارگذاری کنید.",
  "embedding provider refused the request":
    "سرویس پردازش فایل را نپذیرفت. تنظیمات سرویس باید توسط مسئول سامانه بررسی شود.",
  "embedding vector rejected": "خروجی سرویس پردازش معتبر نیست. با مسئول سامانه تماس بگیرید.",
  "embedding model digest changed":
    "مدل پردازش تغییر کرده است. مسئول سامانه باید نسخهٔ مدل و نمایه را بررسی کند.",
  "tokenizer unavailable":
    "ابزار بخش‌بندی متن در دسترس نیست. پس از رفع مشکل توسط مسئول سامانه، دوباره بارگذاری کنید.",
  "activation rejected; current revision changed":
    "نسخهٔ سند هنگام پردازش تغییر کرده است. فهرست را تازه‌سازی و نسخهٔ جاری را بررسی کنید.",
  "lease lost to another worker":
    "پردازش به کارگر دیگری واگذار شد. برای دریافت وضعیت تازه منتظر بمانید.",
  "document was deleted": "سند پیش از پایان پردازش حذف شد.",
};
const errorMessage = (code?: string | null) =>
  errors[code ?? ""] ??
  "پردازش کامل نشد. با مسئول سامانه تماس بگیرید و پس از رفع مشکل دوباره بارگذاری کنید.";

const MAX_FILE_BYTES = 1024 * 1024;
const ACCEPTED_SUFFIX = /\.(md|txt)$/i;
// The same ceiling the upload form and the API both enforce, checked here so an
// oversized or wrongly named file is refused before it is sent.
const readFile = (data: FormData): File | null => {
  const file = data.get("file");
  if (!(file instanceof File) || !file.size || file.size > MAX_FILE_BYTES) return null;
  return ACCEPTED_SUFFIX.test(file.name) ? file : null;
};

function DocumentActions({
  doc,
  request,
  onChanged,
}: {
  doc: DocumentSummary;
  request: Request;
  onChanged: () => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restricting, setRestricting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const deleted = doc.content_status === "inactive";
  // A replacement is refused while any job for this document is in flight, so the
  // control is disabled rather than letting the request come back as a conflict.
  const inFlight = doc.processing_status === "pending" || doc.processing_status === "indexing";
  const locked = deleted || inFlight || busy;

  async function replace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    const data = new FormData(event.currentTarget);
    if (!readFile(data)) {
      setProblem("یک فایل md یا txt غیرخالی، حداکثر ۱ مگابایت انتخاب کنید.");
      return;
    }
    setBusy(true);
    setNote("");
    setProblem("");
    try {
      await request(`/api/manager/documents/${encodeURIComponent(doc.document_id)}`, {
        method: "PUT",
        body: data,
      });
      setNote("نسخهٔ تازه ثبت شد. نسخهٔ کنونی تا پایان پردازش در دسترس می‌ماند.");
      formRef.current?.reset();
      await onChanged();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "جایگزینی نسخه ممکن نشد.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (locked) return;
    setBusy(true);
    setNote("");
    setProblem("");
    try {
      await request(`/api/manager/documents/${encodeURIComponent(doc.document_id)}`, {
        method: "DELETE",
      });
      setNote("سند حذف شد و دیگر در پاسخ‌ها ظاهر نمی‌شود.");
      setConfirming(false);
      await onChanged();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "حذف سند ممکن نشد.");
    } finally {
      setBusy(false);
    }
  }

  async function restrictAccess() {
    if (deleted || busy || doc.access_role !== "employee") return;
    setBusy(true);
    setNote("");
    setProblem("");
    try {
      await request(`/api/manager/documents/${encodeURIComponent(doc.document_id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_role: "manager" }),
      });
      setNote("دسترسی سند به مدیران محدود شد.");
      setRestricting(false);
      await onChanged();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "محدود کردن دسترسی ممکن نشد.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="document-actions">
      <p className="field-help">
        {deleted
          ? doc.has_published_revision
            ? "این سند حذف شده و نسخهٔ جاری آن نمایه شده است."
            : "این سند حذف شده و هرگز نسخه‌ای منتشر نکرد، پس چیزی برای بازیابی باقی نمانده است."
          : inFlight
            ? "یک پردازش برای این سند در جریان است؛ تا پایان آن نمی‌توان نسخه‌ای تازه ثبت کرد."
            : "جایگزینی نسخه، متن تازه را پس از پردازش جایگزین می‌کند و نسخهٔ کنونی تا آن زمان در دسترس می‌ماند."}
      </p>
      {!deleted && (
        <details className="document-replace">
          <summary>جایگزینی نسخه</summary>
          {/*
            The fields are uncontrolled so a manager's own edit survives the five
            second poll, but `defaultValue` is only read on mount. Keying on the
            server's value remounts them exactly when that value really changed, so a
            replacement that has been applied shows its new role and title, while an
            edit is kept whenever the document itself did not change.
          */}
          <form className="login-form" ref={formRef} onSubmit={replace} aria-busy={busy}>
            <div className="form-field">
              <label htmlFor={`replace-title-${doc.document_id}`}>عنوان تازه</label>
              <input
                key={`title-${doc.title}`}
                id={`replace-title-${doc.document_id}`}
                name="title"
                required
                maxLength={300}
                defaultValue={doc.title}
                disabled={locked}
              />
            </div>
            <div className="form-field">
              <label htmlFor={`replace-role-${doc.document_id}`}>سطح دسترسی تازه</label>
              <select
                key={`role-${doc.access_role}`}
                id={`replace-role-${doc.document_id}`}
                name="access_role"
                defaultValue={doc.access_role}
                disabled={locked}
              >
                <option value="manager">فقط مدیران</option>
                <option value="employee">کارمندان و مدیران</option>
              </select>
              <p className="field-help">
                باریک‌تر کردن دسترسی همین حالا اعمال می‌شود؛ گسترده‌تر کردن آن پس از آماده شدن نسخهٔ
                تازه.
              </p>
            </div>
            <div className="form-field">
              <label htmlFor={`replace-file-${doc.document_id}`}>فایل نسخهٔ تازه</label>
              <input
                id={`replace-file-${doc.document_id}`}
                name="file"
                type="file"
                accept=".md,.txt"
                required
                disabled={locked}
              />
            </div>
            <button type="submit" className="button button-primary" disabled={locked}>
              ثبت نسخهٔ تازه
            </button>
          </form>
        </details>
      )}
      {!deleted &&
        doc.access_role === "employee" &&
        (restricting ? (
          <div className="document-confirm" role="group" aria-label="تأیید محدودسازی دسترسی">
            <p>از این لحظه فقط مدیران می‌توانند این سند را در پاسخ‌ها ببینند.</p>
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => void restrictAccess()}
            >
              تأیید محدودسازی
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => setRestricting(false)}
            >
              انصراف
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => setRestricting(true)}
          >
            محدود کردن دسترسی به مدیران
          </button>
        ))}
      {!deleted &&
        (confirming ? (
          <div className="document-confirm" role="alert">
            <p>
              حذف سند آن را از پاسخ‌ها خارج می‌کند. نسخهٔ نمایه‌شده حذف نمی‌شود، اما دیگر در دسترس
              نیست.
            </p>
            <button
              type="button"
              className="button button-primary"
              onClick={() => void remove()}
              disabled={busy}
            >
              بله، حذف کن
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              انصراف
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setConfirming(true)}
            disabled={locked}
          >
            حذف سند
          </button>
        ))}
      {note && (
        <p role="status" className="field-help">
          {note}
        </p>
      )}
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
    </div>
  );
}

export function ManagerDocuments() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const refreshing = useRef(false);
  const denied = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const request = useCallback(
    async (path: string, options?: RequestInit) => {
      if (denied.current) throw new Error("دسترسی به این صفحه مجاز نیست.");
      const response = await fetch(path, {
        ...options,
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 401) {
        denied.current = true;
        setDocuments(null);
        setJob(null);
        router.replace("/login");
        throw new Error("نشست شما پایان یافته است. دوباره وارد شوید.");
      }
      if (response.status === 403) {
        denied.current = true;
        setDocuments(null);
        setJob(null);
        router.replace("/");
        throw new Error("دسترسی به این صفحه مجاز نیست.");
      }
      if (response.status === 503)
        throw new Error("ابتدا اتصال embedding را در صفحهٔ ارائه‌دهندگان آزمایش و فعال کنید.");
      if (response.status === 409)
        throw new Error(
          "پردازش سند یا بازسازی مدل embedding در جریان است. پس از پایان دوباره تلاش کنید.",
        );
      if (response.status === 400 || response.status === 413 || response.status === 422)
        throw new Error(
          "فایل UTF-8 با پسوند md یا txt، حداکثر ۱ مگابایت و عنوان معتبر بارگذاری کنید. اگر مشکل ادامه دارد، ظرفیت سامانه را با مسئول آن بررسی کنید.",
        );
      if (!response.ok) throw new Error("ارتباط با سرویس برقرار نشد. دوباره امتحان کنید.");
      // A delete answers 204 with no body, so there is nothing to parse.
      if (response.status === 204) return {};
      const data = await response.json();
      if (denied.current) throw new Error("دسترسی به این صفحه مجاز نیست.");
      return data;
    },
    [router],
  );
  const refresh = useCallback(async () => {
    if (refreshing.current || denied.current) return;
    refreshing.current = true;
    try {
      const data = await request("/api/manager/documents");
      if (denied.current) return;
      setDocuments(data.documents);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "دریافت فهرست ممکن نشد.");
    } finally {
      refreshing.current = false;
    }
  }, [request]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await refresh();
      if (!stopped && !denied.current) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh]);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const data = new FormData(event.currentTarget);
    if (!readFile(data)) {
      setUploadError("یک فایل md یا txt غیرخالی، حداکثر ۱ مگابایت انتخاب کنید.");
      return;
    }
    busy.current = true;
    setPending(true);
    setUploadError("");
    try {
      const uploaded = await request("/api/manager/documents", { method: "POST", body: data });
      if (denied.current) return;
      setJob(uploaded);
      formRef.current?.reset();
      await refresh();
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : "بارگذاری ممکن نشد.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const latest = documents?.find((document) => document.job_id === job?.job_id);
  const jobStatus = latest?.processing_status ?? job?.status;
  const jobError = latest?.safe_error ?? job?.safe_error;
  return (
    <section aria-labelledby="page-title">
      <p className="eyebrow">منابع دانش سازمانی</p>
      <h1 id="page-title">مدیریت اسناد</h1>
      <p className="welcome-description">
        سند تازه بارگذاری کنید، نسخهٔ هر سند را جایگزین یا حذف کنید و وضعیت آماده‌شدن نمایهٔ آن را
        ببینید.
      </p>
      <section className="manager-upload" aria-labelledby="upload-title">
        <h2 id="upload-title">بارگذاری سند تازه</h2>
        <form className="login-form" ref={formRef} onSubmit={upload} aria-busy={pending}>
          <div className="form-field">
            <label htmlFor="document-title">عنوان سند</label>
            <input id="document-title" name="title" required maxLength={300} disabled={pending} />
          </div>
          <div className="form-field">
            <label htmlFor="access-role">سطح دسترسی</label>
            <select id="access-role" name="access_role" defaultValue="manager" disabled={pending}>
              <option value="manager">فقط مدیران</option>
              <option value="employee">کارمندان و مدیران</option>
            </select>
            <p className="field-help">
              دسترسی بر اساس انتخاب شما تعیین می‌شود؛ اطلاعات داخل فایل آن را تغییر نمی‌دهد.
            </p>
          </div>
          <div className="form-field">
            <label htmlFor="document-file">فایل سند</label>
            <input
              id="document-file"
              name="file"
              type="file"
              accept=".md,.txt"
              required
              disabled={pending}
              aria-describedby="file-help"
            />
            <p id="file-help" className="field-help">
              Markdown یا متن ساده، UTF-8، حداکثر ۱ مگابایت.
            </p>
          </div>
          <button type="submit" className="button button-primary" disabled={pending}>
            بارگذاری سند
          </button>
          <p role="status" className="field-help">
            {pending
              ? "در حال ارسال فایل…"
              : job
                ? `فایل ثبت شد · ${statuses[jobStatus ?? ""] ?? "وضعیت نامشخص"}`
                : ""}
          </p>
          {jobStatus === "failed" && (
            <p role="alert" className="form-error">
              {errorMessage(jobError)}
            </p>
          )}
          {uploadError && (
            <p role="alert" className="form-error">
              {uploadError}
            </p>
          )}
        </form>
      </section>
      <section className="guide-section" aria-labelledby="documents-title">
        <div className="manager-list-heading">
          <h2 id="documents-title">فهرست اسناد</h2>
          <button className="button button-secondary" type="button" onClick={() => void refresh()}>
            تازه‌سازی
          </button>
        </div>
        <p className="section-description">وضعیت‌ها هر ۵ ثانیه تازه می‌شوند.</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {documents === null && !error && <p role="status">در حال دریافت اسناد…</p>}
        {documents?.length === 0 && (
          <p className="manager-empty" role="status">
            هنوز سندی ثبت نشده است. اولین سند را از فرم بالا بارگذاری کنید.
          </p>
        )}
        <ul className="document-list">
          {documents?.map((doc) => (
            <li key={doc.document_id} className="document-row">
              <div>
                {/* h2 rather than h3: it follows this page's h1 directly. */}
                <h2>{doc.title}</h2>
                <p className="field-help">
                  {doc.access_role === "manager" ? "فقط مدیران" : "کارمندان و مدیران"} · نسخه:{" "}
                  <bdi>{doc.version === "unpublished" ? "منتشرنشده" : doc.version}</bdi>
                </p>
              </div>
              <div className="document-state">
                <span className="status-badge">
                  {doc.content_status === "inactive"
                    ? statuses.inactive
                    : (statuses[doc.processing_status] ?? "وضعیت نامشخص")}
                </span>
                <p className="field-help">
                  {!doc.has_published_revision
                    ? "نمایه هنوز آماده نیست"
                    : doc.content_status === "inactive"
                      ? "نمایه‌شده، اما از دسترس خارج شده"
                      : "نمایه آماده است"}
                </p>
                {doc.processing_status === "failed" && (
                  <p className="form-error">{errorMessage(doc.safe_error)}</p>
                )}
              </div>
              <DocumentActions doc={doc} request={request} onChanged={refresh} />
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
