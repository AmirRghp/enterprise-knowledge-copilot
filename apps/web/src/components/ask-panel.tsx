"use client";

import { useCallback, useId, useRef, useState, type FormEvent } from "react";
import {
  answerContractFrom,
  hasBody,
  type AnswerContract,
  type Claim,
} from "@/lib/answer-contract";

/** The API's own ceiling. Checked here so an oversized question is refused before it is sent. */
const MAX_QUESTION_CHARS = 2000;

type Failure =
  | { kind: "rate-limited"; retryAfter: number }
  | { kind: "unreachable" }
  | { kind: "too-slow" }
  | { kind: "unavailable" }
  | { kind: "contract" };

type State =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "answered"; contract: AnswerContract }
  | { kind: "failed"; failure: Failure };

const describe = (failure: Failure): string => {
  switch (failure.kind) {
    case "rate-limited":
      return "در این بازه پرسش‌های زیادی ثبت شده است. چند لحظه بعد دوباره تلاش کنید.";
    // The proxy's timeout and a dead connection are both 502 here, so they read the
    // same. Saying "the service is busy" would be a claim about the service that the
    // proxy cannot make; saying "we could not reach it" is exactly what it knows.
    case "unreachable":
      return "ارتباط با سرویس پاسخ برقرار نشد. اتصال شبکه را بررسی کنید و دوباره تلاش کنید.";
    // A 504 from the API means its own 60-second budget ran out, which is a different
    // fact from an unreachable service and gets a different message.
    case "too-slow":
      return "پاسخ در زمان مقرر آماده نشد. سؤال را کوتاه‌تر کنید یا کمی بعد دوباره تلاش کنید.";
    case "unavailable":
      return "پاسخی ساخته نشد. لطفاً کمی بعد دوباره تلاش کنید.";
    case "contract":
      return "پاسخ دریافتی کامل خوانده نشد. لطفاً دوباره تلاش کنید.";
  }
};

function failureFromStatus(status: number, retryAfter: string | null): Failure {
  if (status === 429) {
    const seconds = Number.parseInt(retryAfter ?? "", 10);
    return { kind: "rate-limited", retryAfter: Number.isFinite(seconds) ? seconds : 60 };
  }
  if (status === 504) return { kind: "too-slow" };
  if (status === 401) return { kind: "unreachable" };
  return { kind: "unavailable" };
}

export function AskPanel() {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const inputId = useId();
  const errorId = useId();
  const resultId = useId();
  const busy = state.kind === "asking";
  // A disabled submit is the whole double-submit guard; the flag is also read inside
  // the submit handler, because a submit can arrive from the keyboard before React
  // has re-rendered the disabled button.
  const inFlight = useRef(false);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = question.trim();
      if (!trimmed || trimmed.length > MAX_QUESTION_CHARS || inFlight.current) return;
      inFlight.current = true;
      setState({ kind: "asking" });
      try {
        const response = await fetch("/api/answers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmed }),
        });
        if (!response.ok) {
          setState({
            kind: "failed",
            failure: failureFromStatus(response.status, response.headers.get("retry-after")),
          });
          return;
        }
        // A shape that fails this check is a contract break, not a refusal, and the
        // two must not read the same: one means "retry may work", the other means
        // "the answer was not trustworthy".
        setState({ kind: "answered", contract: answerContractFrom(await response.json()) });
      } catch {
        setState({ kind: "failed", failure: { kind: "unreachable" } });
      } finally {
        inFlight.current = false;
      }
    },
    [question],
  );

  const tooLong = question.trim().length > MAX_QUESTION_CHARS;
  const failed = state.kind === "failed" ? state.failure : null;
  // Computed rather than branched inside the JSX: the error paragraph is shown when
  // either condition holds, and a `Failure | null` reaching `describe` would be a cast
  // rather than a fact. Here the two cases are resolved while the type is still known.
  const errorText = tooLong
    ? `پرسش بلندتر از حد مجاز است. حداکثر ${MAX_QUESTION_CHARS} نویسه.`
    : failed
      ? describe(failed)
      : null;

  return (
    <div className="ask-view">
      <header className="ask-heading">
        <h1>پرسش‌وپاسخ از اسناد سازمانی</h1>
        <p>
          پرسیدن از اسنادی که به نقش شما دسترسی دارند. پاسخ همراه با نقل‌قول و ارجاع سند می‌آید.
        </p>
      </header>

      <form className="ask-form" onSubmit={submit} aria-busy={busy}>
        <label className="ask-label" htmlFor={inputId}>
          پرسش شما
        </label>
        <textarea
          id={inputId}
          className="ask-input"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="مثلاً: مهلت ثبت درخواست بازپرداخت هزینه سفر چند روز است؟"
          rows={3}
          maxLength={MAX_QUESTION_CHARS}
          // A submit is the keyboard path, so the textarea stays enter-first: a
          // newline is the only way to break the line, and Enter sends.
          required
          aria-describedby={errorText ? errorId : undefined}
          aria-invalid={errorText ? true : undefined}
        />
        <div className="ask-form-footer">
          <p className={tooLong ? "ask-count over" : "ask-count"}>
            <bdi dir="ltr">{question.trim().length}</bdi> از{" "}
            <bdi dir="ltr">{MAX_QUESTION_CHARS}</bdi> نویسه
          </p>
          <button
            className="ask-submit"
            type="submit"
            disabled={busy || tooLong || !question.trim()}
          >
            {busy ? "در حال پاسخ…" : "ارسال پرسش"}
          </button>
        </div>
        {errorText && (
          <p className="ask-error" id={errorId} role="alert">
            {errorText}
          </p>
        )}
      </form>

      <div className="ask-result" id={resultId} aria-live="polite" aria-busy={busy}>
        {state.kind === "idle" && (
          <p className="ask-hint" role="status">
            پرسش خود را بنویسید تا پاسخ مستند دریافت کنید.
          </p>
        )}
        {state.kind === "asking" && (
          <div className="ask-waiting" role="status">
            <span className="ask-spinner" aria-hidden="true" />
            <p>در حال یافتن اسناد مرتبط و ساخت پاسخ…</p>
            <p className="ask-hint">این کار معمولاً چند ثانیه طول می‌کشد.</p>
          </div>
        )}
        {state.kind === "answered" && <AnswerCard contract={state.contract} />}
      </div>
    </div>
  );
}

