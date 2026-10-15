import { redirect } from "next/navigation";
import { currentIdentity } from "@/lib/auth-server";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ServiceUnavailable } from "@/components/service-unavailable";
import { ManagerRateLimits } from "@/components/manager-rate-limits";
import { ManagerOrganization } from "@/components/manager-organization";

export default async function ManagerSettingsPage() {
  let identity;
  try {
    identity = await currentIdentity();
  } catch {
    return <ServiceUnavailable />;
  }
  if (!identity) redirect("/login");
  if (identity.role !== "manager") redirect("/");
  return (
    <WorkspaceShell identity={identity} section="settings">
      <ManagerOrganization />
      <ManagerRateLimits />
    </WorkspaceShell>
  );
}
