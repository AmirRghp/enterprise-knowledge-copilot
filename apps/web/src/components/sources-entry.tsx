"use client";

import { DocumentList } from "@/components/document-list";
import { SourceInspector } from "@/components/source-inspector";
import { handleFromLocation } from "@/lib/use-source-section";
import { useSearchParams } from "next/navigation";

/**
 * One page serves both the list and a cited section, because a citation is a URL with
 * three identifiers on it.
 *
 * The split is decided here rather than in the server page: the revision travels as a
 * query parameter, so the server cannot tell a request for the list from a request for one
 * section without the same parsing, and a server that guesses would need to guess twice.
 * All three identifiers present means a citation was followed; anything else means the
 * reader opened the page itself.
 */
export function SourcesEntry({ role }: Readonly<{ role: "employee" | "manager" }>) {
  const params = useSearchParams();
  // The handle is resolved once, here, and passed down. The inspector used to read
  // `window.location` for itself on mount, which froze it at whatever the URL said when the
  // component first appeared: a client-side navigation that changed only the query kept
  // the same component mounted, so the reader would keep seeing the previous citation's
  // text under a link that had moved. `useSearchParams` is the shared source of truth for
  // exactly this - it re-renders on a query change, and it is what decides the split below.
  const handle = handleFromLocation(params.toString());
  return handle === null ? <DocumentList role={role} /> : <SourceInspector handle={handle} />;
}
