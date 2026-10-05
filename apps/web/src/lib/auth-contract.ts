export type Identity = {
  login: string;
  role: "employee" | "manager";
  session_expires_at: string;
};

export function identityFrom(value: unknown): Identity {
  if (!value || typeof value !== "object") throw new Error("Invalid identity.");
  const data = value as Record<string, unknown>;
  if (
    typeof data.login !== "string" ||
    !["employee", "manager"].includes(String(data.role)) ||
    typeof data.session_expires_at !== "string" ||
    !Number.isFinite(Date.parse(data.session_expires_at))
  ) {
    throw new Error("Invalid identity.");
  }
  return {
    login: data.login,
    role: data.role as Identity["role"],
    session_expires_at: data.session_expires_at,
  };
}
