import { BookOpen, ChevronLeft, FileText, House, MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";

export function WorkspaceShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="workspace">
      <aside className="sidebar" aria-label="فضای کاری">
        <a className="workspace-name" href="#main-content">
          <span className="brand-name">سپهر داده</span>
          <span className="workspace-label">فضای دانش سازمانی</span>
        </a>
        <nav className="sidebar-nav" aria-label="ناوبری اصلی">
          <p className="nav-label">فضای کاری</p>
          <a className="nav-item current" href="#main-content" aria-current="page">
            <House size={20} aria-hidden="true" />
            نمای کلی
          </a>
          <span className="nav-item upcoming" aria-disabled="true">
            <MessagesSquare size={20} aria-hidden="true" />
            پرسش‌وپاسخ
            <span className="coming-soon">به‌زودی</span>
          </span>
          <span className="nav-item upcoming" aria-disabled="true">
            <FileText size={20} aria-hidden="true" />
            منابع
            <span className="coming-soon">به‌زودی</span>
          </span>
        </nav>
        <div className="sidebar-note">
          <BookOpen size={20} aria-hidden="true" />
          <p>
            دانش مشترک،
            <br />
            مسیر روشن‌تر.
          </p>
        </div>
        <p className="sidebar-footer">شرکت و اسناد این نمونه ساختگی‌اند.</p>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <div className="breadcrumb">
            <span className="desktop-breadcrumb">فضای کاری</span>
            <ChevronLeft className="desktop-breadcrumb" size={14} aria-hidden="true" />
            <span className="mobile-brand">سپهر داده</span>
            <span className="breadcrumb-current">نمای کلی</span>
          </div>
          <span className="preview-label">پیش‌نمایش رابط</span>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
