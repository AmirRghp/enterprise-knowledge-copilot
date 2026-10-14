"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  parseSystemPrompts,
  type SystemPrompt,
  type SystemPromptList,
} from "@/lib/system-prompt-contract";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/manager/system-prompts${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.status === 204 ? null : response.json();
}
const fetchPrompts = async () => parseSystemPrompts(await api(""));

const message = (error: unknown) => {
  if (error instanceof Error) {
    if (error.message === "409")
      return "تنظیم prompt هم‌زمان تغییر کرده؛ فهرست را تازه کنید و دوباره تلاش کنید.";
    if (error.message === "401") return "نشست شما پایان یافته است؛ دوباره وارد شوید.";
    if (error.message === "403") return "برای این تغییر مجاز نیستید.";
    if (error.message === "422")
      return "نام و متن prompt را بررسی کنید؛ متن خالی یا بیش از ۱۶٬۰۰۰ نویسه پذیرفته نیست.";
  }
  return "عملیات انجام نشد؛ دوباره تلاش کنید.";
};

export function ManagerSystemPrompts() {
  const router = useRouter();
  const [data, setData] = useState<SystemPromptList | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<SystemPrompt | null | undefined>(undefined);
  const [activating, setActivating] = useState<SystemPrompt | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setPending(true);
    setError("");
    try {
      setData(await fetchPrompts());
    } catch (cause) {
      if (cause instanceof Error && ["401", "403"].includes(cause.message)) {
        router.replace(cause.message === "401" ? "/login" : "/");
        router.refresh();
      } else setError(message(cause));
    } finally {
      setPending(false);
    }
  }, [router]);

  useEffect(() => {
    let current = true;
    void fetchPrompts()
      .then((prompts) => {
        if (current) setData(prompts);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        if (cause instanceof Error && ["401", "403"].includes(cause.message)) {
          router.replace(cause.message === "401" ? "/login" : "/");
          router.refresh();
        } else setError(message(cause));
      })
      .finally(() => {
        if (current) setPending(false);
      });
    return () => {
      current = false;
    };
  }, [router]);

  async function activatePrompt(prompt: SystemPrompt) {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    try {
      setData(
        parseSystemPrompts(
          await api(`/${prompt.prompt_id}/activate`, "POST", {
            version: data.version,
            confirmed: true,
          }),
        ),
      );
      setNotice(`«${prompt.name}» برای چت فعال شد.`);
      setActivating(null);
    } catch (cause) {
      setError(message(cause));
      if (cause instanceof Error && cause.message === "409") await load();
    } finally {
      setBusy(false);
    }
  }

  async function savePrompt(values: { name: string; prompt_text: string; confirmed: boolean }) {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    try {
      if (editing) {
        await api(`/${editing.prompt_id}`, "PUT", {
          ...values,
          version: data.version,
          revision: editing.revision,
        });
        setNotice("تغییرات prompt ثبت شد.");
      } else {
        const { name, prompt_text } = values;
        await api("", "POST", { name, prompt_text });
        setNotice("prompt جدید ثبت شد و تا زمان انتخاب، غیرفعال می‌ماند.");
      }
      setEditing(undefined);
      await load();
    } catch (cause) {
      setError(message(cause));
      if (cause instanceof Error && cause.message === "409") await load();
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="provider-page manager-prompts" aria-labelledby="prompts-title">
      <p className="provider-eyebrow">تنظیمات چت</p>
      <div className="provider-page-heading">
        <div>
          <h1 id="prompts-title">سیستم‌پرامپت‌ها</h1>
          <p className="provider-muted">
            prompt فعال برای همهٔ مدیرها و چت‌های این نصب مشترک است. prompt سفارشی فقط به دستورهای
            ثابت پاسخ‌دهی اضافه می‌شود.
          </p>
        </div>
        <button
          className="button button-primary"
          onClick={() => setEditing(null)}
          disabled={pending || !data}
        >
          افزودن سیستم‌پرامپت
        </button>
      </div>

      {editing !== undefined && data && (
        <PromptEditor
          prompt={editing}
          active={Boolean(editing?.is_active)}
          busy={busy}
          onClose={() => setEditing(undefined)}
          onSave={savePrompt}
        />
      )}
      {activating && (
        <PromptActivationDialog
          prompt={activating}
          busy={busy}
          onClose={() => setActivating(null)}
          onConfirm={() => void activatePrompt(activating)}
        />
      )}

      {notice && (
        <p role="status" className="provider-notice">
          {notice}
        </p>
      )}
      {error && (
        <div>
          <p role="alert" className="form-error">
            {error}
          </p>
          <button className="button button-secondary" onClick={() => void load()}>
            تلاش دوباره
          </button>
        </div>
      )}
      {pending && (
        <p role="status" className="field-help">
          در حال دریافت سیستم‌پرامپت‌ها…
        </p>
      )}
      {data && (
        <ul className="user-list prompt-list" aria-busy={pending}>
          {data.prompts.map((prompt) => (
            <li className="user-row prompt-row" key={prompt.prompt_id}>
              <div className="provider-section-heading">
                <h2>{prompt.name}</h2>
                <span className="status-badge">
                  {prompt.is_active ? "فعال" : "غیرفعال"}
                  {prompt.is_default ? " · پیش‌فرض" : " · سفارشی"}
                </span>
              </div>
              <p className="prompt-preview" dir="auto">
                {prompt.prompt_text}
              </p>
              <div className="prompt-actions">
                {prompt.can_edit && (
                  <button
                    className="button button-secondary"
                    onClick={() => setEditing(prompt)}
                    disabled={busy}
                  >
                    ویرایش
                  </button>
                )}
                {!prompt.is_active && (
                  <button
                    className="button button-primary"
                    onClick={() => setActivating(prompt)}
                    disabled={busy}
                  >
                    فعال‌کردن برای چت
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PromptEditor({
  prompt,
  active,
  busy,
  onClose,
  onSave,
}: {
  prompt: SystemPrompt | null;
  active: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (values: { name: string; prompt_text: string; confirmed: boolean }) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(prompt?.name ?? "");
  const [promptText, setPromptText] = useState(prompt?.prompt_text ?? "");
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    const modal = dialog.current;
    modal?.showModal();
    modal?.querySelector<HTMLInputElement>("#system-prompt-name")?.focus();
    return () => {
      modal?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="provider-dialog"
      aria-labelledby="system-prompt-editor-title"
      aria-describedby="system-prompt-editor-help"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setError("");
          try {
            await onSave({ name: name.trim(), prompt_text: promptText, confirmed: active });
            onClose();
          } catch (cause) {
            setError(message(cause));
          }
        }}
      >
        <div className="provider-dialog-heading">
          <h2 id="system-prompt-editor-title">
            {prompt ? "ویرایش سیستم‌پرامپت" : "افزودن سیستم‌پرامپت"}
          </h2>
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            بستن
          </button>
        </div>
        <p id="system-prompt-editor-help" className="provider-muted">
          این متن به قواعد ثابت شواهد و استناد افزوده می‌شود. سقف متن ۱۶٬۰۰۰ نویسه است.
          {active
            ? " این prompt فعال است؛ ذخیره بر پاسخ‌دهی چت اثر می‌گذارد و نیازمند تأیید است."
            : " prompt تازه پس از ذخیره غیرفعال می‌ماند."}
        </p>
        <fieldset className="provider-fields" disabled={busy}>
          <label htmlFor="system-prompt-name">
            نام نمایشی
            <input
              id="system-prompt-name"
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label htmlFor="system-prompt-text">
            دستورهای تکمیلی
            <textarea
              id="system-prompt-text"
              required
              maxLength={16_000}
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
            />
          </label>
          <p className="field-help">{promptText.length.toLocaleString("fa-IR")} / ۱۶٬۰۰۰ نویسه</p>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="provider-dialog-actions">
          <button
            className="button button-primary"
            disabled={busy || !name.trim() || !promptText.trim()}
          >
            {busy ? "در حال ذخیره…" : active ? "تأیید و ذخیرهٔ تغییر" : "ذخیرهٔ prompt"}
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            انصراف
          </button>
        </div>
      </form>
    </dialog>
  );
}

function PromptActivationDialog({
  prompt,
  busy,
  onClose,
  onConfirm,
}: {
  prompt: SystemPrompt;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const modal = dialog.current;
    modal?.showModal();
    modal?.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
    return () => {
      modal?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="provider-dialog"
      aria-labelledby="system-prompt-confirm-title"
      aria-describedby="system-prompt-confirm-copy"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <div className="provider-dialog-heading">
        <h2 id="system-prompt-confirm-title">تغییر سیستم‌پرامپت</h2>
        <button className="button button-secondary" onClick={onClose} disabled={busy}>
          بستن
        </button>
      </div>
      <p id="system-prompt-confirm-copy">
        با فعال‌کردن «{prompt.name}»، prompt قبلی جایگزین می‌شود. این تغییر روی نحوهٔ پاسخ‌دهی مدل
        در همهٔ چت‌های این نصب اثر می‌گذارد.
      </p>
      <div className="provider-dialog-actions">
        <button className="button button-primary" onClick={onConfirm} disabled={busy}>
          {busy ? "در حال فعال‌سازی…" : "تأیید و فعال‌سازی"}
        </button>
        <button data-cancel className="button button-secondary" onClick={onClose} disabled={busy}>
          انصراف
        </button>
      </div>
    </dialog>
  );
}
