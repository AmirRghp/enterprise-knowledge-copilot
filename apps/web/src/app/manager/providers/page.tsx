import { redirect } from "next/navigation";
import { currentIdentity } from "@/lib/auth-server";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ServiceUnavailable } from "@/components/service-unavailable";
import { ManagerProviders } from "@/components/manager-providers";
export default async function ManagerProvidersPage() {
  let identity;
  try {
    identity = await currentIdentity();
  } catch {
    return <ServiceUnavailable />;
  }
  if (!identity) redirect("/login");
  if (identity.role !== "manager") redirect("/");
  return (
    <WorkspaceShell identity={identity} section="providers">
      <ManagerProviders />
    </WorkspaceShell>
  );
}
