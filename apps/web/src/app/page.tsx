import { redirect } from "next/navigation";
import { currentIdentity } from "@/lib/auth-server";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ServiceUnavailable } from "@/components/service-unavailable";

export default async function OverviewPage() {
  let identity;
  try {
    identity = await currentIdentity();
  } catch {
    return <ServiceUnavailable />;
  }
  if (!identity) redirect("/login");
  return (
    <WorkspaceShell identity={identity}>
      <section className="welcome" aria-labelledby="page-title">
        <p className="eyebrow">فضای دانش تیم شما</p>
        <h1 id="page-title">به سپهر داده خوش آمدید.</h1>
        <p className="welcome-description">
          شما با نقش {identity.role === "manager" ? "مدیر" : "کارمند"} وارد شده‌اید.
        </p>
        <div className="preview-notice">
          <div>
            <h2>فضای کاری در حال آماده‌سازی است</h2>
            <p>ورود و خروج فعال است. پرسش‌وپاسخ و فهرست منابع در مراحل بعد اضافه می‌شوند.</p>
          </div>
        </div>
        {identity.role === "manager" && (
          <section className="guide-section" aria-labelledby="manager-title">
            <h2 id="manager-title">مدیریت اسناد</h2>
            <p className="section-description">
              سند تازه بارگذاری کنید و وضعیت پردازش منابع را ببینید.
            </p>
            <a className="text-link" href="/manager/documents">
              رفتن به مدیریت اسناد
            </a>
          </section>
        )}
      </section>
    </WorkspaceShell>
  );
}
