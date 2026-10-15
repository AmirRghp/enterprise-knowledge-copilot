"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PromptComposer } from "@/components/prompt-composer";
import {
  answerContractFrom,
  type AnswerContract,
  type Citation,
  type Claim,
} from "@/lib/answer-contract";
import { sourcePath } from "@/lib/document-contract";

const MAX_QUESTION_CHARS = 2000;
type Chat = { conversation_id: string; title: string; updated_at: string };
type Turn = {
  turn_id: string;
  question: string;
  status: "pending" | "answered" | "failed" | "cancelled";
  result?: AnswerContract | null;
  source_unavailable?: boolean;
};
const NO_STORE = { cache: "no-store" as RequestCache };

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
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
      {source.document_title ?? source.document_id} · {source.section_title ?? source.section_id}
      <span className="source-hint"> (در تب تازه باز می‌شود)</span>
    </a>
  );
}

function AnswerCard({ contract }: Readonly<{ contract: AnswerContract }>) {
  const grouped = foldRepeated(contract.claims);
  const abstainedAlone = contract.abstained && !contract.claims.length && !contract.sources.length;
  return (
    <section
      className={`assistant-message answer-card${abstainedAlone ? " abstained" : ""}`}
      aria-label="پاسخ دستیار"
    >
      <span className="chat-speaker">دستیار</span>
      {contract.abstained && !abstainedAlone && (
        <p className="answer-partial" role="status">
          این پاسخ کامل نیست. محدودیت اسناد در دسترس در متن پاسخ آمده است.
        </p>
      )}
      <p className="answer-text">{contract.answer}</p>
      {grouped.length > 0 && (
        <div className="answer-claims">
          {grouped.map((group) => (
            <article key={group.text} className="claim">
              <p className="claim-text">{group.text}</p>
              {group.claims.map((claim, index) => (
                <div key={`${claim.source.document_id}-${claim.source.section_id}-${index}`}>
                  <p className="claim-source">
                    <SourceLink source={claim.source} />
                  </p>
                  <details className="claim-detail">
                    <summary>نقل‌قول منبع</summary>
                    <blockquote className="claim-quote">{claim.quote}</blockquote>
                  </details>
                </div>
              ))}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function AskPanel() {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatCursor, setChatCursor] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Chat | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [turnCursor, setTurnCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const inputId = useId();
  const countId = useId();
  const endRef = useRef<HTMLLIElement>(null);
  const sending = useRef(false);
  const busy = turns.some((turn) => turn.status === "pending");

  const loadChats = useCallback(async (cursor?: string) => {
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const result = await json<{ conversations: Chat[]; next_cursor: string | null }>(
        await fetch(`/api/conversations?${query}`, NO_STORE),
      );
      setChats((current) =>
        cursor ? [...current, ...result.conversations] : result.conversations,
      );
      setChatCursor(result.next_cursor);
    } catch {
      setMessage("فهرست گفت‌وگوها بارگذاری نشد. صفحه را تازه کنید.");
    }
  }, []);

  const openChat = useCallback(async (id: string, cursor?: string) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const data = await json<{
        conversation: Chat;
        turns: (Turn & { result?: unknown })[];
        next_cursor: string | null;
      }>(await fetch(`/api/conversations/${id}?${query}`, NO_STORE));
      const normalized = data.turns.map((turn) => ({
        ...turn,
        result: turn.result ? answerContractFrom(turn.result) : null,
      }));
      setConversation(data.conversation);
      setTurns((current) => (cursor ? [...normalized, ...current] : normalized));
      setTurnCursor(data.next_cursor);
      setMessage("");
    } catch {
      setMessage("این گفت‌وگو بارگذاری نشد یا دیگر در دسترس نیست.");
      if (!cursor) setConversation(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadChats();
      const id = new URLSearchParams(window.location.search).get("conversationId");
      if (id) await openChat(id);
      else setLoading(false);
    })();
  }, [loadChats, openChat]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  useEffect(() => {
    if (!busy || !conversation) return;
    const timer = window.setInterval(() => void openChat(conversation.conversation_id), 1200);
    return () => window.clearInterval(timer);
  }, [busy, conversation, openChat]);

  const send = useCallback(async () => {
    const prompt = question.trim();
    if (!prompt || prompt.length > MAX_QUESTION_CHARS || sending.current) return;
    sending.current = true;
    setQuestion("");
    setMessage("");
    try {
      if (!conversation) {
        const created = await json<{ conversation: Chat; turn: Turn }>(
          await fetch("/api/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: prompt }),
          }),
        );
        setConversation(created.conversation);
        setTurns([created.turn]);
        router.replace(`/ask?conversationId=${created.conversation.conversation_id}`);
        await loadChats();
      } else {
        const added = await json<{ turn: Turn }>(
          await fetch(`/api/conversations/${conversation.conversation_id}/turns`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: prompt }),
          }),
        );
        setTurns((current) => [...current, added.turn]);
        await loadChats();
      }
    } catch {
      setQuestion(prompt);
      setMessage("پرسش ثبت نشد. اتصال را بررسی کنید و دوباره تلاش کنید.");
    } finally {
      sending.current = false;
    }
  }, [conversation, loadChats, question, router]);

  async function mutateTurn(turn: Turn, action: "retry" | "cancel") {
    if (!conversation) return;
    try {
      const updated = await json<{ turn: Turn }>(
        await fetch(
          `/api/conversations/${conversation.conversation_id}/turns/${turn.turn_id}/${action}`,
          { method: "POST" },
        ),
      );
      setTurns((current) =>
        current.map((item) => (item.turn_id === turn.turn_id ? updated.turn : item)),
      );
    } catch {
      setMessage("وضعیت درخواست به‌روز نشد. دوباره تلاش کنید.");
    }
  }

  async function saveTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conversation || !titleDraft.trim()) return;
    try {
      const result = await json<{ conversation: Chat }>(
        await fetch(`/api/conversations/${conversation.conversation_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: titleDraft.trim() }),
        }),
      );
      setConversation(result.conversation);
      setChats((current) =>
        current.map((chat) =>
          chat.conversation_id === result.conversation.conversation_id ? result.conversation : chat,
        ),
      );
      setRenaming(false);
    } catch {
      setMessage("تغییر نام ذخیره نشد.");
    }
  }

  async function removeChat(chat: Chat) {
    if (!window.confirm("این گفت‌وگو و پیام‌هایش برای همیشه حذف شود؟")) return;
    try {
      const result = await fetch(`/api/conversations/${chat.conversation_id}`, {
        method: "DELETE",
      });
      if (!result.ok) throw new Error("delete failed");
      setChats((current) =>
        current.filter((item) => item.conversation_id !== chat.conversation_id),
      );
      if (conversation?.conversation_id === chat.conversation_id) startNew();
    } catch {
      setMessage("حذف گفت‌وگو انجام نشد.");
    }
  }

  function startNew() {
    setConversation(null);
    setTurns([]);
    setQuestion("");
    setMessage("");
    router.replace("/ask");
  }

  const tooLong = question.trim().length > MAX_QUESTION_CHARS;

  return (
    <div className="ask-workspace">
      <aside className="ask-sidebar" aria-label="گفت‌وگوهای قبلی">
        <button className="ask-new-chat" type="button" onClick={startNew}>
          گفت‌وگوی تازه
        </button>
        <h2>گفت‌وگوها</h2>
        <ul className="ask-chat-list">
          {chats.map((chat) => (
            <li
              key={chat.conversation_id}
              className={conversation?.conversation_id === chat.conversation_id ? "selected" : ""}
            >
              {renaming && conversation?.conversation_id === chat.conversation_id ? (
                <form onSubmit={saveTitle}>
                  <label className="ask-sr-only" htmlFor="chat-title">
                    نام گفت‌وگو
                  </label>
                  <input
                    id="chat-title"
                    value={titleDraft}
                    maxLength={100}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    autoFocus
                  />
                  <button type="submit">ذخیره</button>
                  <button type="button" onClick={() => setRenaming(false)}>
                    لغو
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="ask-chat-select"
                    onClick={() => {
                      router.replace(`/ask?conversationId=${chat.conversation_id}`);
                      void openChat(chat.conversation_id);
                    }}
                  >
                    {chat.title}
                  </button>
                  {conversation?.conversation_id === chat.conversation_id && (
                    <div className="ask-chat-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setTitleDraft(chat.title);
                          setRenaming(true);
                        }}
                      >
                        تغییر نام
                      </button>
                      <button type="button" onClick={() => void removeChat(chat)}>
                        حذف
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        {chatCursor && (
          <button
            type="button"
            className="ask-load-more"
            onClick={() => void loadChats(chatCursor)}
          >
            گفت‌وگوهای قدیمی‌تر
          </button>
        )}
      </aside>

      <div className="ask-view">
        <header className="ask-heading">
          <div>
            <h1>{conversation?.title ?? "پرسش از اسناد سازمانی"}</h1>
            <p>پاسخ‌ها از اسنادی ساخته می‌شوند که به نقش شما دسترسی دارند.</p>
          </div>
        </header>
        {message && (
          <p className="ask-inline-error" role="alert">
            {message}
          </p>
        )}
        <ol
          className="ask-messages"
          aria-label="پیام‌های گفت‌وگو"
          aria-live="polite"
          aria-busy={busy}
        >
          {turnCursor && (
            <li>
              <button
                className="ask-load-more"
                type="button"
                onClick={() =>
                  conversation && void openChat(conversation.conversation_id, turnCursor)
                }
              >
                پیام‌های قدیمی‌تر
              </button>
            </li>
          )}
          {loading && turns.length === 0 && (
            <li className="ask-empty" role="status">
              در حال بارگذاری گفت‌وگو…
            </li>
          )}
          {turns.map((turn) => (
            <li className="ask-turn" key={turn.turn_id}>
              <div className="ask-user-message">
                <span className="chat-speaker">شما</span>
                <p>{turn.question}</p>
              </div>
              {turn.status === "pending" && (
                <div className="assistant-message ask-waiting" role="status">
                  <span className="chat-speaker">دستیار</span>
                  <span className="ask-waiting-line">
                    <span className="ask-spinner" aria-hidden="true" />
                    در حال بررسی اسناد و آماده‌کردن پاسخ…
                  </span>
                  <button
                    type="button"
                    className="ask-retry"
                    onClick={() => void mutateTurn(turn, "cancel")}
                  >
                    لغو
                  </button>
                </div>
              )}
              {turn.status === "answered" && turn.source_unavailable && (
                <div className="assistant-message ask-failed" role="status">
                  <span className="chat-speaker">دستیار</span>
                  <p>منبع این پاسخ دیگر در دسترس یا جاری نیست؛ متن پاسخ پنهان شده است.</p>
                </div>
              )}
              {turn.status === "answered" && !turn.source_unavailable && turn.result && (
                <AnswerCard contract={turn.result} />
              )}
              {(turn.status === "failed" || turn.status === "cancelled") && (
                <div className="assistant-message ask-failed" role="alert">
                  <span className="chat-speaker">دستیار</span>
                  <p>
                    {turn.status === "cancelled"
                      ? "درخواست لغو شد."
                      : "پاسخی آماده نشد. می‌توانید همین پرسش را دوباره اجرا کنید."}
                  </p>
                  <button
                    type="button"
                    className="ask-retry"
                    onClick={() => void mutateTurn(turn, "retry")}
                  >
                    تلاش دوباره
                  </button>
                </div>
              )}
            </li>
          ))}
          {turns.length === 0 && !loading && (
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
        <form
          className="ask-form"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void send();
          }}
          aria-busy={busy}
        >
          <label className="ask-sr-only" htmlFor={inputId}>
            پرسش شما
          </label>
          <PromptComposer
            id={inputId}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="پیام خود را بنویسید…"
            rows={2}
            maxLength={MAX_QUESTION_CHARS}
            required
            aria-describedby={countId}
            aria-invalid={tooLong || undefined}
            isLoading={busy}
            onSend={() => void send()}
          />
          <div className="ask-composer-meta">
            <p id={countId} className={tooLong ? "ask-count over" : "ask-count"}>
              <bdi dir="ltr">{question.trim().length}</bdi> از{" "}
              <bdi dir="ltr">{MAX_QUESTION_CHARS}</bdi> نویسه
            </p>
          </div>
          <p className="ask-composer-note">
            گفت‌وگوها به حساب شما متصل‌اند و پس از خروج نیز باقی می‌مانند.
          </p>
        </form>
      </div>
    </div>
  );
}
