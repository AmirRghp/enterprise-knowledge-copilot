export type Organization = Readonly<{ name: string }>;

export function parseOrganization(value: unknown): Organization {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { name?: unknown }).name !== "string" ||
    !(value as { name: string }).name.trim() ||
    (value as { name: string }).name.length > 100
  ) {
    throw new Error("Invalid organization response.");
  }
  return { name: (value as { name: string }).name };
}
