"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function SessionControls({ expiresAt }: { expiresAt: string }) {
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => router.refresh();
    const timer = setTimeout(
      refresh,
      Math.min(2_147_483_647, Math.max(0, Date.parse(expiresAt) - Date.now())),
    );
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [expiresAt, router]);

  async function logout() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== 204) throw new Error("Logout failed.");
      router.replace("/login");
      router.refresh();
    } catch {
      setError("خروج انجام نشد. دوباره امتحان کنید.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="session-controls">
      <button className="button button-secondary" onClick={logout} disabled={pending}>
        خروج
      </button>
      <span role="status" className="field-help">
        {pending ? "در حال خروج…" : ""}
      </span>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
