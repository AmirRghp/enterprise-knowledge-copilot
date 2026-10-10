import { redirect } from "next/navigation";
import { currentIdentity } from "@/lib/auth-server";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ServiceUnavailable } from "@/components/service-unavailable";
import { AskPanel } from "@/components/ask-panel";

export default async function AskPage() {
  let identity;
  try {
    identity = await currentIdentity();
  } catch {
    return <ServiceUnavailable />;
  }
  if (!identity) redirect("/login");
  // Both roles may ask. The authorization boundary is the API's allowlist, and a
  // role check here would only duplicate it — and a duplicate is one that can
  // drift from the real rule.
  return (
    <WorkspaceShell identity={identity} section="ask">
      <AskPanel />
    </WorkspaceShell>
  );
}
