"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  answerContractFrom,
  type AnswerContract,
  type Citation,
  type Claim,
} from "@/lib/answer-contract";
import { sourcePath } from "@/lib/document-contract";

const MAX_QUESTION_CHARS = 2000;
const MAX_HISTORY_TURNS = 5;

type Failure =
  | { kind: "rate-limited"; retryAfter: number }
  | { kind: "unreachable" }
  | { kind: "too-slow" }
  | { kind: "busy" }
  | { kind: "unavailable" }
  | { kind: "not-configured" }
  | { kind: "contract" };

type Turn =
  | { id: string; question: string; kind: "asking" }
  | { id: string; question: string; kind: "answered"; contract: AnswerContract }
  | { id: string; question: string; kind: "failed"; failure: Failure };

const describe = (failure: Failure): string => {
  switch (failure.kind) {
    case "rate-limited":
      return "در این بازه پرسش‌های زیادی ثبت شده است. چند لحظه بعد دوباره تلاش کنید.";
    case "unreachable":
      return "ارتباط با سرویس پاسخ برقرار نشد. اتصال شبکه را بررسی کنید و دوباره تلاش کنید.";
    case "too-slow":
      return "پاسخ در زمان مقرر آماده نشد. سؤال را کوتاه‌تر کنید یا کمی بعد دوباره تلاش کنید.";
    case "busy":
      return "سرویس مشغول است؛ کمی بعد دوباره تلاش کنید.";
    case "not-configured":
      return "سرویس پاسخ هنوز تنظیم نشده است. برای راه‌اندازی با مدیر تماس بگیرید.";
    case "unavailable":
      return "پاسخی ساخته نشد. لطفاً کمی بعد دوباره تلاش کنید.";
    case "contract":
      return "پاسخ دریافتی کامل خوانده نشد. لطفاً دوباره تلاش کنید.";
  }
};

function failureFromStatus(status: number, retryAfter: string | null, detail?: unknown): Failure {
  if (status === 429) {
    const seconds = Number.parseInt(retryAfter ?? "", 10);
    return { kind: "rate-limited", retryAfter: Number.isFinite(seconds) ? seconds : 60 };
  }
  if (status === 503)
    return detail === "سرویس مشغول است؛ کمی بعد دوباره تلاش کنید"
      ? { kind: "busy" }
      : { kind: "not-configured" };
  if (status === 504) return { kind: "too-slow" };
  if (status === 401) return { kind: "unreachable" };
  return { kind: "unavailable" };
}

