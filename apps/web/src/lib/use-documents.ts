import { useEffect, useState } from "react";
import { documentContractFrom, type DocumentSummary } from "@/lib/document-contract";

export type DocumentsState =
  { kind: "loading" } | { kind: "ready"; documents: DocumentSummary[] } | { kind: "failed" };

/**
 * Fetch the authorized document list once, on mount.
 *
 * The load is kicked off through a microtask rather than directly in the effect body. That
 * is not a workaround: a synchronous `setState` from an effect schedules a second render
 * that the first one did not need, and the react-hooks lint rule exists to stop exactly that.
 * Deferring by a microtask lets the effect return its cleanup first, so an unmount before
 * the fetch starts cancels it instead of leaving it to resolve into a dead component.
 */
export function useDocuments(): DocumentsState {
  const [state, setState] = useState<DocumentsState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      try {
        const response = await fetch("/api/documents", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (cancelled) return;
        if (!response.ok) {
          setState({ kind: "failed" });
          return;
        }
        const contract = documentContractFrom(await response.json());
        if (!cancelled) setState({ kind: "ready", documents: contract.documents });
      } catch (error) {
        // An abort is a navigation, not a failure; reporting it would flash an error the
        // reader never caused.
        if (!cancelled && (error as Error).name !== "AbortError") {
          setState({ kind: "failed" });
        }
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return state;
}

export type { DocumentSummary };
