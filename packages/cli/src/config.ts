import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  linkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LoginConfig = { baseUrl: string; apiKey: string };

export function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "moor", "config.json");
}

export function loginUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use a server URL without credentials, a path, query, or fragment.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Use HTTPS, or HTTP on localhost through an SSH tunnel.");
  }
  return url.origin;
}

export function readLogin(): LoginConfig | undefined {
  const path = configPath();
  if (!existsSync(path)) return;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("baseUrl" in value) ||
      !("apiKey" in value) ||
      typeof value.baseUrl !== "string" ||
      typeof value.apiKey !== "string" ||
      !value.apiKey
    ) {
      throw new Error("Invalid login");
    }
    return { baseUrl: loginUrl(value.baseUrl), apiKey: value.apiKey };
  } catch {
    throw new Error(`Cannot read saved login at ${path}. Remove it and run moor login again.`);
  }
}

export function saveLogin(config: LoginConfig): void {
  const directory = join(configPath(), "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = mkdtempSync(join(directory, ".login-"));
  try {
    const path = join(temporary, "config.json");
    writeFileSync(path, JSON.stringify(config) + "\n", { mode: 0o600 });
    linkSync(path, configPath());
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function clearLogin(): void {
  rmSync(configPath(), { force: true });
}

export function resolveConfig(): LoginConfig & { saved: boolean } {
  const baseUrl = process.env.MOOR_URL;
  const apiKey = process.env.MOOR_API_KEY;
  // Environment credentials are a pair: never send a saved token to an overridden URL.
  if (baseUrl || apiKey) {
    if (!baseUrl) throw new Error("MOOR_URL is not set");
    if (!apiKey) throw new Error("MOOR_API_KEY is not set");
    return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, saved: false };
  }
  const saved = readLogin();
  if (!saved) throw new Error("Not logged in. Run moor login <server-url>.");
  return { ...saved, saved: true };
}
