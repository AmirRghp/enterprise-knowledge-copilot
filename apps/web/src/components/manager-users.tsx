"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UserRow } from "./user-row";
import { UserDialog } from "./user-dialog";
import { parseUsers, type UserList, type ManagedUser } from "@/lib/user-contract";

async function readUsers(page: number): Promise<UserList> {
  const response = await fetch(`/api/manager/users?page=${page}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(String(response.status));
  return parseUsers(await response.json());
}

export function ManagerUsers() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ManagedUser | null | undefined>(undefined);
  const [data, setData] = useState<UserList | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const requestId = useRef(0);
  const failed = useCallback(
    (cause: unknown) => {
      if (cause instanceof Error && ["401", "403"].includes(cause.message)) {
        router.replace(cause.message === "401" ? "/login" : "/");
        router.refresh();
      } else setError("فهرست حساب‌ها دریافت نشد؛ دوباره تلاش کنید.");
    },
    [router],
  );
  const load = useCallback(
    async (currentPage: number) => {
      const id = ++requestId.current;
      setPending(true);
      setError("");
      try {
        const result = await readUsers(currentPage);
        if (id === requestId.current) setData(result);
      } catch (cause) {
        if (id === requestId.current) failed(cause);
      } finally {
        if (id === requestId.current) setPending(false);
      }
    },
    [failed],
  );
  useEffect(() => {
    let active = true;
    const id = ++requestId.current;
    readUsers(page)
      .then((result) => {
        if (active && id === requestId.current) {
          setData(result);
          setError("");
        }
      })
      .catch((cause) => {
        if (active && id === requestId.current) failed(cause);
      })
      .finally(() => {
        if (active && id === requestId.current) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [page, failed]);
  return (
    <section aria-labelledby="users-title" className="manager-users">
      <p className="eyebrow">مدیریت فضای کاری</p>
      <h1 id="users-title">مدیریت کارکنان</h1>
      <p className="section-description">
        حساب‌ها و سطح دسترسی تیم را مدیریت کنید. آخرین مدیر فعال باید حفظ شود.
      </p>
      <div className="user-toolbar">
        <button className="button button-primary" onClick={() => setEditing(null)}>
          کاربر جدید
        </button>
      </div>
      {editing !== undefined && (
        <UserDialog
          user={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            const creating = editing === null;
            setEditing(undefined);
            setNote(creating ? "کاربر جدید ثبت شد." : "تغییرات کاربر ثبت شد.");
            if (creating) setPage(1);
            await load(creating ? 1 : page);
            router.refresh();
          }}
        />
      )}
      <section className="guide-section" aria-labelledby="user-list-title" aria-busy={pending}>
        <h2 id="user-list-title">حساب‌های کارکنان</h2>
        {note && (
          <p className="field-help" role="status">
            {note}
          </p>
        )}
        {pending && (
          <p role="status" className="field-help">
            در حال دریافت حساب‌ها…
          </p>
        )}
        {error && (
          <div>
            <p role="alert" className="form-error">
              {error}
            </p>
            <button className="button button-secondary" onClick={() => void load(page)}>
              تلاش دوباره
            </button>
          </div>
        )}
        {data && (
          <>
            <p className="field-help">
              {data.total.toLocaleString("fa-IR")} حساب · صفحهٔ {data.page.toLocaleString("fa-IR")}
            </p>
            <ul className="user-list">
              {data.users.map((user) => (
                <UserRow key={user.user_id} user={user} onEdit={() => setEditing(user)} />
              ))}
            </ul>
            <div className="user-pagination">
              <button
                className="button button-secondary"
                disabled={pending || page === 1}
                onClick={() => {
                  setPending(true);
                  setPage(page - 1);
                }}
              >
                صفحهٔ قبل
              </button>
              <button
                className="button button-secondary"
                disabled={pending || page * 50 >= data.total}
                onClick={() => {
                  setPending(true);
                  setPage(page + 1);
                }}
              >
                صفحهٔ بعد
              </button>
            </div>
          </>
        )}
      </section>
    </section>
  );
}
