import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentIdentity } from "@/lib/auth-server";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ServiceUnavailable } from "@/components/service-unavailable";
import { SourcesEntry } from "@/components/sources-entry";

export default async function SourcesPage() {
  let identity;
  try {
    identity = await currentIdentity();
  } catch {
    return <ServiceUnavailable />;
  }
  if (!identity) redirect("/login");
  // Both roles get their own list. The API's allowlist decides what is in it, so a role
  // check here would only be a second copy of a rule that already exists and could drift.
  //
  // Suspense because `SourcesEntry` reads the query on the client; without it a request
  // carrying a citation would be deferred to a client render for the whole page.
  return (
    <WorkspaceShell identity={identity} section="sources">
      <Suspense fallback={<p className="ask-hint">در حال آماده‌سازی…</p>}>
        <SourcesEntry role={identity.role} />
      </Suspense>
    </WorkspaceShell>
  );
}
