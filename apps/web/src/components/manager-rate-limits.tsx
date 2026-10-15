"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { parseRateLimitSettings, type RateLimitSettings } from "@/lib/rate-limit-contract";

async function request(method = "GET", body?: unknown) {
  const response = await fetch("/api/manager/settings/rate-limits", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(String(response.status));
  return parseRateLimitSettings(await response.json());
}

function errorText(error: unknown) {
  if (!(error instanceof Error)) return "تنظیمات بارگذاری نشد؛ دوباره تلاش کنید.";
  if (error.message === "401") return "نشست شما پایان یافته است؛ دوباره وارد شوید.";
  if (error.message === "403") return "برای این بخش مجاز نیستید.";
  if (error.message === "409")
    return "تنظیمات هم‌زمان تغییر کرده؛ ابتدا نسخهٔ تازه را بارگذاری کنید.";
  if (error.message === "422") return "مقدارها خارج از بازهٔ مجاز هستند.";
  if (error.message === "503")
    return "سرویس مشغول است یا تنظیمات در دسترس نیست؛ کمی بعد تلاش کنید.";
  return "ارتباط برقرار نشد؛ دوباره تلاش کنید.";
}

export function ManagerRateLimits() {
  const router = useRouter();
  const [data, setData] = useState<RateLimitSettings | null>(null);
  const [draft, setDraft] = useState({ requests: "6", ollama: "1", cloud: "6" });
  const [pending, setPending] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setPending(true);
    setError("");
    try {
      const value = await request();
      setData(value);
      setDraft({
        requests: String(value.requests_per_user_per_minute),
        ollama: String(value.concurrency.ollama),
        cloud: String(value.concurrency.cloud),
      });
    } catch (cause) {
      setError(errorText(cause));
      if (cause instanceof Error && ["401", "403"].includes(cause.message)) {
        router.replace(cause.message === "401" ? "/login" : "/");
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    let current = true;
    request()
      .then((value) => {
        if (!current) return;
        setData(value);
        setDraft({
          requests: String(value.requests_per_user_per_minute),
          ollama: String(value.concurrency.ollama),
          cloud: String(value.concurrency.cloud),
        });
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setError(errorText(cause));
        if (cause instanceof Error && ["401", "403"].includes(cause.message)) {
          router.replace(cause.message === "401" ? "/login" : "/");
          router.refresh();
        }
      })
      .finally(() => {
        if (current) setPending(false);
      });
    return () => {
      current = false;
    };
  }, [router]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || busy) return;
    const values = [draft.requests, draft.ollama, draft.cloud].map((value) => Number(value));
    if (
      !Number.isInteger(values[0]) ||
      values[0] < 1 ||
      values[0] > 1000 ||
      !Number.isInteger(values[1]) ||
      values[1] < 1 ||
      values[1] > 100 ||
      !Number.isInteger(values[2]) ||
      values[2] < 1 ||
      values[2] > 100
    ) {
      setError("سهمیه باید بین ۱ تا ۱۰۰۰ و هم‌زمانی بین ۱ تا ۱۰۰ باشد.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await request("PUT", {
        requests_per_user_per_minute: values[0],
        ollama_concurrency: values[1],
        cloud_concurrency: values[2],
        version: data.version,
      });
      setData(updated);
      setDraft({
        requests: String(values[0]),
        ollama: String(values[1]),
        cloud: String(values[2]),
      });
      setNotice("تنظیمات ذخیره شد و برای درخواست‌های بعدی اعمال می‌شود.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="manager-rate-limits" aria-labelledby="rate-limits-title">
      <div className="manager-documents-heading">
        <div>
          <p className="eyebrow">مدیریت سرویس</p>
          <h1 id="rate-limits-title">سهمیه و ظرفیت</h1>
          <p>سهمیه برای هر کاربر جداست؛ ظرفیت بین درخواست‌های هم‌زمان کل سازمان مشترک است.</p>
        </div>
      </div>
      {pending ? <p role="status">در حال بارگذاری تنظیمات…</p> : null}
      {error ? (
        <p className="field-help" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="field-help" role="status">
          {notice}
        </p>
      ) : null}
      {data && (
        <form className="login-form rate-limit-form" onSubmit={save}>
          <div className="form-field">
            <label htmlFor="rate-requests">سهمیهٔ پرسش هر کاربر در دقیقه</label>
            <input
              id="rate-requests"
              type="number"
              min={1}
              max={1000}
              step={1}
              inputMode="numeric"
              dir="ltr"
              value={draft.requests}
              onChange={(event) => setDraft({ ...draft, requests: event.target.value })}
              required
            />
            <span className="field-help">
              از ۱ تا ۱۰۰۰ درخواست؛ مقدار فعلی برای هر کاربر {data.requests_per_user_per_minute}{" "}
              است.
            </span>
          </div>
          <div className="form-field">
            <label htmlFor="rate-ollama">هم‌زمانی Ollama محلی</label>
            <input
              id="rate-ollama"
              type="number"
              min={1}
              max={100}
              step={1}
              inputMode="numeric"
              dir="ltr"
              value={draft.ollama}
              onChange={(event) => setDraft({ ...draft, ollama: event.target.value })}
              required
            />
            <span className="field-help">
              از ۱ تا ۱۰۰ درخواست فعال؛ صف منتظر: {data.max_queued_requests_per_provider}.
            </span>
          </div>
          <div className="form-field">
            <label htmlFor="rate-cloud">هم‌زمانی سرویس‌های ابری</label>
            <input
              id="rate-cloud"
              type="number"
              min={1}
              max={100}
              step={1}
              inputMode="numeric"
              dir="ltr"
              value={draft.cloud}
              onChange={(event) => setDraft({ ...draft, cloud: event.target.value })}
              required
            />
            <span className="field-help">
              OpenAI، OpenRouter و OpenAI-compatible یک ظرفیت مشترک دارند.
            </span>
          </div>
          <div className="manager-list-heading">
            <button className="button button-primary" type="submit" disabled={busy || pending}>
              {busy ? "در حال ذخیره…" : "ذخیرهٔ تنظیمات"}
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void load()}
              disabled={busy || pending}
            >
              بارگذاری دوباره
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