export function AskPanel() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const inputId = useId();
  const countId = useId();
  const endRef = useRef<HTMLLIElement>(null);
  const inFlight = useRef(false);
  const busy = turns.some((turn) => turn.kind === "asking");

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const send = useCallback(async (prompt: string, context: Turn[], id: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const history = context
        .filter((turn): turn is Extract<Turn, { kind: "answered" }> => turn.kind === "answered")
        .slice(-MAX_HISTORY_TURNS)
        .map(({ question: previousQuestion, contract }) => ({
          question: previousQuestion,
          answer: contract.answer,
          sources: contract.sources,
        }));
      const response = await fetch("/api/answers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: prompt, history }),
      });
      if (!response.ok) {
        const failureBody = await response
          .clone()
          .json()
          .catch(() => null);
        setTurns((current) =>
          current.map((turn) =>
            turn.id === id
              ? {
                  id,
                  question: prompt,
                  kind: "failed",
                  failure: failureFromStatus(
                    response.status,
                    response.headers.get("retry-after"),
                    failureBody?.detail,
                  ),
                }
              : turn,
          ),
        );
        return;
      }
      const contract = answerContractFrom(await response.json());
      setTurns((current) =>
        current.map((turn) =>
          turn.id === id ? { id, question: prompt, kind: "answered", contract } : turn,
        ),
      );
    } catch {
      setTurns((current) =>
        current.map((turn) =>
          turn.id === id
            ? { id, question: prompt, kind: "failed", failure: { kind: "unreachable" } }
            : turn,
        ),
      );
    } finally {
      inFlight.current = false;
    }
  }, []);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = question.trim();
      if (!trimmed || trimmed.length > MAX_QUESTION_CHARS || inFlight.current) return;
      const id = crypto.randomUUID();
      const asking: Turn = { id, question: trimmed, kind: "asking" };
      setTurns((current) => [...current, asking]);
      setQuestion("");
      void send(trimmed, turns, id);
    },
    [question, send, turns],
  );

  const retry = useCallback(
    (turn: Extract<Turn, { kind: "failed" }>, index: number) => {
      if (inFlight.current) return;
      const context = turns.slice(0, index);
      setTurns((current) =>
        current.map((item) =>
          item.id === turn.id ? { id: turn.id, question: turn.question, kind: "asking" } : item,
        ),
      );
      void send(turn.question, context, turn.id);
    },
    [send, turns],
  );

  const tooLong = question.trim().length > MAX_QUESTION_CHARS;
  const count = question.trim().length;

  return (
    <div className="ask-view">
      <header className="ask-heading">
        <div>
          <h1>پرسش از اسناد سازمانی</h1>
          <p>پاسخ‌ها از اسنادی ساخته می‌شوند که به نقش شما دسترسی دارند.</p>
        </div>
        {turns.length > 0 && (
          <button
            className="ask-new-chat"
            type="button"
            disabled={busy}
            onClick={() => {
              setTurns([]);
              setQuestion("");
            }}
          >
            گفت‌وگوی تازه
          </button>
        )}
      </header>

      <ol
        className="ask-messages"
        aria-label="پیام‌های گفت‌وگو"
        aria-live="polite"
        aria-busy={busy}
      >
        {turns.map((turn, index) => (
          <li className="ask-turn" key={turn.id}>
            <div className="ask-user-message">
              <span className="chat-speaker">شما</span>
              <p>{turn.question}</p>
            </div>
            {turn.kind === "asking" && (
              <div className="assistant-message ask-waiting" role="status">
                <span className="chat-speaker">دستیار</span>
                <span className="ask-waiting-line">
                  <span className="ask-spinner" aria-hidden="true" />
                  در حال بررسی اسناد و آماده‌کردن پاسخ…
                </span>
              </div>
            )}
            {turn.kind === "answered" && <AnswerCard contract={turn.contract} />}
            {turn.kind === "failed" && (
              <div className="assistant-message ask-failed" role="alert">
                <span className="chat-speaker">دستیار</span>
                <p>{describe(turn.failure)}</p>
                <button type="button" className="ask-retry" onClick={() => retry(turn, index)}>
                  تلاش دوباره
                </button>
              </div>
            )}
          </li>
        ))}
        {turns.length === 0 && (
          <li className="ask-empty" role="status">
            <span className="ask-empty-mark" aria-hidden="true">
              ؟
            </span>
            <p>از دستورالعمل‌ها و فرایندهای سازمانی بپرسید.</p>
            <p className="ask-hint">مثلاً: مهلت ثبت درخواست بازپرداخت هزینهٔ سفر چند روز است؟</p>
          </li>
        )}
        <li className="ask-scroll-end" aria-hidden="true" ref={endRef} />
      </ol>

      <form className="ask-form" onSubmit={submit} aria-busy={busy}>
        <label className="ask-sr-only" htmlFor={inputId}>
          پرسش شما
        </label>
        <textarea
          id={inputId}
          className="ask-input"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="پیام خود را بنویسید…"
          rows={2}
          maxLength={MAX_QUESTION_CHARS}
          required
          aria-describedby={countId}
          aria-invalid={tooLong || undefined}
          disabled={busy}
        />
        <div className="ask-form-footer">
          <p id={countId} className={tooLong ? "ask-count over" : "ask-count"}>
            <bdi dir="ltr">{count}</bdi> از <bdi dir="ltr">{MAX_QUESTION_CHARS}</bdi> نویسه
            {tooLong && " — پرسش بیش از حد مجاز است."}
          </p>
          <button
            className="ask-submit"
            type="submit"
            disabled={busy || tooLong || !question.trim()}
          >
            {busy ? "در حال پاسخ…" : "ارسال"}
          </button>
        </div>
        <p className="ask-composer-note">پرسش‌ها و پاسخ‌ها فقط در همین صفحه نگه داشته می‌شوند.</p>
      </form>
    </div>
  );
}

function foldRepeated(claims: Claim[]) {
  const order: string[] = [];
  const byText = new Map<string, Claim[]>();
  for (const claim of claims) {
    const existing = byText.get(claim.text);
    if (existing) existing.push(claim);
    else {
      byText.set(claim.text, [claim]);
      order.push(claim.text);
    }
  }
  return order.map((text) => ({ text, claims: byText.get(text) ?? [] }));
}

function SourceLink({ source }: Readonly<{ source: Citation }>) {
  return (
    <a className="text-link" href={sourcePath(source)} target="_blank" rel="noopener noreferrer">
      <bdi>{source.document_id}</bdi>
      {" · "}
      <bdi>{source.section_id}</bdi>
      <span className="source-hint"> (در تب تازه باز می‌شود)</span>
    </a>
  );
}

function AnswerCard({ contract }: Readonly<{ contract: AnswerContract }>) {
  const { abstained, answer, claims, sources } = contract;
  const grouped = foldRepeated(claims);
  const abstainedAlone = abstained && claims.length === 0 && sources.length === 0;
  return (
    <section
      className={`assistant-message answer-card${abstainedAlone ? " abstained" : ""}`}
      aria-label="پاسخ دستیار"
    >
      <span className="chat-speaker">دستیار</span>
      {abstained && !abstainedAlone && (
        <p className="answer-partial" role="status">
          این پاسخ کامل نیست. محدودیت اسناد در دسترس در متن پاسخ آمده است.
        </p>
      )}
      <p className="answer-text">{answer}</p>
      {claims.length > 0 && (
        <details className="answer-evidence">
          <summary>مشاهدهٔ ادعاها، نقل‌قول‌ها و منابع پشتیبان</summary>
          <ol className="answer-claims">
            {grouped.map((group) => (
              <li key={group.text} className="claim">
                <p className="claim-text">{group.text}</p>
                {group.claims.map((claim) => (
                  <blockquote key={claim.quote} className="claim-quote">
                    {claim.quote}
                  </blockquote>
                ))}
                <p className="claim-source">
                  {group.claims.map((claim, index) => (
                    <span key={`${claim.source.document_id}-${claim.source.section_id}`}>
                      {index > 0 && " · "}
                      <SourceLink source={claim.source} />
                    </span>
                  ))}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
