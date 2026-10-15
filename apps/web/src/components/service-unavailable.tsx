"use client";

export function ServiceUnavailable() {
  return (
    <main id="main-content" className="login-page" tabIndex={-1}>
      <section className="login-panel">
        <p className="eyebrow">فضای دانش سازمانی</p>
        <h1>ارتباط برقرار نشد</h1>
        <p className="welcome-description" role="alert">
          سرویس ورود در دسترس نیست. کمی بعد دوباره امتحان کنید.
        </p>
        <button className="button button-secondary" onClick={() => window.location.reload()}>
          تلاش مجدد
        </button>
      </section>
    </main>
  );
}
