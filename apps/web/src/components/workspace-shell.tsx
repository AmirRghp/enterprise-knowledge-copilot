import Link from "next/link";
import { BookOpen, ChevronLeft, FileText, House, MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";
import type { Identity } from "@/lib/auth-contract";
import { SessionControls } from "./session-controls";

export function WorkspaceShell({
  children,
  identity,
  section = "overview",
}: Readonly<{
  children: ReactNode;
  identity: Identity;
  section?: "overview" | "ask" | "sources" | "manager";
}>) {
  return (
    <div className="workspace">
      <aside className="sidebar" aria-label="فضای کاری">
        <a className="workspace-name" href="#main-content">
          <span className="brand-name">سپهر داده</span>
          <span className="workspace-label">فضای دانش سازمانی</span>
        </a>
        <nav className="sidebar-nav" aria-label="ناوبری اصلی">
          <p className="nav-label">فضای کاری</p>
          <Link
            className={`nav-item ${section === "overview" ? "current" : ""}`}
            href="/"
            aria-current={section === "overview" ? "page" : undefined}
          >
            <House size={20} aria-hidden="true" />
            نمای کلی
          </Link>
          <Link
            className={`nav-item ${section === "ask" ? "current" : ""}`}
            href="/ask"
            aria-current={section === "ask" ? "page" : undefined}
          >
            <MessagesSquare size={20} aria-hidden="true" />
            پرسش‌وپاسخ
          </Link>
          <Link
            className={`nav-item ${section === "sources" ? "current" : ""}`}
            href="/sources"
            aria-current={section === "sources" ? "page" : undefined}
          >
            <FileText size={20} aria-hidden="true" />
            منابع
          </Link>
        </nav>
        {identity.role === "manager" && (
          <Link
            className={`nav-item ${section === "manager" ? "current" : ""}`}
            href="/manager/documents"
            aria-current={section === "manager" ? "page" : undefined}
          >
            <FileText size={20} aria-hidden="true" /> مدیریت اسناد
          </Link>
        )}
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
            <span className="breadcrumb-current">
              {section === "manager"
                ? "مدیریت اسناد"
                : section === "ask"
                  ? "پرسش‌وپاسخ"
                  : section === "sources"
                    ? "منابع"
                    : "نمای کلی"}
            </span>
          </div>
          <div className="account-summary">
            <span>
              <bdi>{identity.login}</bdi> · {identity.role === "manager" ? "مدیر" : "کارمند"}
            </span>
            <SessionControls expiresAt={identity.session_expires_at} />
          </div>
        </header>
        {/*
          The sidebar is hidden below 1024px, so this bar is the only navigation on a
          phone - and it was rendered for managers alone, which left an employee with no
          way to reach the ask page or the document list at that width. Reaching a single
          section is not a substitute: the list is how a reader finds out what they may
          cite at all. Every destination the sidebar offers is therefore here for both
          roles, and only the management link is role-conditional.
        */}
        <nav className="mobile-nav" aria-label="ناوبری اصلی">
          <Link
            className={`text-link ${section === "overview" ? "current" : ""}`}
            href="/"
            aria-current={section === "overview" ? "page" : undefined}
          >
            نمای کلی
          </Link>
          <Link
            className={`text-link ${section === "ask" ? "current" : ""}`}
            href="/ask"
            aria-current={section === "ask" ? "page" : undefined}
          >
            پرسش‌وپاسخ
          </Link>
          <Link
            className={`text-link ${section === "sources" ? "current" : ""}`}
            href="/sources"
            aria-current={section === "sources" ? "page" : undefined}
          >
            منابع
          </Link>
          {identity.role === "manager" && (
            <Link
              className={`text-link ${section === "manager" ? "current" : ""}`}
              href="/manager/documents"
              aria-current={section === "manager" ? "page" : undefined}
            >
              مدیریت اسناد
            </Link>
          )}
        </nav>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
