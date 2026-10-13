export const purposes = ["chat", "rerank", "embedding"] as const;
export type Purpose = (typeof purposes)[number];
export const kinds = ["ollama", "openai", "openai_compatible", "openrouter"] as const;
export type Kind = (typeof kinds)[number];
export type Provider = {
  id: string;
  name: string;
  kind: Kind;
  model: string;
  base_url: string;
  expected_digest: string;
  temperature: number | null;
  priority: number;
  has_api_key: boolean;
  test_status: "passed" | "failed" | null;
  tested_at: string | null;
};
export type ProviderChain = { version: number; enabled: boolean; providers: Provider[] };
export type ProviderListing = Record<Purpose, ProviderChain>;
export const labels: Record<Purpose, string> = {
  chat: "چت",
  rerank: "بازرتبه‌بندی",
  embedding: "Embedding",
};
export const kindLabels: Record<Kind, string> = {
  ollama: "Ollama",
  openai: "OpenAI",
  openai_compatible: "OpenAI-compatible",
  openrouter: "OpenRouter",
};
export function supports(purpose: Purpose, kind: Kind) {
  return (
    purpose === "chat" ||
    (purpose === "rerank" ? ["openrouter", "openai_compatible"].includes(kind) : kind === "ollama")
  );
}
export function parseProviders(value: unknown): ProviderListing {
  if (!value || typeof value !== "object") throw new Error("invalid providers");
  const result = {} as ProviderListing;
  for (const purpose of purposes) {
    const chain = (value as Record<string, unknown>)[purpose] as ProviderChain;
    if (
      !chain ||
      !Number.isSafeInteger(chain.version) ||
      chain.version < 0 ||
      typeof chain.enabled !== "boolean" ||
      !Array.isArray(chain.providers) ||
      chain.providers.length > 100
    )
      throw new Error("invalid chain");
    const ids = new Set<string>();
    result[purpose] = {
      version: chain.version,
      enabled: chain.enabled,
      providers: chain.providers.map((p, index) => {
        const temperature =
          p?.temperature === undefined ? (purpose === "chat" ? 0.7 : null) : p.temperature;
        if (
          !p ||
          typeof p.id !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(p.id) ||
          ids.has(p.id) ||
          typeof p.name !== "string" ||
          !p.name.trim() ||
          [...p.name].length > 100 ||
          !kinds.includes(p.kind) ||
          !supports(purpose, p.kind) ||
          typeof p.model !== "string" ||
          typeof p.base_url !== "string" ||
          typeof p.expected_digest !== "string" ||
          (purpose === "chat"
            ? typeof temperature !== "number" ||
              !Number.isFinite(temperature) ||
              temperature < 0 ||
              temperature > 2
            : temperature !== null) ||
          p.priority !== index ||
          typeof p.has_api_key !== "boolean" ||
          ![null, "passed", "failed"].includes(p.test_status) ||
          (p.tested_at !== null && typeof p.tested_at !== "string")
        )
          throw new Error("invalid provider");
        ids.add(p.id);
        // Explicit response allowlist: even a compromised upstream cannot return a key.
        return {
          id: p.id,
          name: p.name,
          kind: p.kind,
          model: p.model,
          base_url: p.base_url,
          expected_digest: p.expected_digest,
          temperature,
          priority: p.priority,
          has_api_key: p.has_api_key,
          test_status: p.test_status,
          tested_at: p.tested_at,
        };
      }),
    };
  }
  return result;
}
