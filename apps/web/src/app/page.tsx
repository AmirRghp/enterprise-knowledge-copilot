import { ArrowDown, ArrowUpLeft, BookOpen, Info, Quote } from "lucide-react";
import { WorkspaceShell } from "@/components/workspace-shell";

const steps = [
  {
    number: "۰۱",
    title: "پرسش را روشن بنویسید",
    description:
      "موضوع و شرایط خود را مشخص کنید؛ هرچه پرسش دقیق‌تر باشد، یافتن بند مرتبط آسان‌تر است.",
  },
  {
    number: "۰۲",
    title: "پاسخ را کنار منبع بخوانید",
    description: "پاسخ مستند باید به بخش مشخصی از سند اشاره کند تا بتوانید متن اصلی را بررسی کنید.",
  },
  {
    number: "۰۳",
    title: "نبود پاسخ هم یک نتیجه است",
    description:
      "وقتی شواهد کافی وجود ندارد، دستیار باید این موضوع را روشن بیان کند و پاسخ حدسی نسازد.",
  },
];

export default function OverviewPage() {
  return (
    <WorkspaceShell>
      <section className="welcome" aria-labelledby="page-title">
        <p className="eyebrow">
          <BookOpen size={16} aria-hidden="true" /> فضای دانش تیم شما
        </p>
        <h1 id="page-title">
          به فضای دانش <br />
          <span>سپهر داده خوش آمدید.</span>
        </h1>
        <p className="welcome-description">
          یک جای مشترک برای پرسیدن، خواندن و پیدا کردن مسیر در اسناد داخلی. پاسخ‌ها زمانی ارزش دارند
          که بتوان منبع آن‌ها را دید و بررسی کرد.
        </p>
        <div className="welcome-actions">
          <a className="button button-primary" href="#how-it-works">
            آشنایی با این فضا <ArrowDown size={16} aria-hidden="true" />
          </a>
          <a className="text-link" href="#preview-scope">
            دربارهٔ این پیش‌نمایش <ArrowUpLeft size={16} aria-hidden="true" />
          </a>
        </div>
      </section>

      <section
        id="how-it-works"
        className="guide-section"
        aria-labelledby="guide-title"
        tabIndex={-1}
      >
        <div className="guide-heading">
          <p className="eyebrow">یک مسیر ساده</p>
          <h2 id="guide-title">از پرسش تا منبع</h2>
          <p className="section-description">این فضا با این سه اصل شکل می‌گیرد.</p>
        </div>
        <div className="guide-layout">
          <ol className="steps">
            {steps.map((step) => (
              <li className="step" key={step.number}>
                <span className="step-number" aria-hidden="true">
                  {step.number}
                </span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </div>
              </li>
            ))}
          </ol>
          <aside className="question-note" aria-labelledby="example-title">
            <div className="note-topline">
              <span className="note-tag">برای مثال</span>
              <Quote size={24} aria-hidden="true" />
            </div>
            <h3 id="example-title">یک پرسش با زمینهٔ کافی</h3>
            <blockquote>
              «برای ثبت درخواست مرخصی، چه اطلاعاتی لازم است و از کجا شروع کنم؟»
            </blockquote>
            <p>موضوع مشخص است؛ پاسخ باید از سند مرتبط بیاید، همراه با ارجاع به همان بخش.</p>
            <span className="note-footnote">نمونهٔ پرسش · بدون پاسخ تولیدشده</span>
          </aside>
        </div>
      </section>

      <section
        id="preview-scope"
        className="preview-notice"
        aria-labelledby="scope-title"
        tabIndex={-1}
      >
        <Info size={20} aria-hidden="true" />
        <div>
          <h2 id="scope-title">فعلاً با فضای اولیه آشنا شوید</h2>
          <p>
            این نسخه فقط پیش‌نمایش رابط است. ورود، پرسش‌وپاسخ و فهرست منابع هنوز در دسترس نیستند.
            همهٔ اسناد و سیاست‌های سپهر داده ساختگی‌اند.
          </p>
        </div>
      </section>
      <footer className="page-footer">
        <span>سپهر داده · دستیار دانش سازمانی</span>
        <span>پیش‌نمایش اولیه</span>
      </footer>
    </WorkspaceShell>
  );
}