// Kept in its own module-sized unit so the panel stays under the size where the
// state machine and the presentation start competing for attention.
/**
 * Claims whose text is identical, folded to one line that says how many citations back it.
 *
 * Part 14 composes the answer from the validated claims, so two claims that happen to
 * say the same thing produce the same sentence twice. That is not a defect there —
 * the claims are independent and each carries its own citation, and merging them in the
 * service would risk making one citation stand for a passage it did not support.
 *
 * It *is* a defect in the rendering: a reader sees one sentence twice and cannot tell
 * whether it is an error or two sources agreeing. The distinction is not lost, it is
 * moved: one line, and the number of sources that independently support it.
 */
function foldRepeated(claims: Claim[]) {
  const order: string[] = [];
  const byText = new Map<string, Claim[]>();
  for (const claim of claims) {
    const existing = byText.get(claim.text);
    if (existing) {
      existing.push(claim);
    } else {
      byText.set(claim.text, [claim]);
      order.push(claim.text);
    }
  }
  return order.map((text) => ({ text, claims: byText.get(text) ?? [] }));
}

function AnswerCard({ contract }: Readonly<{ contract: AnswerContract }>) {
  const { abstained, answer, claims, sources } = contract;
  const grouped = foldRepeated(claims);
  // The served text is what the service composed and it is shown verbatim.
  //
  // The service distinguishes four abstentions that mean different things: conflicting
  // documents, documents that are not consistent, not enough evidence, and a refusal with
  // no stated reason (``REFUSAL_BY_PART`` plus ``UNNAMED_REFUSAL`` in ``compose.py``). A
  // UI that replaced those with one "no evidence found" sentence would tell a user that
  // two documents contradicted each other when in fact none were found - which is the same
  // flattening this project refused in Part 12 and Part 14. The line breaks the service
  // uses are the boundaries, and they survive as separate lines.
  //
  // What *is* folded is the claim list below, and only that: two claims with identical text
  // are listed once with both citations, because the citations are the part a reader checks.
  const abstainedAlone = abstained && !hasBody(contract);
  return (
    <section className={`answer-card${abstainedAlone ? " abstained" : ""}`} aria-label="پاسخ">
      <h2>{abstainedAlone ? "پاسخی تأیید نشد" : "پاسخ"}</h2>
      {abstained && !abstainedAlone && (
        <p className="answer-partial" role="status">
          این پاسخ کامل نیست. متن زیر دلیل را از خودِ اسناد می‌گوید.
        </p>
      )}
      <p className="answer-text">{answer}</p>
      {claims.length > 0 && (
        <>
          <h3>ادعاها و استنادها</h3>
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
                      <bdi>{claim.source.document_id}</bdi>
                      {" · "}
                      <bdi>{claim.source.section_id}</bdi>
                    </span>
                  ))}
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
      {sources.length > 0 && (
        <>
          <h3>منابع</h3>
          <ul className="answer-sources">
            {sources.map((source) => (
              <li key={`${source.document_id}-${source.section_id}-${source.revision}`}>
                <bdi>{source.document_id}</bdi>
                {" · "}
                <bdi>{source.section_id}</bdi>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
