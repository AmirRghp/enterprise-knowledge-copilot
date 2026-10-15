"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { ArrowDown, ArrowUp, GripVertical, Plus } from "lucide-react";
import { ProviderForm } from "./provider-form";
import {
  kindLabels,
  labels,
  parseProviders,
  purposes,
  type Provider,
  type ProviderListing,
  type Purpose,
} from "@/lib/provider-contract";

async function api(path = "", method = "GET", body?: unknown) {
  const response = await fetch(`/api/manager/providers${path}`, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(
      response.status === 409
        ? "تنظیمات تغییر کرده‌اند؛ فهرست را تازه کنید و دوباره تلاش کنید."
        : response.status === 422
          ? "نام، مدل، کلید، آدرس و سازگاری embedding را بررسی کنید."
          : response.status === 503
            ? "تنظیمات یا کلید رمزگذاری سرور آماده نیست؛ راهنمای راه‌اندازی را بررسی کنید."
            : "درخواست انجام نشد؛ اتصال و نشست خود را بررسی کنید.",
    );
  return response.status === 204 ? null : response.json();
}
export function ManagerProviders() {
  const [reindex, setReindex] = useState<{
    status: string;
    percent: number;
    target_provider_id: string;
  } | null>(null);
  const [switching, setSwitching] = useState<{
    provider: Provider;
    total: number;
    documents: number;
  } | null>(null);
  const [data, setData] = useState<ProviderListing | null>(null);
  const [purpose, setPurpose] = useState<Purpose>("chat");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Provider | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Provider | null>(null);
  const drag = useRef<{ id: string; pointer: number; target: string } | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(parseProviders(await api()));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    api()
      .then((value) => {
        if (active) setData(parseProviders(value));
      })
      .catch((error) => {
        if (active) setError((error as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const result = await api("/embedding/reindex");
        if (active) setReindex(result.job);
        if (active && result.job?.status === "completed") setData(parseProviders(await api()));
      } catch {
        /* The main error area covers explicit actions. */
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);
  const chain = data?.[purpose];
  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reorder(id: string, target: string) {
    if (!data || !chain || id === target || busy) return;
    const before = data;
    const items = [...chain.providers];
    const from = items.findIndex((p) => p.id === id);
    const to = items.findIndex((p) => p.id === target);
    if (from < 0 || to < 0) return;
    items.splice(to, 0, items.splice(from, 1)[0]);
    setData({
      ...data,
      [purpose]: { ...chain, providers: items.map((p, i) => ({ ...p, priority: i })) },
    });
    await perform(async () => {
      try {
        setData(
          parseProviders(
            await api(`/${purpose}/order`, "PUT", {
              version: chain.version,
              ids: items.map((p) => p.id),
            }),
          ),
        );
        setNotice("ترتیب اولویت ذخیره شد.");
      } catch (error) {
        setData(before);
        throw error;
      }
    });
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>, provider: Provider) {
    if (busy || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: provider.id, pointer: event.pointerId, target: provider.id };
    setDragged(provider.id);
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!drag.current || event.pointerId !== drag.current.pointer) return;
    const element = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-provider-id]");
    if (element?.dataset.providerId) drag.current.target = element.dataset.providerId;
  }
  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    drag.current = null;
    setDragged(null);
    if (current && event.pointerId === current.pointer) void reorder(current.id, current.target);
  }
  return (
    <section className="provider-page" aria-labelledby="providers-title">
      <div className="provider-page-heading">
        <div>
          <p className="provider-eyebrow">مدیریت فضای دانش</p>
          <h1 id="providers-title">ارائه‌دهندگان</h1>
          <p className="provider-muted">
            اتصال‌های هر بخش را اضافه کنید. مدل embedding فعال را پس از تست انتخاب کنید.
          </p>
        </div>
        <button
          className="button button-secondary"
          disabled={loading || busy}
          onClick={() => void refresh()}
        >
          تازه‌سازی
        </button>
      </div>
      <div className="provider-tabs" role="tablist" aria-label="بخش‌های ارائه‌دهنده" dir="rtl">
        {purposes.map((p, index) => (
          <button
            key={p}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`provider-tab-${p}`}
            aria-controls={`provider-panel-${p}`}
            aria-selected={purpose === p}
            tabIndex={purpose === p ? 0 : -1}
            disabled={busy || editing !== undefined}
            onClick={() => {
              setPurpose(p);
              setError("");
              setNotice("");
              setDeleting(null);
            }}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowLeft") next = (index + 1) % 3;
              else if (event.key === "ArrowRight") next = (index + 2) % 3;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = 2;
              else return;
              event.preventDefault();
              setPurpose(purposes[next]);
              tabs.current[next]?.focus();
            }}
          >
            {labels[p]}
          </button>
        ))}
      </div>
      {error && (
        <p className="provider-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="provider-notice" role="status">
          {notice}
        </p>
      )}
      <div
        role="tabpanel"
        id={`provider-panel-${purpose}`}
        aria-labelledby={`provider-tab-${purpose}`}
        className="provider-panel"
      >
        <div className="provider-section-heading">
          <div>
            <h2>اتصال‌های {labels[purpose]}</h2>
            <p className="provider-help">
              {purpose === "embedding"
                ? "تنها مدل فعال برای اسناد و جست‌وجو استفاده می‌شود."
                : "اولویت از بالا به پایین است؛ هنگام خطای سرویس، اتصال بعدی امتحان می‌شود."}
            </p>
            <p className="provider-help">
              برای مدل‌های محلی،{" "}
              <a
                className="provider-guide-link"
                href="https://github.com/AmirRghp/enterprise-knowledge-copilot/blob/main/ollama-setup.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                راهنمای اتصال Ollama
              </a>{" "}
              را ببینید.
            </p>
          </div>
          <button
            className="button button-primary"
            disabled={!chain || busy || loading}
            onClick={() => setEditing(null)}
          >
            <Plus size={16} aria-hidden="true" /> افزودن
          </button>
        </div>
        {purpose === "rerank" && chain && (
          <label className="provider-toggle">
            <input
              type="checkbox"
              checked={chain.enabled}
              disabled={busy || loading || (!chain.enabled && !chain.providers.length)}
              onChange={(event) =>
                void perform(async () => {
                  setData(
                    parseProviders(
                      await api("/rerank", "PATCH", {
                        version: chain.version,
                        enabled: event.target.checked,
                      }),
                    ),
                  );
                })
              }
            />
            بازرتبه‌بندی فعال باشد
            <span className="provider-help">
              در حالت خاموش، هیچ درخواستی به reranker ارسال نمی‌شود.
            </span>
          </label>
        )}
        {loading ? (
          <p role="status">در حال دریافت اتصال‌ها…</p>
        ) : chain && !chain.providers.length ? (
          <div className="provider-empty">
            <h3>هنوز اتصالی ثبت نشده است</h3>
            <p>با «افزودن»، اولین اتصال این بخش را ثبت کنید.</p>
          </div>
        ) : (
          <ol className="provider-list">
            {chain?.providers.map((provider, index) => (
              <li
                key={provider.id}
                data-provider-id={provider.id}
                className={`provider-row ${dragged === provider.id ? "provider-dragged" : ""}`}
              >
                <button
                  className="provider-grip"
                  type="button"
                  disabled={busy || purpose === "embedding"}
                  aria-label={`جابه‌جایی ${provider.name}؛ برای صفحه‌کلید از بالاتر و پایین‌تر استفاده کنید`}
                  onPointerDown={(event) => startDrag(event, provider)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={() => {
                    drag.current = null;
                    setDragged(null);
                  }}
                >
                  <GripVertical size={20} aria-hidden="true" />
                </button>
                <span className="provider-priority">{(index + 1).toLocaleString("fa-IR")}</span>
                <div className="provider-row-content">
                  <h3>{provider.name}</h3>
                  <p>
                    <bdi>{kindLabels[provider.kind]}</bdi>
                    <span aria-hidden="true"> · </span>
                    <bdi>{provider.model}</bdi>
                  </p>
                  <span className="provider-test-status">
                    {provider.test_status === "passed"
                      ? "آخرین تست موفق بود"
                      : provider.test_status === "failed"
                        ? "آخرین تست ناموفق بود"
                        : "هنوز تست نشده"}
                    {purpose === "embedding"
                      ? chain.active_provider_id === provider.id
                        ? " · مدل فعال"
                        : " · غیرفعال"
                      : index === 0
                        ? " · اولویت اول"
                        : " · اتصال جایگزین"}
                  </span>
                </div>
                <div className="provider-row-actions">
                  {purpose === "embedding" && chain.active_provider_id !== provider.id && (
                    <button
                      className="button button-primary"
                      disabled={
                        busy ||
                        provider.test_status !== "passed" ||
                        ["pending", "running"].includes(reindex?.status ?? "")
                      }
                      onClick={() =>
                        void perform(async () => {
                          const result = await api(`/embedding/${provider.id}/activate`, "POST", {
                            version: chain.version,
                            confirmed: false,
                          });
                          if (result.requires_confirmation)
                            setSwitching({
                              provider,
                              total: result.total,
                              documents: result.documents,
                            });
                          else {
                            await refresh();
                            setNotice("مدل embedding فعال شد.");
                          }
                        })
                      }
                    >
                      انتخاب به‌عنوان پیش‌فرض
                    </button>
                  )}
                  <button
                    className="button button-secondary"
                    disabled={busy || purpose === "embedding" || index === 0}
                    aria-label={`بالاتر بردن ${provider.name}`}
                    onClick={() => void reorder(provider.id, chain.providers[index - 1].id)}
                  >
                    <ArrowUp size={16} aria-hidden="true" />
                  </button>
                  <button
                    className="button button-secondary"
                    disabled={
                      busy || purpose === "embedding" || index === chain.providers.length - 1
                    }
                    aria-label={`پایین‌تر بردن ${provider.name}`}
                    onClick={() => void reorder(provider.id, chain.providers[index + 1].id)}
                  >
                    <ArrowDown size={16} aria-hidden="true" />
                  </button>
                  <button
                    className="button button-secondary"
                    disabled={
                      busy || (purpose === "embedding" && chain.active_provider_id === provider.id)
                    }
                    onClick={() => setEditing(provider)}
                  >
                    ویرایش
                  </button>
                  <button
                    className="button button-secondary"
                    disabled={
                      busy || (purpose === "embedding" && chain.active_provider_id === provider.id)
                    }
                    onClick={() =>
                      void perform(async () => {
                        const result = await api(`/${purpose}/${provider.id}/test`, "POST", {
                          version: chain.version,
                        });
                        await refresh();
                        setNotice(
                          result.status === "passed"
                            ? "تست اتصال موفق بود."
                            : "تست ناموفق بود؛ مدل، کلید و آدرس را بررسی کنید.",
                        );
                      })
                    }
                  >
                    تست اتصال
                  </button>
                  <button
                    className="provider-delete"
                    disabled={busy}
                    onClick={() => setDeleting(provider)}
                  >
                    حذف
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="provider-help provider-footnote">
          تست اتصال فقط دادهٔ ساختگی ارسال می‌کند و ممکن است اعتبار مصرف کند. موفقیت تست، کیفیت
          پاسخ‌های آینده را تضمین نمی‌کند.
        </p>
        {purpose === "embedding" && reindex && (
          <div className="provider-reindex" role="status" aria-live="polite">
            <div
              className="provider-reindex-ring"
              style={{ "--progress": `${reindex.percent}%` } as CSSProperties}
              aria-label={`${reindex.percent.toLocaleString("fa-IR")} درصد`}
            >
              {reindex.percent.toLocaleString("fa-IR")}٪
            </div>
            <p>
              {reindex.status === "completed"
                ? "پروسه تکمیل شد"
                : reindex.status === "failed"
                  ? "بازسازی ناموفق بود؛ index قبلی حفظ شد."
                  : "در حال بازسازی index…"}
            </p>
          </div>
        )}
      </div>
      {editing !== undefined && chain && (
        <ProviderForm
          purpose={purpose}
          provider={editing}
          onClose={() => setEditing(undefined)}
          onSave={async (values) => {
            setData(
              parseProviders(
                await api(
                  `/${purpose}${editing ? "/" + editing.id : ""}`,
                  editing ? "PUT" : "POST",
                  { ...values, version: chain.version },
                ),
              ),
            );
            setNotice("اتصال ذخیره شد؛ اکنون می‌توانید آن را تست کنید.");
          }}
        />
      )}
      {deleting && chain && (
        <div className="provider-delete-confirm" role="group" aria-label="تأیید حذف اتصال">
          <p>اتصال «{deleting.name}» حذف شود؟ اسناد و index حفظ می‌شوند.</p>
          <button
            className="provider-delete"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await api(`/${purpose}/${deleting.id}`, "DELETE", { version: chain.version });
                setDeleting(null);
                await refresh();
                setNotice("اتصال حذف شد.");
              })
            }
          >
            حذف اتصال
          </button>
          <button
            className="button button-secondary"
            disabled={busy}
            onClick={() => setDeleting(null)}
          >
            انصراف
          </button>
        </div>
      )}
      {switching && chain && (
        <ReindexConfirmation
          providerName={switching.provider.name}
          documents={switching.documents}
          total={switching.total}
          busy={busy}
          error={error}
          onClose={() => setSwitching(null)}
          onConfirm={() =>
            void perform(async () => {
              await api(`/embedding/${switching.provider.id}/activate`, "POST", {
                version: chain.version,
                confirmed: true,
              });
              setSwitching(null);
              setReindex({
                status: "pending",
                percent: 0,
                target_provider_id: switching.provider.id,
              });
            })
          }
        />
      )}
    </section>
  );
}

function ReindexConfirmation({
  providerName,
  documents,
  total,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  providerName: string;
  documents: number;
  total: number;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    cancel.current?.focus();
    return () => modal?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="provider-dialog"
      role="alertdialog"
      aria-labelledby="reindex-confirm-title"
      aria-describedby="reindex-confirm-description"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <h2 id="reindex-confirm-title">تأیید بازسازی index</h2>
      <p id="reindex-confirm-description" className="provider-muted">
        با انتخاب «{providerName}»، {documents.toLocaleString("fa-IR")} سند و{" "}
        {total.toLocaleString("fa-IR")} قطعه دوباره به این ارائه‌دهنده فرستاده و embed می‌شوند. این
        کار ممکن است هزینه داشته باشد. تا پایان، جست‌وجو از مدل فعلی استفاده می‌کند.
      </p>
      {error && (
        <p className="provider-error" role="alert">
          {error}
        </p>
      )}
      <div className="provider-dialog-actions">
        <button className="button button-primary" disabled={busy} onClick={onConfirm}>
          {busy ? "در حال آغاز…" : "تأیید و آغاز بازسازی"}
        </button>
        <button ref={cancel} className="button button-secondary" disabled={busy} onClick={onClose}>
          انصراف
        </button>
      </div>
    </dialog>
  );
}
