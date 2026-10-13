"use client";
import type { ManagedUser } from "@/lib/user-contract";

export function UserRow({ user, onEdit }: Readonly<{ user: ManagedUser; onEdit: () => void }>) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return (
    <li className="user-row">
      <div className="user-heading">
        <div className="user-identifiers">
          <h3>
            <bdi>{name || user.login}</bdi>
          </h3>
          {name && (
            <p className="field-help">
              <bdi>{user.login}</bdi>
            </p>
          )}
        </div>
        <span>
          {user.role === "manager" ? "مدیر" : "کارمند"} · {user.is_active ? "فعال" : "غیرفعال"}
        </span>
        <button
          className="button button-secondary"
          onClick={onEdit}
          aria-label={`ویرایش ${name || user.login}`}
        >
          ویرایش
        </button>
      </div>
    </li>
  );
}
