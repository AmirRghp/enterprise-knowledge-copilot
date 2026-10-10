import { useEffect, useState } from "react";
import {
  sourceApiPath,
  sourceContractFrom,
  sourceHandleFrom,
  type SourceSection,
} from "@/lib/document-contract";

export type SourceHandle = { document_id: string; section_id: string; revision: string };

/**
 * What the inspector can show.
 *
 * `loading` is derived from "a handle is being fetched", never stored, so the state cannot
 * disagree with itself: there is no moment where a handle is present and the outcome still
 * says idle.
 */
export type SourceState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "failed" }
  | { kind: "ready"; section: SourceSection };

type Outcome =
  | { kind: "idle" }
  | { kind: "unavailable" }
  | { kind: "failed" }
  | { kind: "ready"; section: SourceSection };

/** Read the three identifiers a citation address carries out of a query string. */
export function handleFromLocation(search: string): SourceHandle | null {
  const params = new URLSearchParams(search);
  return sourceHandleFrom({
    document_id: params.get("document"),
    section_id: params.get("section"),
    revision: params.get("revision"),
  });
}

/** The handle's identity: two handles are the same read only when these three agree. */
const keyOf = (handle: SourceHandle) =>
  `${handle.document_id}|${handle.section_id}|${handle.revision}`;

/**
 * A settled outcome together with the handle it belongs to.
 *
 * The key travels with the result rather than beside it, because a result without one is
 * the defect this type exists to prevent. A page that kept `ready(section)` after the
 * reader opened a different citation would show one document's text under another's
 * heading - a wrong answer presented as a quoted one, which is the failure this whole
 * feature exists to make impossible.
 */
type Keyed = { key: string; outcome: Outcome };

/**
 * The handle, rebuilt only when its three identifiers actually change.
 *
 * `useSearchParams` hands over a fresh object on every navigation, so naming the handle
 * itself as the effect's dependency would refetch on each one even when the reader is
 * looking at the same citation. Naming a derived string instead is the other half of the
 * trap: the effect would then close over whichever handle was in scope when it last ran,
 * which is a stale read wearing a fresh key.
 *
 * Both halves are avoided by making the *object* the dependency and keeping that object
 * stable - so the dependency list and the value the effect reads are always the same
 * handle. The rebuild is a plain conditional assignment during render, which is a value
 * computation, not a side effect: nothing outside this component is touched, and React's
 * own rule about writing refs during render exists because a ref is shared across renders.
 * `useMemo` is the sanctioned form of the same thing and is what this was before it was
 * written out by hand.
 */
function useStableHandle(handle: SourceHandle | null): SourceHandle | null {
  const key = handle ? keyOf(handle) : null;
  const [stable, setStable] = useState<{ key: string; handle: SourceHandle } | null>(
    handle === null || key === null ? null : { key, handle },
  );

  // One conditional set per changed citation, and none at all for a repeat. The comparison
  // is against state rather than a ref so the render that changes it and the render that
  // reads it cannot disagree about which handle is current.
  const current = stable !== null && stable.key === key ? stable : null;
  if (current !== stable) {
    setStable(handle === null || key === null ? null : { key, handle });
  }
  return current !== null ? current.handle : handle;
}

/**
 * Fetch one cited section, once per handle.
 *
 * The handle is passed in rather than read from the location here, so this is a function of
 * its arguments and can be rendered and exercised without a browser. The fetch starts from a
 * microtask so no render is scheduled from the effect body itself.
 */
export function useSourceSection(handle: SourceHandle | null): SourceState {
  const [settled, setSettled] = useState<Keyed | null>(null);
  // The handle arrives as a fresh object on every navigation, so depending on it directly
  // would refetch on each one even when the citation is unchanged - and depending on a
  // derived string while reading `handle` inside would close over whichever handle was in
  // scope when the effect last ran. Both halves are wrong, so the handle is made stable
  // here instead: a new object only when the three identifiers actually differ.
  const stable = useStableHandle(handle);

  useEffect(() => {
    if (!stable) return;
    const handle = stable;
    // Captured once, here, and reused by `commit` below. Reading it from the closure that
    // `commit` was created in is what would let a stale body write under a fresh key; the
    // effect that creates `commit` is the one that owns the handle it commits for.
    const ownKey = keyOf(handle);
    const controller = new AbortController();
    let cancelled = false;
    // The deadline is a real wall-clock bound, and it is composed with the controller so
    // that replacing a handle aborts the read as well as ignoring it. Ignoring is not
    // enough: the request would sit on a connection the reader has already navigated away
    // from.
    //
    // Both endings reach the same `catch`, and they need opposite treatment: a read that
    // was replaced has nothing to say, while a read that ran out of time must tell the
    // reader rather than leave the page saying `loading` for as long as it stays open.
    // `cancelled` is what separates them - it is set by the cleanup, which only a
    // replacement or an unmount runs - so the catch needs no reason and no error name.
    const timeout = setTimeout(() => controller.abort(), 15_000);
    void Promise.resolve().then(async () => {
      // Every write goes through here. The key is re-read at the moment of the write
      // rather than captured earlier, so a result that arrives after the handle changed is
      // dropped instead of overwriting the newer one - including a body awaited *across*
      // the change, which the cancellation flag alone does not cover, because the flag was
      // checked before the read began.
      const commit = (outcome: Outcome) => {
        if (!cancelled) setSettled({ key: ownKey, outcome });
      };
      try {
        const response = await fetch(sourceApiPath(handle), {
          signal: controller.signal,
          cache: "no-store",
        });
        if (cancelled) return;
        // The API answers absent, forbidden and stale with one byte-identical 404, so this
        // branch cannot tell them apart and must not try: an inference drawn from the status
        // would, on the forbidden case, tell the reader the document exists.
        if (response.status === 404) {
          commit({ kind: "unavailable" });
          return;
        }
        if (!response.ok) {
          commit({ kind: "failed" });
          return;
        }
        commit({ kind: "ready", section: sourceContractFrom(await response.json()) });
      } catch {
        // `cancelled` is the only thing that makes a failure ignorable: the effect was
        // cleaned up, so a newer read owns the screen and this one has nothing to say.
        //
        // Everything else is reported, including an abort. The previous version excluded
        // `AbortError` by name, which quietly also excluded the deadline - the one abort
        // the reader needs to hear about - because both arrive as `AbortError`. A read that
        // timed out then left `settled` empty and the hook returned `loading` for the rest
        // of the page's life, with no message and no way to tell it was not still working.
        if (!cancelled) {
          commit({ kind: "failed" });
        }
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [stable]);

  if (handle === null) return { kind: "idle" };
  // A settled outcome is shown only for the handle it was fetched for. A different handle
  // is loading again, however recently the previous one settled - and an outcome for a
  // handle that is no longer on screen is not shown at all.
  if (settled === null || settled.key !== keyOf(handle)) return { kind: "loading" };
  return settled.outcome;
}
