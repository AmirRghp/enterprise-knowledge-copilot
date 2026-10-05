"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login: data.get("login"), password: data.get("password") }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        if (response.status === 401) throw new Error("شناسه یا رمز عبور درست نیست.");
        if (response.status === 429) {
          const seconds = response.headers.get("retry-after");
          throw new Error(
            `تلاش‌های ورود زیاد شده است. ${seconds && /^\d+$/.test(seconds) ? `${Number(seconds).toLocaleString("fa-IR")} ثانیه دیگر` : "کمی بعد"} دوباره امتحان کنید.`,
          );
        }
        if (response.status === 422) throw new Error("شناسه و رمز عبور را بررسی کنید.");
        throw new Error("ارتباط با سرویس ورود برقرار نشد. دوباره امتحان کنید.");
      }
      form.reset();
      router.replace("/");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === "Error"
          ? cause.message
          : "ارتباط با سرویس ورود برقرار نشد. دوباره امتحان کنید.",
      );
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit} aria-busy={pending}>
      <div className="form-field">
        <label htmlFor="login">شناسهٔ کاربری</label>
        <input
          id="login"
          name="login"
          autoComplete="username"
          dir="auto"
          required
          maxLength={200}
          aria-describedby="login-help"
        />
        <p id="login-help" className="field-help">
          شناسهٔ حسابی که برای شما ساخته شده است.
        </p>
      </div>
      <div className="form-field">
        <label htmlFor="password">رمز عبور</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={512}
          aria-describedby={error ? "login-error" : undefined}
          aria-invalid={error ? true : undefined}
        />
      </div>
      {error && (
        <p id="login-error" className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}
      <button className="button button-primary" disabled={pending} type="submit">
        ورود به فضای کاری
      </button>
      <p className="field-help" role="status">
        {pending ? "در حال بررسی اطلاعات ورود…" : ""}
      </p>
    </form>
  );
}
