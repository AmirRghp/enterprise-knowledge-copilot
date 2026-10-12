"use client";

import { useDocuments } from "@/lib/use-documents";
import type { DocumentSummary } from "@/lib/document-contract";

/**
 * The documents this actor may cite.
 *
 * `access_role` is shown to a manager and withheld from an employee. That is not a
 * convenience: an employee's list is the same documents either way, so the label tells
 * them nothing, and rendering it puts the boundary between the two roles in front of the
 * person it is drawn around.
 */
export function DocumentList({ role }: Readonly<{ role: "employee" | "manager" }>) {
  const state = useDocuments();

  return (
    <div className="sources-view">
      <header className="ask-heading">
        <h1>اسناد در دسترس شما</h1>
        <p>هر سندی که در پاسخ‌ها به آن ارجاع داده می‌شود، در این فهرست هست.</p>
      </header>

      <div aria-live="polite" aria-busy={state.kind === "loading"}>
        {state.kind === "loading" && (
          <p className="ask-hint" role="status">
            در حال خواندن فهرست اسناد…
          </p>
        )}

        {state.kind === "failed" && (
          <div className="ask-waiting" role="alert">
            <p>فهرست اسناد خوانده نشد.</p>
            <p className="ask-hint">اتصال را بررسی کنید و صفحه را تازه کنید.</p>
          </div>
        )}

        {state.kind === "ready" && state.documents.length === 0 && (
          // The empty state says what is true for the reader and nothing about what exists
          // elsewhere: "no documents for you", not "no documents".
          <div className="manager-empty" role="status">
            <p>هنوز سندی در دسترس شما نیست.</p>
            <p className="ask-hint">
              وقتی سندی منتشر شود، در پاسخ‌ها به آن ارجاع داده می‌شود و اینجا فهرست می‌شود.
            </p>
          </div>
        )}

        {state.kind === "ready" && state.documents.length > 0 && (
          <DocumentRows documents={state.documents} role={role} />
        )}
      </div>
    </div>
  );
}

function DocumentRows({
  documents,
  role,
}: Readonly<{ documents: DocumentSummary[]; role: "employee" | "manager" }>) {
  return (
    <ul className="document-list source-list">
      {documents.map((document) => (
        <li key={document.document_id} className="document-row">
          <div>
            {/* h2 rather than h3: it follows the page's h1 directly, so h3 would skip a
              level. Lighthouse's `heading-order` caught this on /sources. */}
            <h2>{document.title}</h2>
            <p className="document-state">
              <bdi>{document.document_id}</bdi>
              {role === "manager" && (
                <>
                  {" · "}
                  {document.access_role === "manager" ? "سطح دسترسی: مدیر" : "سطح دسترسی: کارمند"}
                </>
              )}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
