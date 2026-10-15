export type RateLimitSettings = {
  requests_per_user_per_minute: number;
  concurrency: { ollama: number; cloud: number };
  max_queued_requests_per_provider: 50;
  version: number;
};

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

export function parseRateLimitSettings(value: unknown): RateLimitSettings {
  if (!value || typeof value !== "object") throw new Error("invalid settings");
  const data = value as Record<string, unknown>;
  const concurrency = data.concurrency as Record<string, unknown> | null;
  if (
    !integer(data.requests_per_user_per_minute, 1, 1000) ||
    !concurrency ||
    !integer(concurrency.ollama, 1, 100) ||
    !integer(concurrency.cloud, 1, 100) ||
    data.max_queued_requests_per_provider !== 50 ||
    !integer(data.version, 1, Number.MAX_SAFE_INTEGER)
  )
    throw new Error("invalid settings");
  return data as RateLimitSettings;
}
