import { redirect } from "next/navigation";
import { currentIdentity, organizationName, setupRequired } from "@/lib/auth-server";
import { LoginForm } from "@/components/login-form";
import { ServiceUnavailable } from "@/components/service-unavailable";

export default async function LoginPage() {
  const name = await organizationName();
  let identity;
  let needsSetup;
  try {
    identity = await currentIdentity();
    needsSetup = !identity && (await setupRequired());
  } catch {
    return <ServiceUnavailable />;
  }
  if (identity) redirect("/");
  if (needsSetup) redirect("/setup");
  return (
    <main id="main-content" className="login-page" tabIndex={-1}>
      <section className="login-panel" aria-labelledby="login-title">
        <p className="eyebrow">{name} · فضای دانش سازمانی</p>
        <h1 id="login-title">ورود به فضای کاری</h1>
        <p className="welcome-description">
          با حساب خود وارد شوید. دسترسی شما براساس نقش حساب تعیین می‌شود.
        </p>
        <LoginForm />
      </section>
    </main>
  );
}
