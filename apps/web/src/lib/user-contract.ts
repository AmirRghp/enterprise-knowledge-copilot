export type ManagedUser = {
  user_id: string;
  login: string;
  role: "employee" | "manager";
  is_active: boolean;
  created_at: string;
  first_name: string | null;
  last_name: string | null;
};
export type UserList = { users: ManagedUser[]; total: number; page: number };
export function parseUser(value: unknown): ManagedUser {
  if (!value || typeof value !== "object") throw new Error("Invalid account.");
  const item = value as Record<string, unknown>;
  const firstName = item.first_name ?? null;
  const lastName = item.last_name ?? null;
  const nameValid = (name: unknown) =>
    name === null || (typeof name === "string" && name.trim().length > 0 && name.length <= 100);
  if (
    !nameValid(firstName) ||
    !nameValid(lastName) ||
    typeof item.user_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.user_id) ||
    typeof item.login !== "string" ||
    !item.login.length ||
    !["manager", "employee"].includes(String(item.role)) ||
    typeof item.is_active !== "boolean" ||
    typeof item.created_at !== "string" ||
    !Number.isFinite(Date.parse(item.created_at))
  )
    throw new Error("Invalid account.");
  return {
    user_id: item.user_id,
    login: item.login,
    role: item.role as ManagedUser["role"],
    is_active: item.is_active,
    created_at: item.created_at,
    first_name: firstName as string | null,
    last_name: lastName as string | null,
  };
}
export function parseUsers(value: unknown): UserList {
  if (!value || typeof value !== "object") throw new Error("Invalid accounts.");
  const data = value as Record<string, unknown>;
  if (
    !Array.isArray(data.users) ||
    data.users.length > 50 ||
    typeof data.total !== "number" ||
    !Number.isSafeInteger(data.total) ||
    data.total < 0 ||
    typeof data.page !== "number" ||
    !Number.isSafeInteger(data.page) ||
    data.page < 1
  )
    throw new Error("Invalid accounts.");
  const users = data.users.map(parseUser);
  if (new Set(users.map((user) => user.user_id)).size !== users.length || users.length > data.total)
    throw new Error("Invalid accounts.");
  return { users, total: data.total, page: data.page };
}
