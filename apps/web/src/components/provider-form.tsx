"use client";
import { useEffect, useRef, useState } from "react";
import {
  kinds,
  kindLabels,
  supports,
  type Kind,
  type Provider,
  type Purpose,
} from "@/lib/provider-contract";
const NOMIC = "nomic-embed-text-v2-moe:latest";
export function ProviderForm({
  purpose,
  provider,
  onClose,
  onSave,
}: {
  purpose: Purpose;
  provider: Provider | null;
  onClose: () => void;
  onSave: (values: Record<string, unknown>) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(provider?.name ?? "");
  const [kind, setKind] = useState<Kind>(
    provider?.kind ?? (purpose === "rerank" ? "openrouter" : "ollama"),
  );
  const [model, setModel] = useState(provider?.model ?? (purpose === "embedding" ? NOMIC : ""));
  const [url, setUrl] = useState(provider?.base_url ?? "http://127.0.0.1:11434");
  const [key, setKey] = useState("");
  const [digest, setDigest] = useState(provider?.expected_digest ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    const modal = dialog.current;
    modal?.showModal();
    modal?.querySelector<HTMLInputElement>("#provider-name")?.focus();
    return () => {
      modal?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  function changeKind(next: Kind) {
    setKind(next);
    setKey("");
    setDigest("");
    setModel(purpose === "embedding" ? NOMIC : "");
    setUrl(next === "ollama" ? "http://127.0.0.1:11434" : "");
    setError("");
  }
  const storedKey = provider?.kind === kind && provider.has_api_key;
  return (
    <dialog
      ref={dialog}
      className="provider-dialog"
      aria-labelledby="provider-form-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await onSave({
              name: name.trim(),
              kind,
              model: model.trim(),
              base_url: url.trim(),
              api_key: key,
              expected_digest: digest.trim(),
            });
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : "ذخیره انجام نشد.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="provider-dialog-heading">
          <h2 id="provider-form-title">{provider ? "ویرایش اتصال" : "افزودن اتصال"}</h2>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
            aria-label="بستن پنجره"
          >
            بستن
          </button>
        </div>
        <p className="provider-muted">
          اتصال را ذخیره کنید؛ سپس با دادهٔ ساختگی آن را آزمایش کنید.
        </p>
        <fieldset disabled={busy} className="provider-fields">
          <label htmlFor="provider-name">
            نام نمایشی
            <input
              id="provider-name"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثلاً مدل شرکت الف"
            />
          </label>
          <label htmlFor="provider-kind">
            نوع ارائه‌دهنده
            <select
              id="provider-kind"
              value={kind}
              onChange={(e) => changeKind(e.target.value as Kind)}
            >
              {kinds.map((k) => (
                <option key={k} value={k} disabled={!supports(purpose, k)}>
                  {kindLabels[k]}
                  {!supports(purpose, k) ? " — در این بخش پشتیبانی نمی‌شود" : ""}
                </option>
              ))}
            </select>
          </label>
          {(kind === "ollama" || kind === "openai_compatible") && (
            <label htmlFor="provider-url">
              آدرس پایه
              <input
                id="provider-url"
                dir="ltr"
                type="url"
                required
                maxLength={2048}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={
                  kind === "ollama" ? "http://127.0.0.1:11434" : "https://example.com/v1"
                }
              />
              <span className="provider-help">
                آدرس محلی میزبان یا آدرس عمومی HTTPS؛ شبکهٔ داخلی مجاز نیست.
              </span>
            </label>
          )}
          <label htmlFor="provider-model">
            نام مدل
            <input
              id="provider-model"
              dir="ltr"
              required
              maxLength={200}
              readOnly={purpose === "embedding"}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          {kind !== "ollama" && (
            <label htmlFor="provider-key">
              کلید API{kind === "openai_compatible" ? " (اختیاری)" : ""}
              <input
                id="provider-key"
                dir="ltr"
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                required={!storedKey && kind !== "openai_compatible"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              {storedKey && (
                <span className="provider-help">
                  کلید ثبت شده است؛ برای حفظ آن این فیلد را خالی بگذارید.
                </span>
              )}
            </label>
          )}
          {purpose === "embedding" && (
            <>
              <label htmlFor="provider-digest">
                شناسهٔ نسخهٔ مدل (digest)
                <input
                  id="provider-digest"
                  dir="ltr"
                  required
                  minLength={12}
                  maxLength={64}
                  pattern="[0-9a-f]{12,64}"
                  value={digest}
                  onChange={(e) => setDigest(e.target.value)}
                />
                <span className="provider-help">
                  digest از فهرست مدل‌های Ollama؛ باید با نسخهٔ index فعلی یکسان باشد.
                </span>
              </label>
              <p className="provider-help">
                ۷۶۸ بُعد · tokenizer و پیشوندهای Nomic · بدون کوتاه‌سازی ورودی
              </p>
            </>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="provider-error">
            {error}
          </p>
        )}
        <div className="provider-dialog-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "در حال ذخیره…" : "ذخیره اتصال"}
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            انصراف
          </button>
        </div>
      </form>
    </dialog>
  );
}
