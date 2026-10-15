"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { parseOrganization, type Organization } from "@/lib/organization-contract";

async function request(method = "GET", body?: unknown): Promise<Organization> {
  const response = await fetch("/api/manager/settings/organization", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(String(response.status));
  return parseOrganization(await response.json());
}

function errorText(error: unknown) {
  if (!(error instanceof Error)) return "نام سازمان بارگذاری نشد؛ دوباره تلاش کنید.";
  if (error.message === "401") return "نشست شما پایان یافته است؛ دوباره وارد شوید.";
  if (error.message === "403") return "برای این بخش مجاز نیستید.";
  if (error.message === "422") return "نام سازمان را بررسی کنید؛ حداکثر ۱۰۰ نویسه مجاز است.";
  if (error.message === "503") return "تنظیمات در دسترس نیست؛ کمی بعد تلاش کنید.";
  return "ارتباط برقرار نشد؛ دوباره تلاش کنید.";
}

export function ManagerOrganization() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let current = true;
    request()
      .then((value) => {
        if (current) setName(value.name);
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
    if (busy) return;
    const value = name.trim();
    if (!value || value.length > 100) {
      setError("نام سازمان را وارد کنید؛ حداکثر ۱۰۰ نویسه مجاز است.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await request("PUT", { name: value });
      setName(updated.name);
      setNotice("نام سازمان ذخیره شد.");
      router.refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="organization-title">
      <div className="manager-documents-heading">
        <div>
          <p className="eyebrow">اطلاعات نصب</p>
          <h1 id="organization-title">نام شرکت یا سازمان</h1>
          <p>این نام در سربرگ، صفحه‌های ورود و عنوان مرورگر نمایش داده می‌شود.</p>
        </div>
      </div>
      {pending ? <p role="status">در حال بارگذاری…</p> : null}
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
      {!pending && (
        <form className="login-form rate-limit-form" onSubmit={save}>
          <div className="form-field">
            <label htmlFor="organization-name-setting">نام شرکت یا سازمان</label>
            <input
              id="organization-name-setting"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
            />
          </div>
          <div className="manager-list-heading">
            <button className="button button-primary" type="submit" disabled={busy || pending}>
              {busy ? "در حال ذخیره…" : "ذخیرهٔ نام"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
