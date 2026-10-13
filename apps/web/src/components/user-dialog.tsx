"use client";
import { useEffect, useRef, useState } from "react";
import type { ManagedUser } from "@/lib/user-contract";
import { UserForm } from "./user-form";

export function UserDialog({
  user,
  onClose,
  onSaved,
}: Readonly<{
  user: ManagedUser | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}>) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    const modal = dialog.current;
    modal?.showModal();
    modal?.querySelector<HTMLInputElement>("#account-first-name")?.focus();
    return () => {
      modal?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="provider-dialog account-dialog"
      aria-labelledby="user-dialog-title"
      onCancel={(event) => {
        if (pending) event.preventDefault();
        else onClose();
      }}
    >
      <div className="provider-dialog-heading">
        <h2 id="user-dialog-title">{user ? "ویرایش کاربر" : "کاربر جدید"}</h2>
        <button
          type="button"
          className="button button-secondary"
          aria-label="بستن پنجره"
          disabled={pending}
          onClick={onClose}
        >
          بستن
        </button>
      </div>
      <UserForm
        user={user ?? undefined}
        onSaved={onSaved}
        onPendingChange={setPending}
        onCancel={onClose}
      />
    </dialog>
  );
}
