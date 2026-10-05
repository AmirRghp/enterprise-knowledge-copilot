import "server-only";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// Only public service locations are read; credentials never leave the API process.
export function serverConfig() {
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(resolve(process.cwd(), "../../.env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const api = new URL(process.env.API_BASE_URL ?? file.API_BASE_URL ?? "http://127.0.0.1:8000");
  const web = new URL(process.env.WEB_ORIGIN ?? file.WEB_ORIGIN ?? "http://localhost:3000");
  for (const url of [api, web]) {
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("Service locations must be HTTP(S) origins without credentials or paths.");
    }
  }
  return { apiOrigin: api.origin, webOrigin: web.origin };
}
