"use client";

import { useEffect, useRef } from "react";
import type { SourceSection } from "@/lib/document-contract";
import { useSourceSection, type SourceHandle, type SourceState } from "@/lib/use-source-section";

/**
 * Show the text of one cited section.
 *
 * The three refusals the API serves - absent, forbidden, stale revision - arrive as one
 * byte-identical 404, and they are rendered as one message. The reader is not told which
 * happened, and neither is this component: the difference is not in the response, so any
 * inference drawn from it would be a guess that, on the forbidden case, tells a reader that
 * a document they may not read exists.
 */
export function SourceInspector({ handle }: Readonly<{ handle: SourceHandle }>) {
  const state = useSourceSection(handle);
  const heading = useRef<HTMLHeadingElement>(null);
  const shownFor = useRef<string | null>(null);

  // Focus moves to the heading each time a *new* handle lands its text, because the reader
  // arrives from a citation and has no idea where the text began. Keyed on the handle
  // rather than once per mount: on a client-side move to another citation the component
  // stays mounted, and a one-shot flag would leave focus behind on the old page while the
  // content underneath changed.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const key = `${handle.document_id}|${handle.section_id}|${handle.revision}`;
    if (shownFor.current === key) return;
    shownFor.current = key;
    heading.current?.focus();
  }, [state.kind, handle]);

  return <InspectorBody state={state} heading={heading} />;
}

function InspectorBody({
  state,
  heading,
}: Readonly<{ state: SourceState; heading: React.RefObject<HTMLHeadingElement | null> }>) {
  return (
    <div className="sources-view">
      <header className="ask-heading">
        <h1>متن منبع</h1>
      </header>

      <div aria-live="polite" aria-busy={state.kind === "loading"}>
        {state.kind === "idle" && (
          <div className="manager-empty" role="status">
            <p>نشانی یک منبع کامل نیست.</p>
            <p className="ask-hint">
              منبع را از داخل یک پاسخ باز کنید، یا از فهرست اسناد شروع کنید.
            </p>
          </div>
        )}

        {state.kind === "loading" && (
          <p className="ask-hint" role="status">
            در حال خواندن متن منبع…
          </p>
        )}

        {state.kind === "unavailable" && (
          // One message for all three refusals. Naming which one would tell an employee
          // that a document they may not read does exist.
          <div className="ask-waiting" role="status">
            <h2 ref={heading} tabIndex={-1}>
              این منبع در دسترس نیست
            </h2>
            <p>ممکن است سند حذف یا جایگزین شده باشد، یا این بخش به شما دسترسی نداشته باشد.</p>
            <p className="ask-hint">اگر همین سؤال را دوباره بپرسید، پاسخ تازه ساخته می‌شود.</p>
          </div>
        )}

        {state.kind === "failed" && (
          <div className="ask-waiting" role="alert">
            <h2 ref={heading} tabIndex={-1}>
              متن منبع خوانده نشد
            </h2>
            <p className="ask-hint">اتصال را بررسی کنید و صفحه را تازه کنید.</p>
          </div>
        )}

        {state.kind === "ready" && <SectionBody section={state.section} heading={heading} />}
      </div>
    </div>
  );
}

/**
 * The heading levels above the section's own title.
 *
 * The API's `heading_path` ends with the section title in every one of the 80 corpus
 * sections - it is the trail that leads *to* this section. Printing it in full puts the
 * title on screen twice, once as the trail's last step and once as the heading directly
 * below it, which reads as a mistake rather than as a hierarchy.
 *
 * The duplicate is compared by normalised text rather than by identity: the corpus contains
 * a ZWNJ in most titles, so a byte comparison would leave the repetition standing for
 * exactly the sections that needed it removed.
 */
export function parentHeadings(section: { title: string; heading_path: string[] }): string[] {
  const trail = section.heading_path;
  const last = trail.length - 1;
  // The mark becomes a space rather than disappearing: deleting it fuses the two words
  // it joins (`انتخاب` + ZWNJ + `مسیر` -> `انتخابمسیر`), which does not equal the same
  // phrase written with a real space - so the comparison would fail on precisely the
  // sections the mark was handled for.
  const normalise = (value: string) => value.replace(/[‌‏‎]/g, " ").replace(/\s+/g, " ").trim();
  const title = normalise(section.title);
  return trail.filter((part, index) => index !== last || normalise(part) !== title);
}

function SectionBody({
  section,
  heading,
}: Readonly<{ section: SourceSection; heading: React.RefObject<HTMLHeadingElement | null> }>) {
  const parents = parentHeadings(section);
  return (
    <article className="answer-card source-card">
      <h2 ref={heading} tabIndex={-1}>
        {section.title}
      </h2>
      {parents.length > 0 && (
        <p className="source-path">
          {parents.map((part, index) => (
            <span key={part}>
              {index > 0 && <span aria-hidden="true"> › </span>}
              {part}
            </span>
          ))}
        </p>
      )}
      <p className="document-state">
        <bdi>{section.document_id}</bdi>
        {" · "}
        <bdi>{section.section_id}</bdi>
      </p>
      {/*
        The document text as a text node, never as markup. It is uploaded content, so it is
        untrusted input: `pre-wrap` keeps the line breaks and spacing it was written with,
        and no parser stands between it and the reader.
      */}
      <div className="source-text" dir="rtl">
        {section.text}
      </div>
    </article>
  );
}
