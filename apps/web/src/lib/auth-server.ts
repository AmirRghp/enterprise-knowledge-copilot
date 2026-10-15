import "server-only";
import { cookies } from "next/headers";
import { identityFrom, type Identity } from "./auth-contract";
import { serverConfig } from "./server-config";
import { parseOrganization } from "./organization-contract";

export async function organizationName(): Promise<string> {
  try {
    const response = await fetch(`${serverConfig().apiOrigin}/api/organization`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return "فضای دانش سازمانی";
    return parseOrganization(await response.json()).name;
  } catch {
    return "فضای دانش سازمانی";
  }
}

export async function currentIdentity(): Promise<Identity | null> {
  const token = (await cookies()).get("ekc_session")?.value;
  if (!token) return null;
  const response = await fetch(`${serverConfig().apiOrigin}/api/auth/me`, {
    headers: { Cookie: `ekc_session=${encodeURIComponent(token)}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Identity service unavailable.");
  return identityFrom(await response.json());
}

export async function setupRequired(): Promise<boolean> {
  const response = await fetch(`${serverConfig().apiOrigin}/api/auth/setup`, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Setup service unavailable.");
  const data = await response.json();
  if (typeof data.setup_required !== "boolean") throw new Error("Invalid setup status.");
  return data.setup_required;
}
