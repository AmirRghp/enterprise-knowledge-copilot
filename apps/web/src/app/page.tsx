import { redirect } from "next/navigation";
import { currentIdentity, organizationName } from "@/lib/auth-server";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ServiceUnavailable } from "@/components/service-unavailable";

export default async function OverviewPage() {
  const name = await organizationName();
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
        <h1 id="page-title">به {name} خوش آمدید.</h1>
        <p className="welcome-description">پاسخ‌های مستند را در اسناد مجاز سازمان جست‌وجو کنید.</p>
        <a className="button button-primary" href="/ask">
          شروع پرسش‌وپاسخ
        </a>
        {identity.role === "manager" && (
          <section className="guide-section" aria-labelledby="manager-title">
            <h2 id="manager-title">مدیریت اسناد</h2>
            <p className="section-description">
              اسناد سازمان را بارگذاری کنید و وضعیت پردازش آن‌ها را ببینید.
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
