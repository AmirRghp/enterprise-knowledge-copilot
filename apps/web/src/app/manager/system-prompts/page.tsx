import { redirect } from "next/navigation";
import { currentIdentity } from "@/lib/auth-server";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ServiceUnavailable } from "@/components/service-unavailable";
import { ManagerSystemPrompts } from "@/components/manager-system-prompts";

export default async function ManagerSystemPromptsPage() {
  let identity;
  try {
    identity = await currentIdentity();
  } catch {
    return <ServiceUnavailable />;
  }
  if (!identity) redirect("/login");
  if (identity.role !== "manager") redirect("/");
  return (
    <WorkspaceShell identity={identity} section="prompts">
      <ManagerSystemPrompts />
    </WorkspaceShell>
  );
}
