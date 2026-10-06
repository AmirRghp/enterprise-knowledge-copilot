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
  updated_at: string;
  job_id?: string | null;
  safe_error?: string | null;
};
type Job = { job_id: string; status: string; safe_error: string | null };
const statuses: Record<string, string> = {
  pending: "در صف پردازش",
  indexing: "در حال پردازش",
  ready: "آماده",
  failed: "پردازش ناموفق",
  active: "فعال",
  deleted: "حذف‌شده",
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
};
const errorMessage = (code?: string | null) =>
  errors[code ?? ""] ??
  "پردازش کامل نشد. با مسئول سامانه تماس بگیرید و پس از رفع مشکل دوباره بارگذاری کنید.";

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
      if (response.status === 400 || response.status === 413 || response.status === 422)
        throw new Error(
          "فایل UTF-8 با پسوند md یا txt، حداکثر ۱ مگابایت و عنوان معتبر بارگذاری کنید. اگر مشکل ادامه دارد، ظرفیت سامانه را با مسئول آن بررسی کنید.",
        );
      if (!response.ok) throw new Error("ارتباط با سرویس برقرار نشد. دوباره امتحان کنید.");
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
    const file = data.get("file");
    if (
      !(file instanceof File) ||
      !file.size ||
      file.size > 1024 * 1024 ||
      !/\.(md|txt)$/i.test(file.name)
    ) {
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
        سند تازه بارگذاری کنید و وضعیت آماده‌شدن نمایهٔ آن را ببینید.
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
                <h3>{doc.title}</h3>
                <p className="field-help">
                  {doc.access_role === "manager" ? "فقط مدیران" : "کارمندان و مدیران"} · نسخه:{" "}
                  <bdi>{doc.version === "unpublished" ? "منتشرنشده" : doc.version}</bdi>
                </p>
              </div>
              <div className="document-state">
                <span className="status-badge">
                  {statuses[doc.processing_status] ?? "وضعیت نامشخص"}
                </span>
                <p className="field-help">
                  {doc.content_status === "active" && doc.processing_status === "ready"
                    ? "نمایه آماده است"
                    : "نمایه هنوز آماده نیست"}
                </p>
                {doc.processing_status === "failed" && (
                  <p className="form-error">{errorMessage(doc.safe_error)}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
