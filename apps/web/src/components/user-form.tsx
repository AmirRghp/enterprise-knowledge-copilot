"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ManagedUser } from "@/lib/user-contract";

export function UserForm({
  setup = false,
  user,
  onSaved,
  onPendingChange,
  onCancel,
}: Readonly<{
  setup?: boolean;
  user?: ManagedUser;
  onSaved?: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  onCancel?: () => void;
}>) {
  const router = useRouter();
  const busy = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const firstName = String(data.get("first_name") ?? "").trim();
    const lastName = String(data.get("last_name") ?? "").trim();
    const password = String(data.get("password") ?? "");
    setError("");
    if (!firstName || !lastName || password !== data.get("confirm")) {
      setError(
        !firstName || !lastName
          ? "نام و نام خانوادگی را وارد کنید."
          : "رمز عبور و تکرار آن یکسان نیستند.",
      );
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    busy.current = true;
    setPending(true);
    onPendingChange?.(true);
    try {
      const response = await fetch(
        setup
          ? "/api/auth/setup"
          : user
            ? `/api/manager/users/${user.user_id}`
            : "/api/manager/users",
        {
          method: user ? "PATCH" : "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: data.get("email"),
            first_name: firstName,
            last_name: lastName,
            ...(!user || password ? { password } : {}),
            ...(!setup ? { role: data.get("role") } : {}),
            ...(user ? { is_active: data.get("is_active") === "true" } : {}),
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (setup && response.status === 409) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? user
              ? "ایمیل تکراری است یا تغییر، آخرین مدیر فعال را از دسترس خارج می‌کند."
              : "حسابی با این ایمیل وجود دارد."
            : response.status === 422
              ? "نام، نام خانوادگی، ایمیل و رمز عبور را بررسی کنید؛ رمز تازه باید دست‌کم ۱۲ نویسه باشد."
              : response.status === 401 || response.status === 403
                ? "نشست یا دسترسی مدیریت تغییر کرده است؛ دوباره وارد شوید."
                : response.status === 429
                  ? "تلاش‌های زیادی ثبت شده است؛ کمی بعد دوباره امتحان کنید."
                  : "ذخیرهٔ حساب انجام نشد؛ دوباره تلاش کنید.",
        );
      form.reset();
      if (setup) {
        router.replace("/");
        router.refresh();
      } else await onSaved?.();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === "Error"
          ? cause.message
          : "ارتباط با سرویس برقرار نشد.",
      );
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      busy.current = false;
      setPending(false);
      onPendingChange?.(false);
    }
  }
  return (
    <form className="login-form account-form" onSubmit={submit} aria-busy={pending}>
      <fieldset className="provider-fields" disabled={pending}>
        <div className="form-field">
          <label htmlFor="account-first-name">نام</label>
          <input
            id="account-first-name"
            name="first_name"
            autoComplete="given-name"
            defaultValue={user?.first_name ?? ""}
            required
            maxLength={100}
          />
        </div>
        <div className="form-field">
          <label htmlFor="account-last-name">نام خانوادگی</label>
          <input
            id="account-last-name"
            name="last_name"
            autoComplete="family-name"
            defaultValue={user?.last_name ?? ""}
            required
            maxLength={100}
          />
        </div>
        <div className="form-field">
          <label htmlFor="account-email">ایمیل</label>
          <input
            id="account-email"
            name="email"
            type="email"
            autoComplete="username"
            defaultValue={user?.login ?? ""}
            dir="ltr"
            required
            maxLength={200}
          />
        </div>
        <div className="form-field">
          <label htmlFor="account-password">{user ? "رمز عبور جدید" : "رمز عبور"}</label>
          <input
            id="account-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required={!user}
            minLength={12}
            maxLength={512}
            aria-describedby="account-password-help"
          />
          <p id="account-password-help" className="field-help">
            {user ? "برای حفظ رمز فعلی، این فیلد را خالی بگذارید. " : ""}رمز تازه باید بین ۱۲ تا ۵۱۲
            نویسه باشد.
          </p>
        </div>
        <div className="form-field">
          <label htmlFor="account-confirm">تکرار رمز عبور</label>
          <input
            id="account-confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required={!user}
            minLength={12}
            maxLength={512}
          />
        </div>
        {!setup && (
          <div className="form-field">
            <label htmlFor="account-role">نقش</label>
            <select id="account-role" name="role" defaultValue={user?.role ?? "employee"}>
              <option value="employee">کارمند</option>
              <option value="manager">مدیر</option>
            </select>
            <p className="field-help">
              مدیر به کارکنان، اسناد مدیریتی و تنظیمات ارائه‌دهندگان دسترسی دارد.
            </p>
          </div>
        )}
        {user && (
          <div className="form-field">
            <label htmlFor="account-active">وضعیت</label>
            <select id="account-active" name="is_active" defaultValue={String(user.is_active)}>
              <option value="true">فعال</option>
              <option value="false">غیرفعال</option>
            </select>
            <p className="field-help">
              تغییر ایمیل، رمز، نقش یا وضعیت، نشست‌های قبلی این حساب را می‌بندد.
            </p>
          </div>
        )}
      </fieldset>
      {error && (
        <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}
      <div className="provider-dialog-actions">
        <button className="button button-primary" disabled={pending}>
          {pending
            ? "در حال ذخیره…"
            : setup
              ? "ثبت مدیر و ورود"
              : user
                ? "ذخیرهٔ تغییرات"
                : "ثبت کاربر"}
        </button>
        {onCancel && (
          <button
            type="button"
            className="button button-secondary"
            disabled={pending}
            onClick={onCancel}
          >
            انصراف
          </button>
        )}
      </div>
    </form>
  );
}
