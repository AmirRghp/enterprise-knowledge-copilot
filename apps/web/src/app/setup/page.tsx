import { redirect } from "next/navigation";
import { setupRequired } from "@/lib/auth-server";
import { UserForm } from "@/components/user-form";
import { ServiceUnavailable } from "@/components/service-unavailable";
export default async function SetupPage() {
  let required;
  try {
    required = await setupRequired();
  } catch {
    return <ServiceUnavailable />;
  }
  if (!required) redirect("/login");
  return (
    <main id="main-content" className="login-page" tabIndex={-1}>
      <section className="login-panel" aria-labelledby="setup-title">
        <p className="eyebrow">سپهر داده · راه‌اندازی اولیه</p>
        <h1 id="setup-title">ثبت مدیر نرم‌افزار</h1>
        <p className="welcome-description">
          این حساب مدیریت کارکنان، اسناد و تنظیمات را در اختیار خواهد داشت. پس از ثبت آن، ساخت
          حساب‌های دیگر از پنل مدیر انجام می‌شود.
        </p>
        <UserForm setup />
      </section>
    </main>
  );
}
