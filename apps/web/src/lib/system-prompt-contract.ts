export type SystemPrompt = {
  prompt_id: string;
  name: string;
  prompt_text: string;
  created_by: string | null;
  is_default: boolean;
  is_active: boolean;
  can_edit: boolean;
  revision: number;
};
export type SystemPromptList = { version: number; prompts: SystemPrompt[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSystemPrompts(value: unknown): SystemPromptList {
  if (!value || typeof value !== "object") throw new Error("Invalid system prompts.");
  const data = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(data.version) ||
    (data.version as number) < 1 ||
    !Array.isArray(data.prompts) ||
    data.prompts.length < 1 ||
    data.prompts.length > 1000
  )
    throw new Error("Invalid system prompts.");
  const prompts = data.prompts.map((value): SystemPrompt => {
    if (!value || typeof value !== "object") throw new Error("Invalid system prompt.");
    const item = value as Record<string, unknown>;
    if (
      typeof item.prompt_id !== "string" ||
      !UUID.test(item.prompt_id) ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 100 ||
      typeof item.prompt_text !== "string" ||
      !item.prompt_text.trim() ||
      item.prompt_text.length > 16_000 ||
      !(
        item.created_by === null ||
        (typeof item.created_by === "string" && UUID.test(item.created_by))
      ) ||
      typeof item.is_default !== "boolean" ||
      typeof item.is_active !== "boolean" ||
      typeof item.can_edit !== "boolean" ||
      !Number.isSafeInteger(item.revision) ||
      (item.revision as number) < 1
    )
      throw new Error("Invalid system prompt.");
    return item as SystemPrompt;
  });
  if (
    new Set(prompts.map((prompt) => prompt.prompt_id)).size !== prompts.length ||
    prompts.filter((prompt) => prompt.is_default).length !== 1 ||
    prompts.filter((prompt) => prompt.is_active).length !== 1
  )
    throw new Error("Invalid system prompt state.");
  return { version: data.version as number, prompts };
}
